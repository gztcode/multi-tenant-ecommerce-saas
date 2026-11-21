import { expect, test } from '@playwright/test';

import { DEMO_ORDER, disconnectFixtures, ensureDemoOrder } from '../support/db';
import { loginAsMerchant } from '../support/login';

/**
 * 商家后台关键页面渲染（中心域名，商家作用域会话）。
 *
 * ## 断言为什么不能只看 HTTP 200
 *
 * 这些页面是 Server Component：layout 拿 session、页面用 accessToken
 * 调后端。**后端 401、`API_BASE_URL` 指错、session 回调丢 token** 中的
 * 任意一种，页面都照样返回 200，只是正文变成一句「加载店铺失败（401）」。
 * 所以断言的是页面上真的出现了**从后端取回的数据**：店铺名、订单号。
 */
test.describe('商家后台', () => {
  test.beforeAll(async () => {
    await ensureDemoOrder();
  });

  test.afterAll(async () => {
    await disconnectFixtures();
  });

  test('登录后概览与订单主列表都能加载出真实数据', async ({ page }) => {
    await loginAsMerchant(page);

    // ---- 概览：店铺信息来自 `GET /stores/me`，不是写死在页面上的 ----
    await expect(page.getByRole('heading', { name: '商家后台' })).toBeVisible();
    await expect(page.getByText('示例店铺')).toBeVisible();
    await expect(page.getByText('当前店铺')).toBeVisible();

    // ---- 订单主列表：筛选区 + 表头 + 真实数据行 ----
    await page.getByRole('link', { name: '订单', exact: true }).click();
    await expect(page.getByRole('heading', { name: '订单' })).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: '订单号' }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: '收货人' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '筛选' })).toBeVisible();
    await expect(page.getByText(/共 \d+ 个订单/)).toBeVisible();

    // 关键一行：表格里真的有这条订单（空列表同样会返回 200）
    await expect(
      page.getByRole('link', { name: DEMO_ORDER.orderNo }),
    ).toBeVisible();
    await expect(page.getByText(DEMO_ORDER.receiverName)).toBeVisible();
  });
});
