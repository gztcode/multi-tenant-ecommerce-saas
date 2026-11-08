import { expect, test } from '@playwright/test';

/**
 * 浏览器级 golden path（阶段 11c）。
 *
 * 登录 → 收货地址 → 浏览商品 → 加入购物车 → 结算下单 → 假网关支付 → 订单 PAID。
 *
 * 这是 api/test（jest e2e）覆盖不到的层：真实浏览器里的会话 cookie、
 * 表单交互、跨页跳转、BFF 转发——「按钮指向不存在的页面」这类 UI 断链
 * 只有真实浏览器守得住。
 *
 * 断言口径：
 * - 文案断言用**页面上的真实渲染文本**（中文），与 UI 文案耦合是本层测试的本分；
 * - 订单状态断言看订单详情页的状态字段，不看接口。
 */

test('登录 → 加购 → 下单 → 假网关支付 → 订单 PAID', async ({ page }) => {
  // ---- 登录（seed 的示例消费者）----
  await page.goto('/login');
  await page.getByLabel('邮箱').fill('customer@demo.platform.test');
  await page.getByLabel('密码').fill('Demo12345!');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '我的账户' })).toBeVisible();

  // ---- 创建收货地址（下单必需；地址簿在 /account/addresses）----
  await page.goto('/account/addresses');
  await page.getByRole('button', { name: '新增地址' }).click();
  await page.getByLabel('收件人').fill('浏览器测试');
  await page.getByLabel('手机号').fill('13800001111');
  await page.getByLabel('省份').fill('浙江省');
  await page.getByLabel('城市').fill('杭州市');
  await page.getByLabel('区 / 县').fill('西湖区');
  await page.getByLabel('详细地址').fill('文一西路 100 号');
  await page.getByRole('button', { name: /保存|新增/ }).click();
  await expect(page.getByText('浏览器测试').first()).toBeVisible();

  // ---- 浏览商品（seed 的 single-SKU 商品）并加购 ----
  await page.goto('/p/cotton-tee');
  await expect(page.getByRole('button', { name: '加入购物车' })).toBeVisible();
  // 有规格的商品先选第一个规格值
  const specOptions = page.getByRole('button', { name: /白色|黑色|M|L|XL/ });
  if ((await specOptions.count()) > 0) {
    await specOptions.first().click();
  }
  await page.getByRole('button', { name: '加入购物车' }).click();
  await expect(page.getByText(/已加入|加入成功|购物车/).first()).toBeVisible();

  // ---- 购物车 → 结算 ----
  await page.goto('/cart');
  await expect(page.getByText('cotton-tee').or(page.getByText(/纯棉/))).toBeVisible();
  await page.getByRole('button', { name: '去结算' }).click();

  // ---- 提交订单 ----
  await expect(page.getByText('浏览器测试').first()).toBeVisible(); // 地址已选
  await page.getByRole('button', { name: /提交订单|下单|支付/ }).click();

  // ---- 假网关支付 ----
  // 下单后进入支付环节：点击「去支付」跳到假网关页（API 端口）
  await page.getByRole('button', { name: /去支付|立即支付/ }).click();
  await page.waitForURL(/\/api\/v1\/pay\/fake\//, { timeout: 20_000 });
  // 先读订单号：假网关的 confirm 是「空 200」，点击后页面变空文档
  const orderNo = (await page.locator('dd').first().textContent())?.trim() ?? '';
  expect(orderNo).not.toBe('');
  await page.getByRole('button', { name: '确认支付', exact: true }).click();
  await page.waitForLoadState('load');

  // 回订单详情页断言状态
  await page.goto(`/orders/${orderNo}`);
  // ⚠️ PAID 在订单详情页的文案是「待发货」（已支付、待商家发货）
  await expect(page.getByText('待发货').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('支付时间').first()).toBeVisible();
});
