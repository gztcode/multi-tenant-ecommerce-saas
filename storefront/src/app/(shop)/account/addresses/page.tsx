import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { fetchAddresses } from '@/lib/shop-api';
import { AddressBook } from '@/components/address/address-book';

/**
 * 消费者侧的地址簿页。
 *
 * ## ⚠️ 路由必须在 `(shop)` 路由组下
 *
 * 放在顶层 `app/addresses/` 会**绕过 `ShopLayout` 的主题注入**
 * （`app/(shop)/layout.tsx` 里的 `<style>`）——那个布局是店铺主题
 * 生效的唯一来源。护栏 9。
 */
export const dynamic = 'force-dynamic';

export default async function AddressesPage() {
  const session = await auth();
  if (!session?.accessToken) {
    redirect('/login');
  }

  const { addresses, error } = await fetchAddresses();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-8">
      {/* ⚠️ 必须有「返回」路径：storefront 没有全局 header，
          用户从首页导航进本页后没有任何出口（只能改地址或点浏览器后退）。 */}
      <Link href="/account" className="self-start text-sm underline">
        返回我的账户
      </Link>
      <h1 className="text-2xl font-bold">收货地址</h1>
      <AddressBook initial={addresses} error={error} />
    </main>
  );
}
