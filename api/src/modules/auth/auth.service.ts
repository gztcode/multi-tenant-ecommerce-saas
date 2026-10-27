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
import {
  decryptToken,
  deriveGraceKey,
  encryptToken,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_GRACE_PERIOD_MS,
} from './token.util';
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
  /**
   * 宽限记录用的加密密钥。
   *
   * ⚠️ **在构造时派生一次**：HKDF 不贵，但每次刷新都派生一遍是白跑的。
   * 它只存在于进程内存，不落盘、不进日志。
   */
  private readonly graceKey: Buffer;

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly jwt: JwtService,
  ) {
    this.graceKey = deriveGraceKey(
      process.env.JWT_SECRET ??
        'change-me-in-production-at-least-32-chars-long',
    );
  }

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
    const tokenHash = hashRefreshToken(refreshToken);

    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // 这枚令牌已经被吊销过，又被再次使用。
    if (stored.revokedAt) {
      return this.handleRevokedToken(stored);
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // ⚠️ **轮换：旧令牌立即作废，并同时记下宽限记录。**
    //
    // 刷新令牌是长期凭证且会在响应里明文回传客户端，不轮换的话，
    // 一枚泄漏的刷新令牌可以一直换取新令牌，泄露窗口无上限。
    //
    // ⚠️ **「标旧行」与「建新行」必须在同一个事务里** ——
    // 分成两步的话，中间失败会留下一枚「已作废但没有宽限记录」的旧令牌：
    // 客户端在窗口内重试它 → 判真重放 → 吊销全族。
    //
    // ⚠️ **「标旧行」的那一次 updateMany 必须是条件更新**
    //（where 带 revokedAt: null），不能是「先查后写」。
    // 同一枚令牌并发提交两次时，两个请求都会读到 revokedAt === null；
    // 条件更新让并发下只有一个请求的 count 为 1。
    const { refreshToken: newRefreshToken, expiresAt } =
      this.createRefreshToken();

    const rotated = await this.prisma.$transaction(async (tx) => {
      // ⚠️ **同一次轮换只取一次时钟**。
      // 原来 `revokedAt` 与 `graceExpiresAt` 各自调了一次 `new Date()`，
      // 两次读之间跨过毫秒边界就会让「宽限期 = 60001ms」——
      // e2e 断言的是**精确相等**，实测失败率约 10%。
      const rotateNow = new Date();
      const count = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: {
          revokedAt: rotateNow,
          revokedReason: RefreshTokenRevokedReason.ROTATED,
          // ⚠️ **宽限记录**：新令牌的**密文**。
          // 存密文而不是明文 —— 这张表经常被备份与只读分析。
          rotatedToToken: encryptToken(newRefreshToken, this.graceKey),
          // ⚠️ **一次定死，不因重放而延长**。
          graceExpiresAt: new Date(
            rotateNow.getTime() + REFRESH_GRACE_PERIOD_MS,
          ),
        },
      });

      // count === 0 → 另一个请求抢先轮换了这一枚。
      // 此时**不能**建新行（会多出一枚没人持有的令牌）。
      if (count.count === 0) return false;

      await tx.refreshToken.create({
        data: {
          userId: stored.user.id,
          tokenHash: hashRefreshToken(newRefreshToken),
          expiresAt,
        },
      });
      return true;
    });

    if (!rotated) {
      // 条件更新没命中：这枚令牌在我们读它之后、轮换它之前，
      // 被另一个请求轮换掉了。重新读一次拿**准确的**状态。
      const current = await this.prisma.refreshToken.findFirst({
        where: { id: stored.id },
        include: { user: true },
      });
      if (!current) {
        throw new UnauthorizedException('刷新令牌无效或已过期');
      }
      return this.handleRevokedToken(current);
    }

    return {
      user: this.toAuthUser(stored.user),
      // ⚠️ **在这里签，而不是在事务之前**：
      // 并发下的 loser 分支（`rotated === false`）会白签一枚，
      // 功能无害但读起来像「先签好待用」。
      accessToken: await this.signAccessToken(stored.user),
      refreshToken: newRefreshToken,
    };
  }

  /**
   * 处理一枚**已经被吊销过**的刷新令牌。
   *
   * 分四档（阶段 5c 之后）：
   * ① 登出后误用 → 401，不牵连其它设备
   * ② **宽限期内** → 返回**同一枚**新令牌，不吊销令牌族
   * ③ 宽限期内、但**目标令牌已被明确吊销** → 401，**不吊销令牌族**
   * ④ 其余（超期 / 密文解不开 / 已被判成重放）→ 吊销整个令牌族 → 401
   *
   * ⚠️ **② 与 ④ 之间不再区分「并发」与「先后」**（设计文档 §5.3 的实测结论）：
   * 那个区分依赖「轮换时刻 vs 请求起始时刻」的毫秒级比较，
   * 而两个请求是否重叠**取决于环境**——在别的机器上两个请求可能真串行抵达，
   * 于是同一条用例时而走 ② 时而走 ④，测试会变成 flaky。
   * 统一处理后判定不依赖任何时序。
   */
  private async handleRevokedToken(
    stored: Prisma.RefreshTokenGetPayload<{ include: { user: true } }>,
  ): Promise<AuthResult> {
    // ① 登出后误用：用户只是误用了自己刚登出的旧令牌。
    // 把它当成泄露处理会把手机、电脑等其它设备的登录一起踢掉。
    if (stored.revokedReason === RefreshTokenRevokedReason.LOGOUT) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // ② 宽限期：同一枚令牌在 60 秒内被重复提交
    // （客户端超时重试、两个标签页串行抵达、跨副本各刷一次），
    // 返回**第一次那枚**新令牌，不吊销令牌族。
    //
    // ⚠️ **解密失败一律按「宽限期不可用」处理** → 落到 ④。
    // 绝不把 null 当成令牌返回给客户端。
    if (
      stored.revokedReason === RefreshTokenRevokedReason.ROTATED &&
      stored.graceExpiresAt &&
      new Date() < stored.graceExpiresAt
    ) {
      const restored =
        stored.rotatedToToken === null
          ? null
          : decryptToken(stored.rotatedToToken, this.graceKey);

      if (restored) {
        // ⚠️ **那枚新令牌自己还活着吗？**（阶段 5c 审查补上）
        //
        // 宽限记录存的是「我轮换出了哪枚新令牌」，但**那枚新令牌可能已经被吊销了**：
        // - 用户用它登出（LOGOUT）→ 不检查的话，**登出会被撤销**：
        //   重放前身令牌能换回一枚有效的 accessToken
        // - 它自己被判成真重放（REPLAY）→ 同理
        //
        // ⚠️ **这一步与后面的返回之间存在毫秒级竞态，但不构成漏洞**：
        // 「查状态」与「据此返回」之间，目标令牌有可能刚好在那一刻被吊销。
        // 这不构成漏洞 —— accessToken 是**无状态 JWT**（不查库也有效），
        // 而本路径返回的 refreshToken **就是 `restored` 本身**，
        // 它没有因为这次检查而发生任何变化。真正需要「目标令牌必须活着」
        // 保证的是**刷新令牌链**（用它去换新令牌时会被再查一次状态），
        // 那条链由 `refresh()` 的入口检查兜底。
        // ⚠️ **不要把它当成 bug 去「修」**（例如加重试或加锁）——
        // 那只会把一个不存在的漏洞变成真的复杂度和新的竞态。
        const target = await this.prisma.refreshToken.findFirst({
          // ⚠️ **显式带上 userId**：这一行是全局无过滤查询
          // （`RefreshToken` 不在 `TENANT_SCOPED_MODELS` 里）。
          // 当前安全（密文只由服务端写、`tokenHash` 全局唯一），
          // 但完全依赖隐式不变量 —— 加一道显式约束当防御纵深。
          where: {
            tokenHash: hashRefreshToken(restored),
            userId: stored.userId,
          },
          select: { revokedReason: true },
        });

        // ⚠️ **ROTATED 的目标要放行** —— 链式自愈（设计文档 §4.5）依赖它：
        // 重放 T0 拿回 T1，而 T1 此时已经是 ROTATED。
        // 若把它也拒绝，链就断了（G8 那条用例会挂）。
        const alive =
          target !== null &&
          (target.revokedReason === null ||
            target.revokedReason === RefreshTokenRevokedReason.ROTATED);

        if (alive) {
          return {
            user: this.toAuthUser(stored.user),
            // ⚠️ **accessToken 重新签发，refreshToken 是同一枚**。
            // accessToken 是无状态 JWT，重签无害且顺延会话；
            // refreshToken 必须同一枚才谈得上「幂等」。
            accessToken: await this.signAccessToken(stored.user),
            refreshToken: restored,
          };
        }

        // ③ 那枚新令牌已被明确吊销 → 只拒本请求，**不吊销全族**。
        // 「终止这条链」的意图已经表达过了；再吊销全族只会
        // **牵连其它设备**（登出场景）或**毫无意义**（已被判重放场景）。
        // 这与「登出后重用令牌 → 401，不牵连其它设备」是同一条原则。
        throw new UnauthorizedException('刷新令牌无效或已过期');
      }
    }

    // ④ 这枚令牌在抵达前就已经离开了合法用户，说明它在别处还有第二个持有者。
    // 按 OAuth 2.0 安全最佳实践（RFC 9700 / BCP）作废整个令牌族 ——
    // 攻击者与真实用户同时失效，重新登录即可恢复。
    await this.revokeTokenFamily(stored.userId, stored.id);
    throw new UnauthorizedException(
      '刷新令牌已被使用过，出于安全考虑已吊销全部登录状态',
    );
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
   * 触发者是「判定为真重放」的路径（`handleRevokedToken` 的第 ④ 档）：
   * 宽限期已过、宽限密文解不开、或这枚令牌本身已被判成重放。
   *
   * ⚠️ **并发刷新里的 loser 不走这里**：它落进宽限期的第 ② 档
   * （返回同一枚新令牌），毫秒级竞态不是泄露，动辄吊销全族会把
   * 用户自己的其它设备一起踢下线。
   *
   * ⚠️ **where 必须覆盖 ROTATED 的行**（见下面的 OR）：那些行带着可兑换的
   * 宽限密文，够不到它们就等于「吊销全族」名不副实。
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
        where: {
          userId,
          // ⚠️ 不能只写 { revokedAt: null }：那只会覆盖**还没被吊销**的行。
          // 已经 ROTATED 的行带着**完整的宽限密文**活下来，
          // 重放它照样能在宽限期内换回令牌 ——「吊销全族」名不副实。
          //
          // ⚠️ **LOGOUT 不纳入**：登出的令牌不该被重放路径改写成 REPLAY，
          // 那会掩盖「用户主动登出」这个事实。
          //
          // ⚠️ 这个修改**不会牵连其它设备**：它只在「真重放被判定」时生效，
          // 而那时整个令牌族本来就要死。
          OR: [
            { revokedAt: null },
            { revokedReason: RefreshTokenRevokedReason.ROTATED },
          ],
        },
        data: {
          revokedAt: now,
          revokedReason: RefreshTokenRevokedReason.REPLAY,
          // ⚠️ 全族吊销后，这些宽限密文不该再能被返回。
          rotatedToToken: null,
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: { id: triggerTokenId },
        data: {
          revokedAt: now,
          revokedReason: RefreshTokenRevokedReason.REPLAY,
          rotatedToToken: null,
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

  /** 只签访问令牌（JWT 自包含，不需要落库） */
  private async signAccessToken(user: AuthUser): Promise<string> {
    return this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });
  }

  /** 生成一枚刷新令牌与它的过期时刻（**不落库**，由调用方决定写到哪） */
  private createRefreshToken(): { refreshToken: string; expiresAt: Date } {
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date();
    expiresAt.setDate(
      expiresAt.getDate() + Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    );
    return { refreshToken, expiresAt };
  }

  private async issueTokens(user: AuthUser): Promise<AuthResult> {
    const accessToken = await this.signAccessToken(user);
    const { refreshToken, expiresAt } = this.createRefreshToken();

    // RefreshToken 不是租户作用域模型，这里不需要（也不应该）切换上下文
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt,
      },
    });

    return {
      user: this.toAuthUser(user),
      accessToken,
      refreshToken,
    };
  }

  /** 把用户记录映射成对外的用户对象（三处返回都用它，避免漏改字段） */
  private toAuthUser(user: AuthUser): AuthUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      tenantId: user.tenantId,
    };
  }
}
