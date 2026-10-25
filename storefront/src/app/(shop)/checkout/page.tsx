import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { CheckoutForm } from '@/components/checkout/checkout-form';
import { totalAmount } from '@/lib/cart';
import {
  fetchAddresses,
  fetchCouponPreview,
  fetchCurrentCart,
} from '@/lib/shop-api';

/**
 * 结算页（Server Component）。
 *
 * ## 幂等键在**客户端组件**里生成
 *
 * 幂等键必须在「进入结算页时」生成并持有到提交为止（见
 * `components/checkout/checkout-form.tsx` 的说明）。它放在客户端组件里，
 * 而不是服务端组件里生成后往下传——因为服务端组件每次渲染都是新的，
 * 用户提交失败后页面重新渲染就会得到新的键，幂等就失效了。
 *
 * ⚠️ 这里**不**把服务端生成的键传给客户端：Server → Client 传数据没问题，
 * 但那个数据在每次服务端渲染时都会变（服务端组件不持有状态），
 * 正是要避免的形态。
 */
export const dynamic = 'force-dynamic';

export default async function CheckoutPage() {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }

  const [{ cart }, { addresses }] = await Promise.all([
    fetchCurrentCart(),
    fetchAddresses(),
  ]);

  // 购物车是空的没什么可结算的——回到购物车页而不是给一个空表单。
  if (!cart || (cart.items ?? []).length === 0) {
    redirect('/cart');
  }

  // ⚠️ **优惠预览必须在拿到购物车之后才请求**——它要按购物车的金额算。
  // 预览失败不当作错误处理：没有优惠也能下单，只是页面不显示优惠行。
  const { preview } = await fetchCouponPreview(totalAmount(cart.items ?? []));

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">结算</h1>

      <CheckoutForm
        cart={cart}
        addresses={addresses}
        loggedIn={Boolean(session)}
        preview={preview}
      />
    </main>
  );
}
