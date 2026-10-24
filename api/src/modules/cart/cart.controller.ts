import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { CartService, CART_COOKIE } from './cart.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

/**
 * 消费者侧的购物车接口。
 *
 * 挂 OptionalJwtAuthGuard 而不是 JwtAuthGuard：
 * 购物车要同时支持**游客**与**登录消费者**（设计 §4.1）。
 * @Public() 不能代替——它会让登录用户也变成匿名，拿不到 customerId。
 *
 * ⚠️ **跨店会员不支持**（设计 §十三 遗留项 1）：
 * 消费者在店铺 A 注册后，他在店铺 B 带 token 的请求拿到的仍是 A 的租户上下文
 * （租户上下文「JWT 优先，匿名才看子域名」），于是 B 店的购物车访问不到。
 * 这是本阶段明确的能力边界，不是漏了判断。
 */
@ApiTags('cart')
@Controller('cart')
@UseGuards(OptionalJwtAuthGuard)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @ApiOperation({ summary: '当前购物车（游客或登录）' })
  async current(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cart = await this.resolveCart(request, response);
    return this.cartService.read(cart);
  }

  @Post('items')
  @ApiOperation({ summary: '加购' })
  async addItem(
    @Body() dto: AddCartItemDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cart = await this.resolveCart(request, response);
    await this.cartService.addItem(cart, dto.skuId, dto.quantity);
    // 返回整台购物车（含条目）而不是单条条目：
    // 前端加购后要重渲染购物车角标与列表，多一次请求没必要。
    return this.cartService.read(cart);
  }

  @Patch('items/:id')
  @ApiOperation({ summary: '改购物车条目数量' })
  async updateItem(
    @Param('id') id: string,
    @Body() dto: UpdateCartItemDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cart = await this.resolveCart(request, response);
    await this.cartService.updateItemQuantity(cart, id, dto.quantity);
    return this.cartService.read(cart);
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除购物车条目' })
  async removeItem(
    @Param('id') id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cart = await this.resolveCart(request, response);
    await this.cartService.removeItem(cart, id);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '清空购物车' })
  async clear(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cart = await this.resolveCart(request, response);
    await this.cartService.clear(cart);
  }

  /**
   * 合并游客购物车到账号购物车。
   *
   * 必须登录——没有 customerId 就没有账号车可合并。
   * 游客车不存在时返回成功（幂等，护栏 3）。
   */
  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登录后把游客购物车合并进账号购物车' })
  async merge(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const customerId = this.currentCustomerId(request);
    if (!customerId) {
      // 没有 customerId 就没有账号车可合并。游客调用合并接口没有意义。
      throw new UnauthorizedException('合并购物车需要先登录');
    }
    const tenantId = this.currentTenantId();
    const guestToken = this.readGuestToken(request);

    const cart = await this.cartService.merge(tenantId, customerId, guestToken);

    // 合并完游客车就没了，把 cookie 清掉
    response.clearCookie(CART_COOKIE, { path: '/' });

    return this.cartService.read(cart);
  }

  /**
   * 定位当前请求的购物车。
   *
   * 登录用户 → 按 (租户, customerId)；
   * 游客 → 按 (租户, cookie 里的 guestToken)，没有就新建并写 cookie。
   */
  private async resolveCart(request: Request, response: Response) {
    const tenantId = this.currentTenantId();
    const customerId = this.currentCustomerId(request);
    const guestToken = this.readGuestToken(request);

    if (customerId) {
      return this.cartService.currentCart(tenantId, customerId, null);
    }

    if (guestToken) {
      return this.cartService.currentCart(tenantId, null, guestToken);
    }

    // 第一次访问：生成游客 token，建车并写 cookie
    const token = this.cartService.newGuestToken();
    const cart = await this.cartService.currentCart(tenantId, null, token);
    // ⚠️ 本项目用的是 Express 适配器，写 cookie 用 res.cookie()；
    // res.cookies.set() 是 Fastify 适配器的写法，这里不存在。
    response.cookie(CART_COOKIE, token, this.cartService.cookieOptions());
    return cart;
  }

  /** 当前租户（由租户上下文拦截器按 JWT 或子域名解析） */
  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new UnauthorizedException('无法确定店铺');
    }
    return context.tenantId;
  }

  /** 当前登录消费者 id；游客为 null */
  private currentCustomerId(request: Request): string | null {
    const user = (request as Request & { user?: { userId: string } }).user;
    return user?.userId ?? null;
  }

  /** 读 cookie 里的游客 token */
  private readGuestToken(request: Request): string | null {
    // cookie-parser 的类型增强给 Request.cookies 的是 Record<string, any>，
    // 直接取成员会触发 no-unsafe-* 报错。这里先收窄成 unknown 再断言。
    const raw = (request as { cookies?: unknown }).cookies;
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const token = (raw as Record<string, unknown>)[CART_COOKIE];
    return typeof token === 'string' && token.length > 0 ? token : null;
  }
}
