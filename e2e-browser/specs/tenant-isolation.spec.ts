import { expect, test } from '@playwright/test';

import {
  CROSS_TENANT_ORDER,
  DEMO_ORDER,
  disconnectFixtures,
  ensureCrossTenantOrders,
} from '../support/db';
import { loginAsCustomer } from '../support/login';

/**
 * 跨租户隔离（真实浏览器 + 真实租户扩展）。
 *
 * ## 这条用例守的是什么
 *
 * 租户隔离不是写在 controller 里的 if，而是 Prisma 扩展自动给查询附加
 * `tenantId`。扩展一旦挂掉，**不会有任何报错**——查询照常返回，
 * 只是把别的租户的数据也带出来了。api/test 的隔离用例直接断言仓储层，
 * 这里补的是「扩展失效后，界面上真的会泄漏」那一层。
 *
 * ## 夹具为什么绕开接口
 *
 * 库里的那条「租户 B 的订单」`customerId` 指向 **demo 店铺的同一个消费者**，
 * 只有 `tenantId` 是租户 B。接口层造不出这种数据（下单必然写当前租户），
 * 所以直接落库。
 *
 * 也就是说：`readConsumerOrder` 的 where 只有 `orderNo + customerId`，
 * 租户条件完全由扩展附加。**扩展一旦被摘掉，demo 顾客就能打开这条订单**，
 * 详情页会渲染出「租户B收货人」，下面的断言立刻变红。
 */
test.describe('跨租户隔离', () => {
  test.beforeAll(async () => {
    await ensureCrossTenantOrders();
  });

  test.afterAll(async () => {
    await disconnectFixtures();
  });

  test('店铺 A 的登录态看不到店铺 B 的订单', async ({ page }) => {
    await loginAsCustomer(page);

    // ---- 列表：只有自己的单，租户 B 的单号与收货人一次都不出现 ----
    await page.goto('/orders');
    await expect(
      page.getByRole('link', { name: DEMO_ORDER.orderNo }),
    ).toBeVisible();
    await expect(page.getByText(CROSS_TENANT_ORDER.orderNo)).toHaveCount(0);
    await expect(page.getByText(CROSS_TENANT_ORDER.receiverName)).toHaveCount(0);

    // ---- 详情：按订单号直连租户 B 的单 → 页面拒绝展示，不渲染任何收货信息 ----
    // ⚠️ 断言的是**页面渲染结果**而不是 HTTP 状态：详情页是流式渲染的
    // Server Component，响应头先于正文发出，实际测到的是 200。
    await page.goto(`/orders/${CROSS_TENANT_ORDER.orderNo}`);
    await expect(page.getByText('订单不存在')).toBeVisible();
    await expect(page.getByText(CROSS_TENANT_ORDER.receiverName)).toHaveCount(0);
    await expect(page.getByText('收货信息')).toHaveCount(0);

    // ---- 正向对照：自己的单能正常打开 ----
    // 没有这一段，上面那条「看不到」也可能只是因为详情页整个坏了。
    await page.goto(`/orders/${DEMO_ORDER.orderNo}`);
    await expect(page.getByText('收货信息')).toBeVisible();
    await expect(page.getByText(DEMO_ORDER.receiverName)).toBeVisible();
  });
});
