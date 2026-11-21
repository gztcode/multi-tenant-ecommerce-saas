import { expect, type Page } from '@playwright/test';

import { DEMO, MERCHANT_ADMIN_URL } from './env';

/**
 * 登录 seed 里的示例消费者（storefront，客户作用域）。
 *
 * ⚠️ 登录成功后必须等一个只有登录态才渲染得出的元素，再继续往下走：
 * `signIn` 的跳转是客户端 `router.push`，`page.goto` 紧接着发出时
 * 浏览器可能还没带上新 cookie，后续页面会被重定向回登录页。
 */
export async function loginAsCustomer(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(DEMO.customerEmail);
  await page.getByLabel('密码').fill(DEMO.customerPassword);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '我的账户' })).toBeVisible();
}

/**
 * 登录 seed 里的示例店主（merchant-admin，商家作用域）。
 *
 * ⚠️ 商家后台的登录**不带** `x-tenant-subdomain`（中心域名），
 * 也不能拿消费者账号登 —— 登录接口按 `scope` 区分，scope 不匹配只会得到「密码错误」。
 *
 * ⚠️ 这里必须用绝对地址：`use.baseURL` 指向的是 storefront（3001），
 * `page.goto('/login')` 会打开消费者的登录页。
 */
export async function loginAsMerchant(page: Page): Promise<void> {
  await page.goto(`${MERCHANT_ADMIN_URL}/login`);
  await expect(page.getByRole('heading', { name: '商家后台登录' })).toBeVisible();
  await page.getByLabel('邮箱').fill(DEMO.merchantEmail);
  await page.getByLabel('密码').fill(DEMO.merchantPassword);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
}
