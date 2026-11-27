import { decode } from '@auth/core/jwt';
import { expect, test, type BrowserContext } from '@playwright/test';

import {
  API_BASE_URL,
  AUTH_SECRET,
  DEMO,
  MERCHANT_ADMIN_URL,
} from '../support/env';
import { loginAsMerchant } from '../support/login';

/**
 * 登出必须**真正吊销后端的刷新令牌**。
 *
 * ## 这条用例守的是什么
 *
 * NextAuth 的 `signOut()` 只清本地会话 cookie，**它自己不会通知后端**。
 * 在修这个问题之前，用户点了「退出登录」，那枚刷新令牌仍然有效到签发后 30 天 ——
 * 设备丢了、cookie 被偷了，「退出登录」并不能让攻击者失效。
 *
 * ## 怎么拿得到那枚刷新令牌
 *
 * 会话 cookie 是 JWE（加密，不是签名），只能拿 `AUTH_SECRET` 解
 * —— 这正是不用「眯着眼看」的做法：解出来的 token 拿去打真实接口。
 *
 * ## ⚠️ 为什么不在登出前先 refresh 一次做「正向对照」
 *
 * 刷新是轮换式的：刷新后旧行变成 `ROTATED` 并进入 60 秒宽限期，
 * 而 `logout()` 的 `updateMany` 条件带 `revokedAt: null`，对 `ROTATED` 行是 no-op。
 * 一旦「先 refresh 再登出」，登出吊销不到任何东西，用例会假绿。
 * 正向对照因此改用**另一条独立的登录会话**（接口直登）来证明
 * `/auth/refresh` 本身是可用的、401 不是「格式不对」造成的。
 */

/** 会话 cookie 名：本地是 http，不带 `__Secure-` 前缀 */
const SESSION_COOKIE = 'authjs.session-token';

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

/** 从浏览器 cookie 里解出当前会话的两枚令牌 */
async function readSessionTokens(context: BrowserContext): Promise<SessionTokens> {
  const cookie = (await context.cookies(MERCHANT_ADMIN_URL)).find(
    (item) => item.name === SESSION_COOKIE,
  );
  expect(cookie, '登录后应当存在 NextAuth 会话 cookie').toBeTruthy();

  const token = await decode<{ accessToken?: string; refreshToken?: string }>({
    token: cookie!.value,
    secret: AUTH_SECRET,
    // salt 必须等于 cookie 名，否则解出来是 null
    salt: SESSION_COOKIE,
  });
  expect(token?.accessToken, '会话里应当有访问令牌').toBeTruthy();
  expect(token?.refreshToken, '会话里应当有刷新令牌').toBeTruthy();

  return {
    accessToken: token!.accessToken!,
    refreshToken: token!.refreshToken!,
  };
}

/** 直接打后端刷新接口，返回状态码（不做断言，正反例都用它） */
async function refreshStatus(refreshToken: string): Promise<number> {
  const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  // 读掉响应体，避免 keep-alive 连接悬着
  await response.text();
  return response.status;
}

test('商家后台退出登录后，旧刷新令牌不能再换访问令牌', async ({ page, context }) => {
  // 正向对照：另起一条会话，证明刷新接口本身是好用的。
  // 走接口直登，不碰浏览器那条会话（理由见文件头注释）。
  const loginResponse = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: DEMO.merchantEmail,
      password: DEMO.merchantPassword,
      scope: 'MERCHANT',
    }),
  });
  expect(loginResponse.status, '演示商家应当能通过接口登录').toBe(200);
  const control = (await loginResponse.json()) as { refreshToken: string };
  expect(
    await refreshStatus(control.refreshToken),
    '对照组：登出前刷新令牌是能换到新令牌的（否则后面的 401 说明不了任何事）',
  ).toBe(200);

  // 被测会话：走真实 UI 登录，再从会话 cookie 里取出它自己的刷新令牌
  await loginAsMerchant(page);
  const session = await readSessionTokens(context);

  // 退出登录：这个 server action 以前只调 signOut()，现在还要吊销后端会话
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.waitForURL(`${MERCHANT_ADMIN_URL}/login`);

  // 核心断言：同一枚刷新令牌，登出之后必须被拒
  expect(
    await refreshStatus(session.refreshToken),
    '登出后旧刷新令牌必须失效（否则「退出登录」挡不住偷到 cookie 的人）',
  ).toBe(401);

  // 会话 cookie 也确实被清掉了：登出后不该还把过期会话当已登录
  const cookies = await context.cookies(MERCHANT_ADMIN_URL);
  expect(
    cookies.find((item) => item.name === SESSION_COOKIE && item.value !== ''),
    '登出后会话 cookie 应当被清除',
  ).toBeFalsy();
});
