import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RefreshTokenRevokedReason, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { generateRefreshToken, hashRefreshToken } from './token.util';
import { RegisterMerchantDto } from './dto/register-merchant.dto';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { LoginDto, LoginScope } from './dto/login.dto';

/**
 * 用于在「用户不存在」时也执行一次 argon2 校验，消除登录接口的时序侧信道。
 * 这是一个真实生成、对应不存在用户的哈希，校验必然失败（返回 false 而不是抛错）。
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$nhTWJtnyf6anYc5fYVe+cA$THfn2TdwEuE0Cf7YbS5BuRKbOc8xcngESPOaTyW/g7M';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  tenantId: string | null;
}

export interface AuthResult {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** 商家注册：一次创建租户 + 店主用户 + 首个店铺 */
  async registerMerchant(dto: RegisterMerchantDto): Promise<AuthResult> {
    const passwordHash = await argon2.hash(dto.password);
    const subdomain = dto.subdomain.toLowerCase();
    const email = dto.email.toLowerCase();

    const existingTenant = await this.prisma.tenant.findFirst({
      where: { subdomain },
    });
    if (existingTenant) {
      throw new ConflictException(`子域名 ${dto.subdomain} 已被占用`);
    }

    // 店主邮箱必须全局唯一。数据库上有 users_merchant_owner_email_key 兜底，
    // 这里先查一次是为了给出可读的错误文案，而不是把底层唯一约束冲突
    // 冒泡成 500。查询走平台作用域——候选店主可能在任意租户下。
    const existingOwner = await tenantContext.run(platformScope(), async () =>
      this.prisma.user.findFirst({
        where: { role: UserRole.MERCHANT_OWNER, email },
      }),
    );
    if (existingOwner) {
      throw new ConflictException('该邮箱已注册商家账号');
    }

    const tenant = await this.prisma.tenant.create({
      data: { name: dto.merchantName, subdomain },
    });

    try {
      // 用户与店铺都属于租户作用域模型，必须在租户上下文内创建，
      // 这样 Prisma extension 才会自动注入 tenantId。
      //
      // ⚠️ run() 的回调必须是 async 函数：Prisma 6 的 PrismaPromise 是 thenable，
      // 同步回调会让 AsyncLocalStorage 的上下文在查询执行时丢失。
      const user = await tenantContext.run(
        {
          tenantId: tenant.id,
          userId: null,
          role: UserRole.MERCHANT_OWNER,
        },
        async () =>
          this.prisma.user.create({
            data: {
              email,
              passwordHash,
              displayName: dto.merchantName,
              role: UserRole.MERCHANT_OWNER,
            },
          }),
      );

      await tenantContext.run(
        {
          tenantId: tenant.id,
          userId: null,
          role: UserRole.MERCHANT_OWNER,
        },
        async () =>
          this.prisma.store.create({
            // tenantId 由租户扩展在运行时注入，调用方不需要也不应该显式传。
            // StoreCreateInput 是「带关系字段」的形态，静态类型上要求 tenant，
            // 这里通过 unknown 转型对齐 tenant-prisma.service.spec.ts 的既有约定。
            data: {
              name: dto.storeName,
              slug: this.slugify(dto.storeName) || subdomain,
            } as unknown as Prisma.StoreCreateInput,
          }),
      );

      return this.issueTokens(user);
    } catch (error) {
      // 创建用户或店铺失败时回滚租户，避免留下半成品租户。
      // Tenant 不是租户作用域模型，任意上下文下都可 delete。
      await this.prisma.tenant.deleteMany({ where: { id: tenant.id } });
      throw error;
    }
  }

  /** 消费者注册：注册到当前子域名对应的租户 */
  async registerCustomer(dto: RegisterCustomerDto): Promise<AuthResult> {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new UnauthorizedException('无法确定店铺，缺少子域名');
    }

    const passwordHash = await argon2.hash(dto.password);
    const email = dto.email.toLowerCase();

    // 查重只针对**消费者**身份。店主邮箱的约束是全局唯一的（见
    // registerMerchant 与 users_merchant_owner_email_key），且与这里无关：
    // 店主在自己开的店里本来就可以当消费者下单——邮箱属于「这个人」，
    // 但「以顾客身份下单」是另一个角色、另一个账号，不构成身份冲突。
    // 若这里不按角色收窄，店主就永远无法在自己店里购物。
    //
    // ⚠️ 这条按角色的检查必须与数据库约束保持一致：users_email_ci_key
    // 原本是 (LOWER(email), tenantId) 唯一且**不含角色**，同租户内
    // 店主与消费者同邮箱会在建表约束上直接冲突。迁移
    // add_customer_email_ci_unique 已把它收窄到 role = 'CUSTOMER'。
    const existing = await this.prisma.user.findFirst({
      where: { email, role: UserRole.CUSTOMER },
    });
    if (existing) {
      throw new ConflictException('该邮箱已注册');
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: dto.displayName,
        role: UserRole.CUSTOMER,
        tenantId: context.tenantId,
      },
    });

    return this.issueTokens(user);
  }

  /**
   * 登录。
   *
   * @param tenantId 店铺租户 ID。**仅对消费者登录有意义**：调用方（控制器）从
   *   请求头/Host 解析出店铺子域名后传进来；解析不出来时传 null（不限定租户）。
   *   消费者邮箱只在租户内唯一，同一家邮箱可以在多家店各有一个账号；不限定租户时
   *   只能按创建时间兜底，用户会「在 A 店看到登录页、却登录进了 B 店」。
   *   指定租户后，候选被收窄到正在浏览的这家店。
   *
   *   商家与平台超管的账号归属不靠子域名确定（店主的租户由邮箱唯一约束决定，
   *   超管则没有租户），因此传了 tenantId 也只对 CUSTOMER 生效。
   */
  async login(dto: LoginDto, tenantId?: string | null): Promise<AuthResult> {
    const email = dto.email.toLowerCase();

    const roleFilter = this.roleFilterFor(dto.scope);

    const where: Prisma.UserWhereInput = {
      email,
      ...roleFilter,
      // 消费者登录限定在当前店铺内：同一邮箱在多家店有账号时，
      // 应当登录到正在浏览的这家店，而不是落到最早创建的那一家。
      ...(dto.scope === LoginScope.CUSTOMER && tenantId ? { tenantId } : {}),
    };

    // 登录需要跨租户查找账号（用户输入邮箱时尚未确定属于哪个租户），
    // 因此显式使用平台作用域。密码校验通过后签发的 JWT 自带 tenantId，
    // 后续请求仍然按租户隔离。
    //
    // orderBy 必须给：限定租户失效时（商家登录、或消费者登录未带子域名）
    // 同一邮箱仍可能在多个租户下有账号，候选多于一个时若交给数据库自行决定
    // 顺序，同一个登录请求可能落到不同租户上——用户会「刚在 A 店登录，
    // 下次登录却进了 B 店」。按创建时间升序让落点确定：最早创建的那个。
    const candidates = await tenantContext.run(platformScope(), async () =>
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'asc' },
      }),
    );

    if (candidates.length === 0) {
      // 即使用户不存在也走一次 argon2 校验，让「用户不存在」与「密码错误」
      // 的响应时间接近，避免通过时间差枚举已注册邮箱。
      await argon2.verify(DUMMY_PASSWORD_HASH, dto.password);
      throw new UnauthorizedException('邮箱或密码不正确');
    }

    for (const candidate of candidates) {
      const ok = await argon2.verify(candidate.passwordHash, dto.password);
      if (ok) {
        // 商家与消费者必须属于某个有效租户；平台超管是唯一 tenantId 为空的角色。
        // 少了这一判断，孤儿账号（租户被删但用户残留）也能签出 tenantId=null
        // 的令牌，其语义等同于平台作用域。
        if (candidate.role !== UserRole.PLATFORM_ADMIN && !candidate.tenantId) {
          continue;
        }
        return this.issueTokens(candidate);
      }
    }

    // 邮箱存在与不存在、以及密码错误，都返回同一句提示，
    // 避免攻击者据此枚举出已注册的邮箱。
    throw new UnauthorizedException('邮箱或密码不正确');
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    // 本次请求的处理起点。重放判定要拿它和「轮换发生的时间」比较，
    // 这是区分「并发竞态」与「真正的重放」的唯一可靠依据。
    const requestStartedAt = new Date();

    const tokenHash = hashRefreshToken(refreshToken);

    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    if (stored.revokedAt) {
      // 这枚令牌已经被吊销过，又被再次使用。分三种情况：
      if (this.isConcurrentRace(stored.revokedAt, requestStartedAt)) {
        // ① 并发竞态：轮换发生在本次请求开始之后。客户端双击刷新、
        //    SDK 自动重试会让同一枚令牌被并发提交两次，那不是泄露。
        //    只拒绝本请求，不牵连该用户的其它设备。
        throw new UnauthorizedException('刷新令牌已被使用过，请重新登录');
      }

      if (stored.revokedReason === RefreshTokenRevokedReason.LOGOUT) {
        // ② 登出后误用：用户只是误用了自己刚登出的旧令牌。把它当成泄露
        //    处理会把手机、电脑等其它设备的登录一起踢掉。多设备并存是
        //    商家后台的常态，不能为一次误用牺牲全部会话。
        throw new UnauthorizedException('刷新令牌无效或已过期');
      }

      // ③ 真正的重放：轮换发生在本次请求开始之前，这枚令牌在抵达前
      //    就已经离开了合法用户，说明它在别处还有第二个持有者。按 OAuth 2.0
      //    安全最佳实践（RFC 9700 / BCP）作废整个令牌族——攻击者与真实用户
      //    同时失效，重新登录即可恢复。
      await this.revokeTokenFamily(stored.userId, stored.id);
      throw new UnauthorizedException(
        '刷新令牌已被使用过，出于安全考虑已吊销全部登录状态',
      );
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // 轮换：旧令牌立即吊销。刷新令牌是长期凭证且会在响应里明文回传客户端，
    // 不轮换的话，一枚泄漏的刷新令牌可以一直换取新令牌，泄露窗口无上限。
    //
    // ⚠️ 必须是**条件**更新（where 里带 revokedAt: null），不能是「先查后写」。
    // 同一枚令牌并发提交两次时，两个请求都会读到 revokedAt === null；
    // 条件更新让并发下只有一个请求的 count 为 1，另一个拿到 count === 0。
    const rotated = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: RefreshTokenRevokedReason.ROTATED,
      },
    });

    if (rotated.count === 0) {
      // 条件更新没命中：这枚令牌在我们读它之后、轮换它之前，被另一个请求
      // 轮换掉了。重新读一次拿**准确的**轮换时间——刚才那份 stored 是
      // 并发窗口开始前的快照，看不准。
      const current = await this.prisma.refreshToken.findFirst({
        where: { id: stored.id },
        select: { revokedAt: true },
      });

      if (this.isConcurrentRace(current?.revokedAt, requestStartedAt)) {
        // 并发竞态：只拒绝本请求。客户端重试时用 winner 刚签发的那枚即可，
        // 不影响任何其它会话。
        throw new UnauthorizedException('刷新令牌已被使用过，请重新登录');
      }

      // 轮换发生在本次请求开始之前 → 真正的重放，作废整个令牌族。
      await this.revokeTokenFamily(stored.userId, stored.id);
      throw new UnauthorizedException(
        '刷新令牌已被使用过，出于安全考虑已吊销全部登录状态',
      );
    }

    return this.issueTokens(stored.user);
  }

  /**
   * 判断一枚「已被轮换」的令牌再次出现时，属于并发竞态还是真正的重放。
   *
   * 判别依据是**轮换发生的时间**与**本次请求起始时间**的先后：
   * - 轮换发生在本次请求开始之后 → 并发竞态。客户端双击刷新、SDK 重试
   *   会让同一枚令牌被并发提交两次，毫秒级的窗口不是令牌泄漏。
   * - 轮换发生在本次请求开始之前 → 真正的重放。这枚令牌在本次请求抵达前
   *   就已经离开了合法用户，说明它在别处还有第二个持有者。
   *
   * 两个时间戳都来自应用进程的时钟（`revokedAt` 由应用写入），同一台机器
   * 上时钟一致，可以直接比较。
   */
  private isConcurrentRace(
    revokedAt: Date | null | undefined,
    requestStartedAt: Date,
  ): boolean {
    if (!revokedAt) return false;
    return revokedAt.getTime() >= requestStartedAt.getTime();
  }

  async logout(refreshToken: string, userId: string): Promise<void> {
    const tokenHash = hashRefreshToken(refreshToken);

    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash },
      select: { id: true, userId: true },
    });

    // 令牌不存在时静默成功：登出接口不该成为「这枚令牌存在吗」的预言机。
    //
    // 令牌存在但不属于当前用户则必须拒绝。少了这一步，任何人只要拿到
    // 别人的刷新令牌（哪怕是日志、截图里泄漏的），就能盲登出对方的会话，
    // 而登出端点本身不需要携带任何凭证即可调用。
    if (stored && stored.userId !== userId) {
      throw new UnauthorizedException('刷新令牌不属于当前用户');
    }

    // 登出只吊销这一枚，不牵连该用户的其它设备。
    await this.prisma.refreshToken.updateMany({
      where: { id: stored?.id, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: RefreshTokenRevokedReason.LOGOUT,
      },
    });
  }

  /**
   * 作废某个用户的整个刷新令牌族。
   *
   * 触发者是「已被轮换过又被再次使用」的令牌：它说明这枚令牌在合法用户之外
   * 还有第二个持有者，按 OAuth 2.0 安全最佳实践（RFC 9700 / BCP）应当
   * 把整个令牌族作废——攻击者与真实用户同时失效，重新登录即可恢复。
   *
   * ⚠️ 只在**真正的重放**路径调用（即 refresh 里读到 revokedAt 已非空、
   * 且原因是 ROTATED 的那次请求）。并发刷新里的 loser 不走这里：
   * 毫秒级竞态不是泄露，动辄吊销全族会把用户自己的其它设备一起踢下线。
   *
   * 两次写入必须原子：中途失败会留下「整族已作废、但触发者仍标 ROTATED」
   * 的记录，下次重放同一枚令牌会再次触发全族吊销。
   */
  private async revokeTokenFamily(
    userId: string,
    triggerTokenId: string,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedReason: RefreshTokenRevokedReason.REPLAY,
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: { id: triggerTokenId },
        data: {
          revokedAt: now,
          revokedReason: RefreshTokenRevokedReason.REPLAY,
        },
      }),
    ]);
  }

  private roleFilterFor(scope: LoginScope): Prisma.UserWhereInput {
    switch (scope) {
      case LoginScope.MERCHANT:
        return {
          role: { in: [UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF] },
        };
      case LoginScope.CUSTOMER:
        return { role: UserRole.CUSTOMER };
      case LoginScope.PLATFORM:
        return { role: UserRole.PLATFORM_ADMIN };
    }
  }

  /**
   * 店铺 slug：优先取店铺名的拼音/英文形式，取不到则退回子域名。
   *
   * 纯 ASCII 的店铺名会得到非空 slug；中文名经过非字母数字过滤后必然为空，
   * 此时必须有一个确定性的兜底值，否则 slug 为空字符串会撞上唯一约束。
   */
  private slugify(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private async issueTokens(user: {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
    tenantId: string | null;
  }): Promise<AuthResult> {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });

    const refreshToken = generateRefreshToken();
    const expiresAt = new Date();
    expiresAt.setDate(
      expiresAt.getDate() + Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    );

    // RefreshToken 不是租户作用域模型，这里不需要（也不应该）切换上下文
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt,
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        tenantId: user.tenantId,
      },
      accessToken,
      refreshToken,
    };
  }
}
