import { expect, test } from '@playwright/test';

import { STOREFRONT_URL } from '../support/env';
import {
  GUEST_ORDER,
  disconnectFixtures,
  ensureGuestLookupOrder,
} from '../support/db';

/**
 * 游客订单查询（匿名，订单号 + 收货手机号双因子）。
 *
 * ## 反例守的是什么（审计 P1）
 *
 * 防爆破的计数键是「来源 IP × 订单号」。历史上 `api` 不采信
 * `x-forwarded-for`，`req.ip` 恒等于 BFF 容器地址 —— 所有来源共用一个桶，
 * **一个人猜错 5 次就能把该订单的查单入口对全国锁死 10 分钟**。
 * 另一次回归是取错头的左端，客户端自己编一个 XFF 就绕过去了。
 *
 * 所以反例不能只断言「猜错 5 次会被封」，必须同时断言
 * **换个来源仍能正常查**：只有「按来源隔离」成立，这条才绿。
 */
const LOOKUP_PATH = '/api/orders/guest-lookup';

/** 每次跑用随机来源，避免 CI 的 retries 撞上上一轮留下的计数桶 */
function randomSourceIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 254);
  return `10.${octet()}.${octet()}.${octet()}`;
}

test.describe('游客订单查询', () => {
  test.beforeAll(async () => {
    await ensureGuestLookupOrder();
  });

  test.afterAll(async () => {
    await disconnectFixtures();
  });

  test('正例：订单号 + 正确收货手机号能在页面上查到订单', async ({ page }) => {
    await page.goto('/orders/lookup');
    await page.getByLabel('订单号').fill(GUEST_ORDER.orderNo);
    await page.getByLabel('收货手机号').fill(GUEST_ORDER.receiverPhone);
    await page.getByRole('button', { name: '查询' }).click();

    await expect(page.getByText('查询到以下订单')).toBeVisible();
    await expect(page.getByText(GUEST_ORDER.orderNo)).toBeVisible();
    // 金额与状态都来自后端的最小投影
    await expect(page.getByText('¥199.00')).toBeVisible();
    await expect(page.getByText('待发货')).toBeVisible();
    // 投影里没有收货人 —— 页面不该把它显示出来
    await expect(page.getByText(GUEST_ORDER.receiverName)).toHaveCount(0);
  });

  test('反例：猜错按来源熔断，换一个来源仍能正常查询', async ({ request }) => {
    const blockedIp = randomSourceIp();
    const otherIp = randomSourceIp();

    const lookup = (phone: string, ip: string) =>
      request.post(`${STOREFRONT_URL}${LOOKUP_PATH}`, {
        headers: { 'x-forwarded-for': ip },
        data: { orderNo: GUEST_ORDER.orderNo, phone },
      });

    // ---- 来源 A：连续 5 次手机号不匹配 → 都只是 404，还没熔断 ----
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await lookup('13000000000', blockedIp);
      expect(response.status(), `第 ${attempt} 次错误尝试`).toBe(404);
    }

    // ---- 第 6 次：即便手机号对了也熔断（封的是来源，不是这一次的输入）----
    const blocked = await lookup(GUEST_ORDER.receiverPhone, blockedIp);
    expect(blocked.status()).toBe(429);
    expect((await blocked.json()).message).toContain('尝试次数过多');

    // ---- 来源 B：同一个订单号 + 正确手机号 → 正常查到 ----
    // ⚠️ 限流键若退化成「只看订单号」（或 api 不再信任代理头、
    //    req.ip 退化成 BFF 地址），这里会拿到 429，用例变红。
    const other = await lookup(GUEST_ORDER.receiverPhone, otherIp);
    expect(other.status()).toBe(200);
    expect((await other.json()).orderNo).toBe(GUEST_ORDER.orderNo);
  });
});
