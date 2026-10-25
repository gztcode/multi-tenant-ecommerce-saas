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
