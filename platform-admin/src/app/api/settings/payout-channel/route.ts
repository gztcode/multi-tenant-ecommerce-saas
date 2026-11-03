import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 平台默认出款渠道的中转：`PUT /api/settings/payout-channel`。
 *
 * ⚠️ **为什么要中转**：后端没开 CORS，accessToken 必须留在服务端；
 *    客户端组件 fetch 同源路由，这里用 session 里的 token 调后端。
 *
 * ⚠️ **白名单纪律**：请求体**按白名单重建**，只放行 `{ channel }`，
 *    多余字段一律丢弃（整体透传等于把「哪些字段可写」交给后端 DTO，
 *    后端哪天加了字段它就静默变成客户端可写）。
 *
 * ⚠️ **长度上限 40 与后端 DTO 的 `@MaxLength(40)` 逐字对齐**：
 *    前端放行超长值、后端 400 的话，界面上只剩一句没头没尾的校验失败。
 */

const MAX_CHANNEL_LENGTH = 40;

export async function PUT(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const payload = (await readJson(request)) as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  const channel = payload.channel;
  if (typeof channel !== 'string' || channel.trim() === '') {
    return NextResponse.json(
      { message: '出款渠道必须是非空字符串' },
      { status: 400 },
    );
  }
  if (channel.trim().length > MAX_CHANNEL_LENGTH) {
    return NextResponse.json(
      { message: `出款渠道不能超过 ${MAX_CHANNEL_LENGTH} 个字符` },
      { status: 400 },
    );
  }

  try {
    const result = await apiFetch('/platform/settings/payout-channel', {
      method: 'PUT',
      body: { channel: channel.trim() },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
