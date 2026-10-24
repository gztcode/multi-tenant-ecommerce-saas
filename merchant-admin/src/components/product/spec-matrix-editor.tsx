'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { ProductSpec } from '@/components/product/types';

/**
 * 规格矩阵编辑器。
 *
 * 规格是一张「维度 × 取值」的表：颜色（黑色/白色）× 尺码（M/L），
 * 笛卡尔积出来的每个组合对应一个 SKU。
 *
 * ⚠️ **保存是破坏性的整体替换**，走 PUT /api/products/[id]/specs。
 * 提交的是**完整的**当前结构，只回传改动的那一维会把其他维连同它们的 SKU
 * 一起停用（后端在一个事务里匹配既有 SKU、新建缺失的、把多余的置 INACTIVE）。
 * 所以本组件的 state 是编辑期间唯一的事实来源——加载时从 product.specs
 * 铺满，提交时原样送出去，中途不依赖服务端再取一次。
 *
 * ⚠️ **values 里不带 id**：后端按 `(specId, value)` 的文本匹配，
 * 带 id 反而会被 ValidationPipe 的 forbidNonWhitelisted 挡成 400。
 *
 * ⚠️ **version 乐观锁**：后端不匹配返回 409。收到 409 只提示商家刷新重试，
 * 绝不静默重试——那会拿旧结构覆盖别人刚保存的改动。
 */

/** 后端 ReplaceSpecsDto 的上限，与中转路由里的常量保持一致 */
const MAX_SPECS = 2;
const MAX_VALUES = 20;
/** 后端对维度名与规格值都限了 40 个字符 */
const MAX_TEXT_LENGTH = 40;

/**
 * 编辑期的维度形状。
 *
 * 用临时 key 而不是数组下标做 React key：删掉中间一维时下标会整体前移，
 * 用下标会让 React 复用错的 DOM，输入框里残留上一个维度的内容。
 */
interface DraftValue {
  key: string;
  text: string;
}

interface DraftSpec {
  key: string;
  name: string;
  values: DraftValue[];
}

/** 单调递增的 key 序列。用模块级计数器而不是随机串：SSR 与客户端不会撞。 */
let keySeed = 0;
function nextKey(prefix: string): string {
  keySeed += 1;
  return `${prefix}-${keySeed}`;
}

/** 把服务端的规格铺成编辑草稿 */
function toDrafts(specs: ProductSpec[]): DraftSpec[] {
  return specs.map((spec) => ({
    key: nextKey('spec'),
    name: spec.name,
    values: spec.values.map((value) => ({ key: nextKey('value'), text: value.value })),
  }));
}

/**
 * 同一维度内去重（保留首次出现的顺序）。
 *
 * 界面上用文本框逐个录入，商家很容易把「黑色」敲两遍。后端按文本匹配，
 * 重复项会算成同一个取值——但**提交前的笛卡尔积预览会先算错**（多出几个
 * 实际不会生成的 SKU 组合），所以这里在预览和提交两处都用去重后的结果。
 *
 * trim 之后再比：`黑色 ` 与 `黑色` 在后端是同一个取值（DTO 会 trim），
 * 这里也得当成同一个，否则预览多算、提交时中转去重，两者对不上。
 */
function dedupeTexts(values: DraftValue[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const draft of values) {
    const text = draft.text.trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

/** 中转路由的统一响应解析：错误 message 直接可以显示给人看 */
async function readResponse(response: Response, fallback: string): Promise<string | null> {
  const payload = (await response.json().catch(() => ({}))) as { message?: string };
  return response.ok ? null : (payload.message ?? fallback);
}

export function SpecMatrixEditor({
  productId,
  version,
  specs,
}: {
  productId: string;
  /** 页面加载时的商品版本；本组件自己维护最新值，不依赖父组件回传 */
  version: number;
  specs: ProductSpec[];
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<DraftSpec[]>(() => toDrafts(specs));
  /**
   * 乐观锁用的当前版本，**自持**。
   *
   * 后端每次替换都把商品 version +1，所以保存成功后必须用响应里的新值覆盖，
   * 否则下一次保存会拿旧版本号提交、必然 409。自己持有而不是靠父组件回传，
   * 是因为规格保存与基本信息保存是两条独立的交互，父组件未必知道什么时候
   * 该同步——把它们绑在一起反而会出现「一边更新了一边没更新」。
   */
  const [currentVersion, setCurrentVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  /**
   * 预览用的规范化结构：去重 + 丢掉空名/空值的维度。
   *
   * 空维度不参与笛卡尔积——一个还没有填名字的维度不该让预览变成 0，
   * 也不该在提交时把「空名字」发过去（后端会 400）。
   */
  const normalized = useMemo(
    () =>
      drafts
        .map((draft) => ({ name: draft.name.trim(), values: dedupeTexts(draft.values) }))
        .filter((spec) => spec.name !== '' && spec.values.length > 0),
    [drafts],
  );

  /** 笛卡尔积的组合数。任一维度为空则整体为 0（还没有任何可生成的 SKU）。 */
  const skuCount = useMemo(
    () => normalized.reduce((product, spec) => product * spec.values.length, 1),
    [normalized],
  );

  /**
   * 同一次提交里的重名维度。
   *
   * 后端对「维度名重复」是**直接 400**（同名维度会匹配到同一条既有规格、
   * 写出两套互相矛盾的取值），所以这里在提交前拦下来并说清楚，
   * 而不是等一个没有上下文的 BadRequest。
   */
  const duplicateSpecNames = useMemo(() => {
    const names = normalized.map((spec) => spec.name);
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
    return [...duplicates];
  }, [normalized]);

  /** 当前草稿里有几组重复取值——提交前明确告知会被合并 */
  const duplicateGroups = useMemo(() => {
    const groups: string[] = [];
    for (const draft of drafts) {
      const texts = draft.values.map((v) => v.text.trim()).filter((t) => t !== '');
      const unique = new Set(texts);
      if (unique.size !== texts.length) groups.push(draft.name.trim() || '未命名维度');
    }
    return groups;
  }, [drafts]);

  /**
   * 「多余的 SKU 会被停用」的预览。
   *
   * PUT 是替换而不是增删：删掉一个取值后，依赖它的组合不再存在，
   * 对应的 SKU 会被置成 INACTIVE（**不会消失**，也**不会删数据**——
   * 商家把取值加回来时它还能被复用）。
   *
   * 这个提示是危险操作前唯一的告知，所以放在保存按钮上方而不是保存后。
   * 能算出来是因为原矩阵已知：原组合数 − 新组合数就是会被停用的数量
   * （已被停用过的 SKU 不重复计数）。
   */
  const willDeactivate = useMemo(() => {
    const originalCount = specs.reduce((product, spec) => {
      const values = new Set(spec.values.map((v) => v.value.trim()).filter((v) => v !== ''));
      return product * values.size;
    }, 1);
    return Math.max(0, originalCount - skuCount);
  }, [specs, skuCount]);

  function updateSpec(key: string, patch: Partial<Omit<DraftSpec, 'key'>>) {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
    setMessage(null);
  }

  function updateValue(specKey: string, valueKey: string, text: string) {
    setDrafts((current) =>
      current.map((draft) =>
        draft.key === specKey
          ? {
              ...draft,
              values: draft.values.map((value) =>
                value.key === valueKey ? { ...value, text } : value,
              ),
            }
          : draft,
      ),
    );
    setMessage(null);
  }

  function addSpec() {
    if (drafts.length >= MAX_SPECS) {
      setMessage({ tone: 'error', text: `规格维度最多 ${MAX_SPECS} 个` });
      return;
    }
    setDrafts((current) => [...current, { key: nextKey('spec'), name: '', values: [] }]);
    setMessage(null);
  }

  function removeSpec(key: string) {
    setDrafts((current) => current.filter((draft) => draft.key !== key));
    setMessage(null);
  }

  function addValue(specKey: string) {
    let failed = false;
    setDrafts((current) =>
      current.map((draft) => {
        if (draft.key !== specKey) return draft;
        if (draft.values.length >= MAX_VALUES) {
          failed = true;
          return draft;
        }
        return { ...draft, values: [...draft.values, { key: nextKey('value'), text: '' }] };
      }),
    );
    setMessage(
      failed
        ? { tone: 'error', text: `每个规格维度最多 ${MAX_VALUES} 个取值` }
        : null,
    );
  }

  function removeValue(specKey: string, valueKey: string) {
    setDrafts((current) =>
      current.map((draft) =>
        draft.key === specKey
          ? { ...draft, values: draft.values.filter((value) => value.key !== valueKey) }
          : draft,
      ),
    );
    setMessage(null);
  }

  async function save() {
    if (normalized.length === 0) {
      setMessage({
        tone: 'error',
        text: '至少需要一个填写完整的规格维度（名称 + 至少一个取值）',
      });
      return;
    }
    if (duplicateSpecNames.length > 0) {
      setMessage({
        tone: 'error',
        text: `规格维度名称不能重复：${duplicateSpecNames.join('、')}`,
      });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/products/${productId}/specs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: currentVersion,
          // 去重后的形状，且**不带 id**：后端按文本匹配现有规格值。
          specs: normalized.map((spec, index) => ({
            name: spec.name,
            values: spec.values.map((value) => ({ value })),
            sort: index,
          })),
        }),
      });

      if (!response.ok) {
        if (response.status === 409) {
          // 不静默重试：乐观锁冲突意味着别人刚保存过，
          // 拿我们这份过期结构重试会覆盖掉他的修改。
          throw new Error('商品已被他人修改，请刷新页面后重试');
        }
        throw new Error((await readResponse(response, '保存失败')) ?? '保存失败');
      }

      const payload = (await response.json()) as { version?: number };
      if (typeof payload.version === 'number') {
        // 后端每次替换都 +1，不更新的话下一次保存必然 409。
        setCurrentVersion(payload.version);
      }
      setMessage({ tone: 'ok', text: '规格已保存' });
      // 让页面上的其余部分跟上：规格/SKU 列表与商品的最低价都可能已经变了。
      router.refresh();
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : '保存失败',
      });
    } finally {
      setBusy(false);
    }
  }

  const atSpecLimit = drafts.length >= MAX_SPECS;

  return (
    <section className="flex flex-col gap-4 rounded-md border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">规格矩阵</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={addSpec}
            disabled={busy || atSpecLimit}
            title={atSpecLimit ? `规格维度最多 ${MAX_SPECS} 个` : undefined}
            className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
          >
            添加规格维度
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
          >
            {busy ? '保存中…' : '保存规格'}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        最多 {MAX_SPECS} 个维度，每个维度最多 {MAX_VALUES} 个取值。
        保存后系统按组合生成 SKU，新生成的 SKU 售价为 0，需要到下方「SKU 价格表」逐条定价。
      </p>

      {drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          这个商品还没有规格。添加一个维度并录入取值，保存后就会自动生成 SKU。
        </p>
      )}

      {drafts.map((draft, index) => {
        const textCount = dedupeTexts(draft.values).length;
        return (
          <fieldset key={draft.key} className="flex flex-col gap-2 rounded-md border p-3">
            <legend className="px-1 text-xs text-muted-foreground">规格 {index + 1}</legend>

            <div className="flex items-center gap-2">
              <input
                value={draft.name}
                onChange={(event) => updateSpec(draft.key, { name: event.target.value })}
                maxLength={MAX_TEXT_LENGTH}
                placeholder="维度名称，例如「颜色」"
                className="w-40 rounded-md border px-2 py-1 text-sm"
              />
              <span className="text-xs text-muted-foreground">
                {textCount} / {MAX_VALUES} 个取值
              </span>
              <button
                type="button"
                onClick={() => removeSpec(draft.key)}
                disabled={busy}
                className="ml-auto rounded-md border px-2 py-1 text-xs text-destructive disabled:opacity-40"
              >
                删除维度
              </button>
            </div>

            <div className="flex flex-col gap-1">
              {draft.values.map((value) => (
                <div key={value.key} className="flex items-center gap-2">
                  <input
                    value={value.text}
                    onChange={(event) =>
                      updateValue(draft.key, value.key, event.target.value)
                    }
                    maxLength={MAX_TEXT_LENGTH}
                    placeholder="取值，例如「黑色」"
                    className="w-40 rounded-md border px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeValue(draft.key, value.key)}
                    disabled={busy}
                    className="rounded-md border px-2 py-1 text-xs text-destructive disabled:opacity-40"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => addValue(draft.key)}
              disabled={busy || draft.values.length >= MAX_VALUES}
              title={
                draft.values.length >= MAX_VALUES
                  ? `每个规格维度最多 ${MAX_VALUES} 个取值`
                  : undefined
              }
              className="self-start rounded-md border px-2 py-1 text-xs disabled:opacity-40"
            >
              添加取值
            </button>
          </fieldset>
        );
      })}

      <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-3 text-xs">
        <p>
          笛卡尔积预览：<span className="font-medium">{skuCount}</span> 个 SKU 组合
        </p>
        {duplicateSpecNames.length > 0 && (
          <p className="text-destructive">
            ⚠️ 规格维度名称重复：{duplicateSpecNames.join('、')}——保存会被拒绝，请改成不同的名称。
          </p>
        )}
        {duplicateGroups.length > 0 && (
          <p className="text-muted-foreground">
            重复取值（保存时会自动合并）：
            {duplicateGroups.join('、')}
          </p>
        )}
        {willDeactivate > 0 && (
          <p className="text-destructive">
            ⚠️ 保存后有 {willDeactivate} 个多余的 SKU 会被停用（置为「已停用」并从售价、
            库存与前台展示中排除）。它们不会被删除，取值加回来后可以重新启用。
          </p>
        )}
      </div>

      {message && (
        <p
          role="status"
          className={
            message.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'
          }
        >
          {message.text}
        </p>
      )}
    </section>
  );
}