import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { AuthService } from './auth.service';
import { RegisterMerchantDto } from './dto/register-merchant.dto';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Skip } from '../../common/decorators/skip.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
// 装饰器签名里引用的类型：isolatedModules 下必须用 import type，
// 否则 TS 无法判断它是运行时值还是仅类型，编译报错 TS1272。
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    // TenantResolverService 由 @Global 的 TenancyModule 导出，直接注入即可。
    private readonly tenantResolver: TenantResolverService,
  ) {}

  @Post('register/merchant')
  @Skip()
  @ApiOperation({ summary: '商家注册并开店' })
  registerMerchant(@Body() dto: RegisterMerchantDto) {
    return this.authService.registerMerchant(dto);
  }

  // 注意：register/customer 不能加 @Skip()。
  // 消费者要注册到某个具体店铺名下，必须由租户拦截器按子域名解析出租户上下文；
  // 跳过拦截器的话服务层拿不到 tenantId，注册必然失败。
  // 缺少子域名时由拦截器返回 404（无法确定店铺），这是正确的行为。
  @Post('register/customer')
  @ApiOperation({ summary: '消费者注册（需带店铺子域名）' })
  registerCustomer(@Body() dto: RegisterCustomerDto) {
    return this.authService.registerCustomer(dto);
  }

  // 登录要加 @Skip()：登录发生在中心域名（api.platform.test / merchant.platform.test），
  // 不属于任何具体店铺，拦截器解析不出租户；而且登录本身就要跨租户按邮箱查账号。
  //
  // 但消费者登录需要**知道**当前浏览的是哪家店：邮箱只在租户内唯一，
  // 同一家邮箱在多家店各有一个账号时，不指定店铺就只能按创建时间兜底，
  // 用户会在 A 店的登录页登录进 B 店。因此这里手动解析子域名并传给服务层，
  // 而不走拦截器（拦截器对「解析不出店铺」是直接 404 的）。
  @Post('login')
  @HttpCode(200)
  @Skip()
  @ApiOperation({ summary: '登录' })
  async login(
    @Body() dto: LoginDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    const tenantId = await this.resolveLoginTenantId(headers);
    return this.authService.login(dto, tenantId);
  }

  /**
   * 从请求头/Host 解析出用于限定登录范围的租户 ID。
   *
   * ⚠️ 解析失败一律**静默回退到 null**（不限定租户），绝不抛错：
   * 登录本来就可以发生在中心域名上（那里没有店铺子域名），把「没有子域名」
   * 变成 404 会让中心域名的商家/超管登录全部失败。租户不存在、租户被暂停、
   * 保留子域名同理——它们都只是「无法确定店铺」，而回退到跨租户查找
   * 与改造前的行为完全一致，不会比原来更宽松，也不会更严格。
   */
  private async resolveLoginTenantId(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<string | null> {
    // host 在类型上是 string | string[] | undefined，但 Host 是单值头，
    // Express 不会把重复的 Host 合并成数组。仍然显式收窄：extractSubdomain
    // 的签名是 string | undefined，直接把联合类型传过去过不了编译。
    // 真的拿到数组时按「无法确定」处理——不猜哪一个才是调用方要的。
    const rawHost = headers.host;
    const host = typeof rawHost === 'string' ? rawHost : undefined;

    const subdomain = TenantResolverService.extractSubdomain(headers, host);
    if (!subdomain) {
      return null;
    }

    try {
      const tenant = await this.tenantResolver.resolveBySubdomain(subdomain);
      return tenant.id;
    } catch {
      // 租户不存在/已暂停 → 当作没有子域名处理。
      return null;
    }
  }

  @Post('refresh')
  @HttpCode(200)
  @Skip()
  @ApiOperation({ summary: '刷新令牌' })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // @Skip() 管的是**租户上下文**（不按子域名解析租户），
  // @UseGuards 管的是**身份认证**，两者互不干扰：
  // NestJS 的执行顺序是 Guard 先于 Interceptor，守卫照常生效。
  @Post('logout')
  @HttpCode(204)
  @Skip()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '登出（吊销刷新令牌）' })
  async logout(
    @Body() dto: RefreshDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    // 把身份传给服务层，让它能校验「这枚刷新令牌确实属于调用者」。
    // 不带身份就登出等于盲登出——任何人拿到别人的刷新令牌即可踢掉对方。
    await this.authService.logout(dto.refreshToken, user.userId);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '当前登录用户' })
  me(@CurrentUser() user: CurrentUserPayload) {
    return user;
  }
}
