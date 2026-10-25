import { auth } from '@/auth';
import { apiFetch } from './api-client';
import {
  currentSubdomain,
  currentToken,
  forwardableCookie,
} from './server-cart';
import type {
  Address,
  Cart,
  Order,
  OrderListResponse,
  OrderStatus,
} from './cart';
import type { AvailableCoupon, CouponPreview, MyCoupon } from './coupon';

/**
 * 消费者侧的接口封装（地址簿 / 订单），供 Server Component 在**服务端**取数。
 *
 * ## 为什么购物车不在这里读
 *
 * 游客购物车靠 `cart_token` cookie 定位，而浏览器的 cookie 只有服务端能读。
 * 但后端第一次访问时会**种下**这个 cookie——把 `Set-Cookie` 转写回浏览器
 * 必须在 **Route Handler** 里做：Next.js 只允许在 Server Action 或
 * Route Handler 里写 cookie，在 Server Component 的渲染过程中调
 * `cookies().set()` 会抛 `ReadonlyRequestCookiesError`（整页 500，
 * 但 `tsc` 与 `next build` 都过得去——阶段 2b 踩过的那类坑）。
 *
 * 所以购物车走客户端经同源的 `/api/cart` 中转（见 `app/api/cart/route.ts`），
 * 本文件只负责**只读**地取当前购物车（不写 cookie），供结算页显示商品清单。
 */

/**
 * 读当前购物车（游客或登录）。
 *
 * ⚠️ **只读，不写 cookie**：这一段跑在 Server Component 的渲染过程里，
 * 不能写 cookie（见文件头的说明）。后端第一次访问时种下的 `cart_token`
 * 由客户端经 `/api/cart` 中转拿回浏览器。
 *
 * 读失败不当作错误处理：游客还没拿到 cookie 时后端会新建一台空车，
 * 那不是异常。
 */
export async function fetchCurrentCart(): Promise<{
  cart: Cart | null;
  error: string | null;
}> {
  const session = await auth();
  const subdomain = await currentSubdomain();
  const cookie = await forwardableCookie();

  try {
    const cart = await apiFetch<Cart>('/cart', {
      subdomain,
      cookie,
      token: session?.accessToken,
    });
    return { cart, error: null };
  } catch (cause) {
    return {
      cart: null,
      error: cause instanceof Error ? cause.message : '购物车加载失败',
    };
  }
}

/** 地址簿列表（必须登录） */
export async function fetchAddresses(): Promise<{
  addresses: Address[];
  error: string | null;
}> {
  const token = await currentToken();
  if (!token) {
    return { addresses: [], error: null };
  }
  const subdomain = await currentSubdomain();

  try {
    // 后端返回的是 `{ items: [...] }`（为将来分页留位），不是裸数组
    const payload = await apiFetch<{ items: Address[] }>('/addresses', {
      subdomain,
      token,
    });
    return { addresses: payload.items ?? [], error: null };
  } catch (cause) {
    return {
      addresses: [],
      error: cause instanceof Error ? cause.message : '地址簿加载失败',
    };
  }
}

/** 我的订单列表 */
export async function fetchMyOrders(params: {
  status?: OrderStatus;
  page?: number;
  pageSize?: number;
}): Promise<{ data: OrderListResponse | null; error: string | null }> {
  const token = await currentToken();
  if (!token) {
    return { data: null, error: null };
  }
  const subdomain = await currentSubdomain();

  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
  const suffix = query.toString();

  try {
    const data = await apiFetch<OrderListResponse>(
      `/orders${suffix ? `?${suffix}` : ''}`,
      { subdomain, token },
    );
    return { data, error: null };
  } catch (cause) {
    return {
      data: null,
      error: cause instanceof Error ? cause.message : '订单加载失败',
    };
  }
}

/** 订单详情 */
export async function fetchOrder(orderNo: string): Promise<{
  order: Order | null;
  error: string | null;
}> {
  const token = await currentToken();
  if (!token) {
    return { order: null, error: null };
  }
  const subdomain = await currentSubdomain();

  try {
    const order = await apiFetch<Order>(`/orders/${orderNo}`, {
      subdomain,
      token,
    });
    return { order, error: null };
  } catch (cause) {
    return {
      order: null,
      error: cause instanceof Error ? cause.message : '订单加载失败',
    };
  }
}

/**
 * 优惠预览（结算页的四行金额）。
 *
 * ⚠️ **返回的是「估算值」**（护栏 M17）：`originalAmount` 是前端按购物车里
 * SKU 的价格算出来的，下单时服务端会锁住 SKU 按**实时价**重算。
 * 所以页面要提示「金额以提交时为准」，下单响应里的金额才是真的。
 *
 * ⚠️ **为什么要后端算**：券能减多少不是券的面额——面额会被封顶
 * （`min(面额, 活动后金额)`），门槛也是按**活动后金额**判的。
 * 前端自己算就要把优惠引擎的逻辑复制一份，两处必然漂移。
 */
export async function fetchCouponPreview(originalAmount: number): Promise<{
  preview: CouponPreview | null;
  error: string | null;
}> {
  const token = await currentToken();
  if (!token) {
    return { preview: null, error: null };
  }
  const subdomain = await currentSubdomain();

  try {
    const preview = await apiFetch<CouponPreview>(
      `/coupons/preview?originalAmount=${originalAmount}`,
      { subdomain, token },
    );
    return { preview, error: null };
  } catch (cause) {
    return {
      preview: null,
      error: cause instanceof Error ? cause.message : '优惠信息加载失败',
    };
  }
}

/**
 * 当前可领取的券。
 *
 * ⚠️ **必须登录**：后端的领券接口整组挂了 JwtAuthGuard
 * （领取记录记的是 customerId，游客领了也没地方记）。
 */
export async function fetchAvailableCoupons(): Promise<{
  coupons: AvailableCoupon[];
  error: string | null;
}> {
  const token = await currentToken();
  if (!token) {
    return { coupons: [], error: null };
  }
  const subdomain = await currentSubdomain();

  try {
    const payload = await apiFetch<{ items: AvailableCoupon[] }>(
      '/coupons/available',
      { subdomain, token },
    );
    return { coupons: payload.items ?? [], error: null };
  } catch (cause) {
    return {
      coupons: [],
      error: cause instanceof Error ? cause.message : '优惠券加载失败',
    };
  }
}

/** 我持有的券（含每用户状态：这个用户有没有用过、领了几张） */
export async function fetchMyCoupons(): Promise<{
  coupons: MyCoupon[];
  error: string | null;
}> {
  const token = await currentToken();
  if (!token) {
    return { coupons: [], error: null };
  }
  const subdomain = await currentSubdomain();

  try {
    const payload = await apiFetch<{ items: MyCoupon[] }>('/coupons/mine', {
      subdomain,
      token,
    });
    return { coupons: payload.items ?? [], error: null };
  } catch (cause) {
    return {
      coupons: [],
      error: cause instanceof Error ? cause.message : '我的优惠券加载失败',
    };
  }
}
