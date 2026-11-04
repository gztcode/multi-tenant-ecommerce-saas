import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 批量确认 CSV 来源 A 类差异的中转：
 * `POST /api/billing/reconciliations/:id/items/batch-confirm`。
 *
 * ⚠️ **为什么要中转**：后端没开 CORS，accessToken 必须留在服务端；
 *    客户端组件 fetch 同源路由，这里用 session 里的 token 调后端。
 *
 * ⚠️ **请求体按白名单重建**：只放行 `{ mode, itemIds, cursor, limit, note }`，
 *    未知字段一律丢弃（整体透传等于把「哪些字段可写」交给后端 DTO，
 *    后端哪天加了字段它就静默变成客户端可写）。
 *
 * ⚠️ **两种模式各自只放行自己的字段**：
 *    `IDS` → `itemIds`；`FILTER` → `cursor` / `limit`。
 *    夹带另一个模式的字段（前端 bug / 手工构造）直接丢掉，不转给后端。
 *
 * ⚠️ **上限与后端 DTO 逐字对齐**：itemIds ≤ 200、note 1–200 字、limit 1–200。
 *    前端放行超限值、后端 400 的话，界面上只剩一句没头没尾的校验失败。
 */

const MAX_ITEM_IDS = 200;
const MAX_NOTE_LENGTH = 200;
const MAX_BATCH_LIMIT = 200;

/** v4 UUID（与后端 `@IsUUID('4')` 对齐） */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function badRequest(message: string): NextResponse {
  return NextResponse.json({ message }, { status: 400 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }

  const raw = await readJson(request);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return badRequest('请求体必须是 JSON 对象');
  }
  const payload = raw as Record<string, unknown>;

  const mode = payload.mode;
  if (mode !== 'IDS' && mode !== 'FILTER') {
    return badRequest('确认模式只能是「勾选确认」或「全选确认」');
  }

  const noteRaw = payload.note;
  if (typeof noteRaw !== 'string' || noteRaw.trim() === '') {
    return badRequest('必须填写确认说明');
  }
  const note = noteRaw.trim();
  if (note.length > MAX_NOTE_LENGTH) {
    return badRequest(`确认说明不能超过 ${MAX_NOTE_LENGTH} 字`);
  }

  if (mode === 'IDS') {
    const itemIds = payload.itemIds;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return badRequest('请选择要确认的差异项');
    }
    if (itemIds.some((item) => typeof item !== 'string')) {
      return badRequest('差异项 id 必须是字符串');
    }
    // ⚠️ **先校验、后去重**：201 条里即使有重复也算超限，
    //    否则「去重后 ≤ 200」会让超限请求悄悄通过。
    if (itemIds.length > MAX_ITEM_IDS) {
      return badRequest(`单次最多确认 ${MAX_ITEM_IDS} 条差异项`);
    }
    const unique = [...new Set(itemIds as string[])];

    try {
      const result = await apiFetch(
        `/platform/payout-reconciliations/${id}/items/batch-confirm`,
        {
          method: 'POST',
          body: { mode: 'IDS', itemIds: unique, note },
          token: session.accessToken,
        },
      );
      return NextResponse.json(result);
    } catch (cause) {
      return toErrorResponse(cause);
    }
  }

  // ---- FILTER ----
  const cursorRaw = payload.cursor;
  let cursor: string | undefined;
  if (cursorRaw !== undefined) {
    if (typeof cursorRaw !== 'string' || !UUID_V4.test(cursorRaw)) {
      return badRequest('游标格式不正确');
    }
    cursor = cursorRaw;
  }

  const limitRaw = payload.limit;
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    if (
      typeof limitRaw !== 'number' ||
      !Number.isInteger(limitRaw) ||
      limitRaw < 1 ||
      limitRaw > MAX_BATCH_LIMIT
    ) {
      return badRequest(`单批条数必须在 1–${MAX_BATCH_LIMIT} 之间`);
    }
    limit = limitRaw;
  }

  try {
    const result = await apiFetch(
      `/platform/payout-reconciliations/${id}/items/batch-confirm`,
      {
        method: 'POST',
        body: {
          mode: 'FILTER',
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
          note,
        },
        token: session.accessToken,
      },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
