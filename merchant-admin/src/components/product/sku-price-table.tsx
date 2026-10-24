'use client';

import { useMemo, useState } from 'react';
import { formatPrice } from '@/components/product/format';

/**
 * 商品详情接口返回的 SKU。
 *
 * 单独声明而不是直接用 ProductDetail['skus'][number]：详情接口
 * （GET /catalog/products/:id）**不返回 specValues**——后端那一处的
 * `include: { skus: { where: ... } }` 没有带上关联（见
 * api/src/modules/catalog/products/products.service.ts 的 findOne），
 * 只有规格替换接口 PUT /specs 的返回值才带。
 *
 * 所以这里的 specValues 是**可选**的：声明成必填会让 TypeScript 以为它
 * 总在，而运行时是 undefined，直接 `.map` 就把整页打成 500
 * （tsc 与 next build 都发现不了，只有真正渲染才炸）。
 * 类型说是必填、实际可能没有，比类型说可选更危险——前者会骗过后续每一个读者。
 */
interface DetailSku {
  id: string;
  price: number;
  comparePrice: number | null;
  code: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  specValues?: Array<{ valueId: string }>;
}

/** 一行的编辑态。四个字段都是「输入框里那个字符串」，只有 status 是枚举。 */
interface RowDraft {
  price: string;
  comparePrice: string;
  code: string;
  status: 'ACTIVE' | 'INACTIVE';
}

/**
 * SKU 价格表：逐行改售价、划线价、商家编码与启用状态。
 *
 * 每一行对应规格矩阵笛卡尔积出来的一个组合。改价走**单条 PATCH**
 * /api/products/[id]/skus/[skuId]，与规格的整体替换（PUT）是两条链路：
 * 改价是高频操作，不值得为了改一个数字重建整张矩阵。
 *
 * ⚠️ **这里不接受 stock**：后端的 UpdateSkuDto 没有这个字段，多传一个会被
 * forbidNonWhitelisted 挡成 400；库存只能走库存调整接口（留流水、append-only），
 * 所以库存列只读。
 *
 * ⚠️ **SKU 的 PATCH 没有乐观锁**：后端 UpdateSkuDto 里没有 version 字段，
 * 冲突时后写覆盖。这一点是有意的（改价代价可控，商品标题被静默覆盖的代价大得多），
 * 所以本组件不处理 409。
 *
 * ⚠️ **行标签拿不到规格文本**：详情接口不回 specValues（见 DetailSku 的说明），
 * 而 PUT /specs 的返回值虽然带 specValues，指向的却是**已被软删**的旧规格值
 * id（替换时旧值被软删、新值另起 id），拿去和 specs[].values 对不上。
 * 所以这里退而求其次：用**商家编码**做行标识，没有编码的用行号，
 * 规格组合以「请对照上方规格矩阵」的形式说明。详见 label 的注释。
 */
interface SpecRow {
  sku: DetailSku;
  /** 展示标签 */
  label: string;
}

async function readResponse(response: Response, fallback: string): Promise<string | null> {
  const payload = (await response.json().catch(() => ({}))) as { message?: string };
  return response.ok ? null : (payload.message ?? fallback);
}

/** 分（整数）→ 输入框里的元字符串（带两位小数的可读形式） */
function centsToText(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * 输入框文本 → 分。
 *
 * 返回 null 表示「还没输成合法的金额」（空串、多个小数点、非数字）。
 * 调用点据此**不发请求**并保持原值——比发一个必然 400 的请求好，
 * 也不会把商家正在敲的半个数字冲掉。
 *
 * 负数在这里就挡掉：中转会 400，后端也有 @Min(0)，但界面上给不出
 * 「为什么要这么写」的解释。
 */
function textToCents(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || !/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const yuan = Number(trimmed);
  if (!Number.isFinite(yuan)) return null;
  // 四舍五入到分，避免浮点误差把 12.34 变成 1233 分。
  return Math.round(yuan * 100);
}

/**
 * 拿不到规格文本时的行标签。
 *
 * 优先用商家编码——它是商家自己起的、通常就编码了规格（「BLACK-M」这类），
 * 比行号有信息量得多。没有编码的才退回行号。
 *
 * 不用 SKU id 的前 8 位：那对人没有意义，而且会让人以为那就是编码。
 */
function fallbackLabel(sku: DetailSku, index: number): string {
  const code = sku.code?.trim();
  return code !== undefined && code !== '' ? code : `SKU ${index + 1}`;
}

export function SkuPriceTable({
  productId,
  skus,
  specs,
}: {
  productId: string;
  skus: DetailSku[];
  specs: Array<{ id: string; values: Array<{ id: string; value: string }> }>;
}) {
  /**
   * valueId → 文本。
   *
   * 只用**未软删**的取值（详情接口已经过滤过了，这里不再判 deletedAt）。
   * 同名维度（换过矩阵）可能留下两个不同 id 的同名取值，这里按规格的
   * sort 顺序先到先得，标签读起来与规格矩阵里的展示顺序一致。
   */
  const valueTextById = useMemo(() => {
    const map = new Map<string, string>();
    for (const spec of specs) {
      for (const value of spec.values) {
        if (!map.has(value.id)) map.set(value.id, value.value);
      }
    }
    return map;
  }, [specs]);

  const rows: SpecRow[] = useMemo(
    () =>
      skus.map((sku, index) => {
        // specValues 在详情接口里**不存在**（见 DetailSku 的说明）。
        // 这一段保留，是为了让将来后端补上 include: { specValues: true }
        // 之后，标签自动变回「黑色 / M」而这里一行都不用改。
        //
        // `specValues` 存在时按**规格矩阵的维度顺序**拼，而不是按它的返回
        // 顺序——后者没有语义顺序，直接拼会得到「M / 黑色」这种颠倒的标签。
        const specValues = sku.specValues;
        if (Array.isArray(specValues) && specValues.length > 0) {
          const valueIds = specValues.map((sv) => sv.valueId);
          const ordered = specs
            .flatMap((spec) => spec.values)
            .filter((value) => valueIds.includes(value.id))
            .map((value) => value.id);
          const ids = [...new Set([...ordered, ...valueIds])];
          const text = ids
            .map((id) => valueTextById.get(id) ?? `（已删除的规格值 ${id.slice(0, 8)}）`)
            .join(' / ');
          // 全都查不到文本时（指向的都是软删过的旧值）也算失败，走下面的兜底。
          if (!ids.every((id) => valueTextById.has(id))) {
            return { sku, label: fallbackLabel(sku, index) };
          }
          return { sku, label: text };
        }

        return { sku, label: fallbackLabel(sku, index) };
      }),
    [skus, specs, valueTextById],
  );

  if (rows.length === 0) {
    return (
      <section className="flex flex-col gap-2 rounded-md border p-4">
        <h3 className="text-lg font-semibold">SKU 价格表</h3>
        <p className="text-sm text-muted-foreground">
          这个商品还没有 SKU。请先在上方的「规格矩阵」里添加规格并保存，
          系统会按组合自动生成 SKU（初始售价为 0）。
        </p>
      </section>
    );
  }

  return <SkuPriceTableBody productId={productId} rows={rows} />;
}

/**
 * 表格主体。
 *
 * 单独拆出来是为了让「无 SKU」的空状态提前 return 时不必把几十个
 * useState 全挂在上面——Hook 规则要求它们无条件调用，条件 return 会让
 * 同一个组件在不同渲染下走不同的 Hook 序列。
 */
function SkuPriceTableBody({ productId, rows }: { productId: string; rows: SpecRow[] }) {
  /**
   * 每行的编辑草稿与保存状态。
   *
   * 刻意以 skuId 为 key 的 Map 而不是数组下标：停用/启用会改变行数吗？不会，
   * 但**规格矩阵替换后 SKU 列表整体变了**，父组件刷新传下来的是新的 rows，
   * 下标就对不上了。id 是稳定键。
   */
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>(() =>
    Object.fromEntries(
      rows.map((row) => [
        row.sku.id,
        {
          price: centsToText(row.sku.price),
          comparePrice: row.sku.comparePrice === null ? '' : centsToText(row.sku.comparePrice),
          code: row.sku.code ?? '',
          status: row.sku.status,
        },
      ]),
    ),
  );
  const [busySkuId, setBusySkuId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});

  /**
   * 按**草稿**算出来的最低售价，实时跟着输入走。
   *
   * 只看已启用的 SKU：与后端 recomputeMinPrice 的口径一致（停用的不参与），
   * 所以这个数字就是保存后商品列表的价格筛选与排序会用到的那个值——
   * 商家在改价时就能看到它往哪走，不用保存完再回列表确认。
   *
   * 输入框里还没敲成合法金额的行直接跳过（当成它没有改动，用库里的价），
   * 不让一个半成品输入把整个最低价算成 0。
   */
  const { activeCount, minPrice, hasZeroPriced } = useMemo(() => {
    const active = rows.filter((row) => drafts[row.sku.id]?.status === 'ACTIVE');
    const prices = active.map((row) => {
      const draft = drafts[row.sku.id];
      if (!draft) return row.sku.price;
      return textToCents(draft.price) ?? row.sku.price;
    });
    return {
      activeCount: active.length,
      minPrice: prices.length > 0 ? Math.min(...prices) : null,
      hasZeroPriced: prices.some((price) => price === 0),
    };
  }, [rows, drafts]);

  function patchDraft(skuId: string, patch: Partial<RowDraft>) {
    setDrafts((current) => ({ ...current, [skuId]: { ...current[skuId], ...patch } }));
  }

  function setMessage(skuId: string, text: string) {
    setMessages((current) => ({ ...current, [skuId]: text }));
  }

  /**
   * 把一行里改了哪些字段挑出来，组装成 PATCH 的请求体。
   *
   * 三个结果用带 `ok` 判别联合而不是「返回 null / 带 error 键」：
   * 后者在 TS 里窄化不出来（Record<string, unknown> 上加 error 键，
   * `'error' in result` 得到的是 unknown 而不是 string）。
   */
  function buildPatch(
    row: SpecRow,
    draftOverride?: RowDraft,
  ): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } | null {
    const draft = draftOverride ?? drafts[row.sku.id];
    if (!draft) return null;

    const patch: Record<string, unknown> = {};

    const price = textToCents(draft.price);
    if (price === null) {
      return { ok: false, error: '售价必须是 ≥ 0 的金额（最多两位小数）' };
    }
    if (price !== row.sku.price) patch.price = price;

    // 划线价允许留空 = 没有划线价（后端只接受 number | null）。
    // 只在「从有到无」时发 null：从无到有不该把没动过的行也发一遍。
    const compareText = draft.comparePrice.trim();
    if (compareText === '') {
      if (row.sku.comparePrice !== null) patch.comparePrice = null;
    } else {
      const comparePrice = textToCents(compareText);
      if (comparePrice === null) {
        return { ok: false, error: '划线价必须是 ≥ 0 的金额，或留空表示没有划线价' };
      }
      if (comparePrice !== row.sku.comparePrice) patch.comparePrice = comparePrice;
    }

    const code = draft.code.trim();
    if (code.length > 64) return { ok: false, error: '商家编码最多 64 个字符' };
    if (code !== (row.sku.code ?? '')) patch.code = code;

    if (draft.status !== row.sku.status) patch.status = draft.status;

    return Object.keys(patch).length === 0 ? null : { ok: true, patch };
  }

  /**
   * 提交一行。
   *
   * `draftOverride` 让调用方能指定「用这份草稿而不是 state 里那一份」。
   * 停用/启用必须走这条路：它 setState 之后立刻调用本函数，而 setState 是异步的
   * ——同一轮里 drafts[row.sku.id] 还是旧值，buildPatch 会算成「状态没变」
   * 而发一个空请求，界面上还弹一句「已保存」，实际上什么都没改。
   */
  async function saveRow(row: SpecRow, draftOverride?: RowDraft) {
    const result = buildPatch(row, draftOverride);
    if (result === null) {
      setMessage(row.sku.id, '没有改动');
      return;
    }
    if (!result.ok) {
      setMessage(row.sku.id, result.error);
      return;
    }

    setBusySkuId(row.sku.id);
    setMessages((current) => ({ ...current, [row.sku.id]: '' }));
    try {
      const response = await fetch(`/api/products/${productId}/skus/${row.sku.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result.patch),
      });
      if (!response.ok) {
        throw new Error((await readResponse(response, '保存失败')) ?? '保存失败');
      }

      // 回读服务端结果覆盖草稿：后端可能对价格做了别的处理（比如 clamp），
      // 界面上留着商家的输入会与库里不一致。
      const updated = (await response.json()) as {
        price?: number;
        comparePrice?: number | null;
        code?: string | null;
        status?: 'ACTIVE' | 'INACTIVE';
      };
      setDrafts((current) => ({
        ...current,
        [row.sku.id]: {
          price: updated.price === undefined ? current[row.sku.id].price : centsToText(updated.price),
          comparePrice:
            updated.comparePrice === undefined
              ? current[row.sku.id].comparePrice
              : updated.comparePrice === null
                ? ''
                : centsToText(updated.comparePrice),
          code: updated.code === undefined ? current[row.sku.id].code : (updated.code ?? ''),
          status: updated.status ?? current[row.sku.id].status,
        },
      }));
      setMessage(row.sku.id, '已保存');
    } catch (cause) {
      setMessage(row.sku.id, cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusySkuId(null);
    }
  }

  /**
   * 启用状态是个开关，没有「失焦」这个时机可言，改完立刻存。
   *
   * 显式把新草稿传给 saveRow：setState 是异步的，同一轮里读 drafts 拿到的
   * 还是旧状态（详见 saveRow 的注释）。
   */
  async function toggleStatus(row: SpecRow) {
    const current = drafts[row.sku.id];
    if (!current) return;
    const next = row.sku.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const nextDraft: RowDraft = { ...current, status: next };
    patchDraft(row.sku.id, { status: next });
    await saveRow(row, nextDraft);
  }

  return (
    <section className="flex flex-col gap-4 rounded-md border p-4">
      <div>
        <h3 className="text-lg font-semibold">SKU 价格表</h3>
        <p className="text-xs text-muted-foreground">
          售价与划线价以<b>元</b>填写，保存时按整数分提交。改动会失焦自动保存。
          库存不在这里改——请到「库存」页调整，那里会保留完整流水。
        </p>
        <p className="text-xs text-muted-foreground">
          停用的 SKU 不参与商品的最低价计算，商品列表的价格筛选与排序也看不到它。
          规格矩阵保存后新生成的 SKU 初始售价为 0，记得逐条定价再上架。
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-2 font-medium">规格</th>
              <th className="py-2 pr-2 font-medium">售价（元）</th>
              <th className="py-2 pr-2 font-medium">划线价（元）</th>
              <th className="py-2 pr-2 font-medium">商家编码</th>
              <th className="py-2 pr-2 font-medium">库存</th>
              <th className="py-2 pr-2 font-medium">状态</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const draft = drafts[row.sku.id];
              if (!draft) return null;
              const inactive = row.sku.status === 'INACTIVE';
              const busy = busySkuId === row.sku.id;
              const message = messages[row.sku.id] ?? '';
              // 没有规格值的 SKU（老数据或单规格退化）标签是空的，
              // 用序号占位，别让商家对着一行空白。
              const label = row.label;

              return (
                <tr
                  key={row.sku.id}
                  className={
                    inactive
                      ? 'border-b bg-muted/50 text-muted-foreground'
                      : 'border-b'
                  }
                >
                  <td className="py-2 pr-2">
                    <span className={inactive ? 'line-through' : undefined}>{label}</span>
                    {inactive && (
                      <span className="ml-1 rounded bg-muted px-1 text-[10px]">已停用</span>
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      value={draft.price}
                      onChange={(event) => patchDraft(row.sku.id, { price: event.target.value })}
                      onBlur={() => saveRow(row)}
                      inputMode="decimal"
                      aria-label={`${label} 售价`}
                      className="w-24 rounded-md border bg-background px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      value={draft.comparePrice}
                      onChange={(event) =>
                        patchDraft(row.sku.id, { comparePrice: event.target.value })
                      }
                      onBlur={() => saveRow(row)}
                      placeholder="无"
                      inputMode="decimal"
                      aria-label={`${label} 划线价`}
                      className="w-24 rounded-md border bg-background px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      value={draft.code}
                      onChange={(event) => patchDraft(row.sku.id, { code: event.target.value })}
                      onBlur={() => saveRow(row)}
                      maxLength={64}
                      placeholder="选填"
                      aria-label={`${label} 商家编码`}
                      className="w-36 rounded-md border bg-background px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 pr-2 text-muted-foreground">
                    {/* 库存不在这里改：中转的 SKU PATCH 不接受 stock，
                        后端也会把多传的字段挡成 400。 */}
                    <span title="库存请到「库存」页调整，保留完整流水">只读</span>
                  </td>
                  <td className="py-2 pr-2">
                    <button
                      type="button"
                      onClick={() => toggleStatus(row)}
                      disabled={busy}
                      title={
                        inactive
                          ? '启用后该 SKU 重新参与最低价计算与前台展示'
                          : '停用后该 SKU 不参与最低价计算，前台不可购买'
                      }
                      className="rounded-md border px-2 py-1 text-xs disabled:opacity-40"
                    >
                      {inactive ? '已停用（点击启用）' : '已启用（点击停用）'}
                    </button>
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => saveRow(row)}
                      disabled={busy}
                      className="rounded-md border px-2 py-1 text-xs disabled:opacity-40"
                    >
                      {busy ? '保存中…' : '保存'}
                    </button>
                    {message && (
                      <span
                        className={
                          message === '已保存' || message === '没有改动'
                            ? 'ml-2 text-xs text-muted-foreground'
                            : 'ml-2 text-xs text-destructive'
                        }
                      >
                        {message}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        当前共 {rows.length} 个 SKU，其中{' '}
        {activeCount} 个已启用，最低售价{' '}
        <span className="font-medium text-foreground">{formatPrice(minPrice)}</span>。
        {hasZeroPriced && (
          <>
            {' '}
            还有售价为 0 的已启用 SKU——规格矩阵新增组合后需要定价，否则会以 0 元商品展示。
          </>
        )}
      </p>
    </section>
  );
}