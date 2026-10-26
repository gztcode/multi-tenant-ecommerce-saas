import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 平台收入报表的中转：GET 报表。
 *
 * ⚠️ **query 也要白名单**：只放行 `from` 与 `to`，其余 query 参数
 * **一律丢弃**（不转发给后端）。整体透传等于把「哪些参数可以影响查询」
 * 交给后端的 forbidNonWhitelisted——那种 400 在界面上只是一句没头没尾的
 * 校验失败。
 *
 * ⚠️ **两个参数都可选**：都没给时**不传这两个参数**，让后端用它的
 * 「最近 30 天」缺省值——那个缺省窗口是用**数据库的时钟**算的
 * （护栏 M15：多副本部署时各机器的时钟有偏差）。
 * 前端自己算「最近 30 天」用的是浏览器的时钟，与后端对不上时，
 * 界面显示的区间与后端统计的区间就不是同一个区间。
 */

/** 报表区间里允许放行的 query 参数 */
const REPORT_QUERY_KEYS = ['from', 'to'] as const;

/**
 * ⚠️ **只认带时区的 ISO 串**：`2026-01-01`（日期选择器的输出）会被
 * `new Date()` 解析成 UTC 零点，而 `2026-01-01T00:00:00` 被解析成**本地**
 * 零点 —— 两者差一个时区偏移。报表的区间是左闭右开 `[from, to)`，
 * 混着两种解析会让「同一天」有时算成同一天、有时差 8 小时，
 * 用户选「1 月 1 日到 1 月 1 日」会被判成非法区间。
 *
 * 后端 `@IsDateString()` 也只认 ISO —— 与它对齐，前端放行的后端一定接得住。
 */
const ISO_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export async function GET(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const url = new URL(request.url);
  const params = new URLSearchParams();

  let from: Date | null = null;
  let to: Date | null = null;

  for (const key of REPORT_QUERY_KEYS) {
    const raw = url.searchParams.get(key);
    // ⚠️ **没给就不传**：`?from=`（空串）也当没给 —— 空串不是合法时间，
    // 当没给能让后端走它的缺省值，比报 400 更符合直觉。
    if (raw === null || raw === '') continue;

    // ⚠️ **必须带时区**：见 ISO_WITH_TIMEZONE 的注释。
    // 不带时区的串（`2026-01-01`）在这里就拒掉 —— 放行会让它被
    // `new Date()` 按 UTC 解析，与另一个按本地解析的端点差一个时区偏移。
    if (!ISO_WITH_TIMEZONE.test(raw)) {
      return NextResponse.json(
        {
          message: `${key} 必须是带时区的 ISO 串（如 2026-01-01T00:00:00.000Z）`,
        },
        { status: 400 },
      );
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { message: `${key} 必须是合法的 ISO 8601 时间` },
        { status: 400 },
      );
    }

    params.set(key, raw);
    if (key === 'from') from = parsed;
    else to = parsed;
  }

  // ⚠️ **from 必须早于 to**（相等也当非法）：区间是左闭右开 `[from, to)`，
  // 相等意味着空区间，算不出任何东西。后端也会因此报错，
  // 但在这里就拦住能让界面给出「区间非法」而不是一句后端的转述。
  if (from && to && from.getTime() >= to.getTime()) {
    return NextResponse.json(
      { message: '区间非法：from 必须早于 to' },
      { status: 400 },
    );
  }

  const query = params.toString();
  const path = query ? `/platform/reports?${query}` : '/platform/reports';

  try {
    const result = await apiFetch(path, {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
