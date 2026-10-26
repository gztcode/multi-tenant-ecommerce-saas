'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { percentToBps, type Plan } from '@/lib/billing';
import { yuanToCents } from '@/lib/money';

/**
 * 套餐的**写操作都在这里**（新建 / 编辑 / 下架）。
 *
 * ⚠️ **为什么三个组件放在同一个文件**：它们共享同一套「提交 → 刷新」
 * 的机制（`run()` + `busyRef` 闸门 + `router.refresh()`），拆成三个文件
 * 就要把机制复制三份，迟早有一份的闸门漏了。
 *
 * ⚠️ **所有写操作都走同源的 `/api/**` 中转**（不是直连后端）：
 * 后端没开 CORS，而且 accessToken 不该进客户端代码。
 * 中转路由在服务端用 `auth()` 取 token，并**按白名单重建请求体**。
 *
 * ⚠️ **金额一律整数分、费率一律基点**（后端的约定）：
 * 「元 → 分」用 `yuanToCents`、「% → 基点」用 `percentToBps`，
 * **换算只在表单的边界做**（提交前一刻），提交给后端的一律是整数。
 *
 * ⚠️ **props 里只有可序列化的数据**：`plan` 对象、字符串、数字。
 * Server → Client 传函数在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500（阶段 2b 踩过）。所以回调一律在
 * 组件内部自己实现。
 */

/** 统一的失败文案前缀 */
const FAILURE_TEXT = '操作失败';

/**
 * 读取中转路由的错误体。
 *
 * ⚠️ **先判断 `response.ok` 再决定要不要解析**：下架走的是 DELETE，
 * 中转返回 **204 无内容**，对 204 调 `response.json()` 会抛
 * 「body 已消费」——错误提示会变成一句看不懂的解析失败。
 */
async function readFailure(
  response: Response,
  fallback: string,
): Promise<string | null> {
  if (response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  return payload.message ?? fallback;
}

/**
 * 新建 / 编辑套餐的表单。
 *
 * ⚠️ **新建与编辑是同一个组件**（`plan` 为空即新建）：
 * 字段完全一样，提交地址与方法不同而已。拆成两个组件就要把十来个字段
 * 的初始值逻辑复制一遍，改一个字段忘了另一个就会漂移。
 */
export function PlanForm({ plan }: { plan?: Plan }) {
  const router = useRouter();
  const editing = Boolean(plan);
  // ⚠️ **把 id 单独取出来**：闭包里 TypeScript 没法从 `editing` 反推
  // `plan` 一定存在（`editing` 是布尔，不是类型守卫）。
  const planId = plan?.id;

  const [code, setCode] = useState(plan?.code ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  // ⚠️ **金额与费率的初值要反向换算成「用户看得懂的单位」**：
  // 库里是分（整数）与基点，界面上是「元」与「%」。
  const [price, setPrice] = useState(
    plan ? (plan.price / 100).toFixed(2) : '',
  );
  const [periodDays, setPeriodDays] = useState(String(plan?.periodDays ?? '30'));
  const [trialDays, setTrialDays] = useState(String(plan?.trialDays ?? '0'));
  const [commission, setCommission] = useState(
    plan ? String(plan.commissionBps / 100) : '0',
  );
  const [maxProducts, setMaxProducts] = useState(
    plan?.maxProducts === null || plan?.maxProducts === undefined
      ? ''
      : String(plan.maxProducts),
  );
  const [maxSkus, setMaxSkus] = useState(
    plan?.maxSkus === null || plan?.maxSkus === undefined
      ? ''
      : String(plan.maxSkus),
  );
  const [maxStores, setMaxStores] = useState(
    plan?.maxStores === null || plan?.maxStores === undefined
      ? ''
      : String(plan.maxStores),
  );
  const [marketing, setMarketing] = useState(
    plan?.features?.marketing === true,
  );

  /** 成功提示与失败提示**分开显示：灰色的错误提示和成功提示长得一样，
   * 超管会误以为操作成功了。 */
  const [success, setSuccess] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * ⚠️ **闸门读的是 ref 不是 state**：state 同一 tick 内还是旧值，
   * 连点两次会一起通过检查发出两次请求（重复建套餐）。ref 是同步写的。
   */
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // ⚠️ **同一个 tick 内的第二次点击直接返回**（防止重复提交）。
    if (busyRef.current) return;

    setSuccess(null);
    setFailure(null);

    // ---- 校验：全部在提交之前做完 ----
    // ⚠️ **校验不通过就不发请求**：让后端 400 再把错误转述回来，
    // 界面上只剩一句没头没尾的「校验失败」。
    const trimmedCode = code.trim();
    if (trimmedCode === '') {
      setFailure('套餐代码不能为空');
      return;
    }
    const trimmedName = name.trim();
    if (trimmedName === '') {
      setFailure('套餐名称不能为空');
      return;
    }

    const priceCents = yuanToCents(price);
    if (priceCents === null) {
      setFailure('周期价格必须是不超过两位小数的非负数（单位：元）');
      return;
    }

    const period = Number(periodDays);
    if (!Number.isInteger(period) || period < 1 || period > 365) {
      setFailure('订阅周期必须是 1 到 365 之间的整数（单位：天）');
      return;
    }

    const trial = Number(trialDays);
    if (!Number.isInteger(trial) || trial < 0 || trial > 365) {
      setFailure('试用期必须是 0 到 365 之间的整数（单位：天）');
      return;
    }

    const commissionBps = percentToBps(commission);
    if (commissionBps === null) {
      setFailure('抽佣比例必须是不超过两位小数的非负数（单位：%）');
      return;
    }

    const products = parseOptionalLimit(maxProducts, 0, '商品数上限');
    if (products.error) {
      setFailure(products.error);
      return;
    }
    const skus = parseOptionalLimit(maxSkus, 0, 'SKU 数上限');
    if (skus.error) {
      setFailure(skus.error);
      return;
    }
    const stores = parseOptionalLimit(maxStores, 1, '店铺数上限');
    if (stores.error) {
      setFailure(stores.error);
      return;
    }

    // ---- 组装请求体 ----
    // ⚠️ **只放该放的键**：`status` / `sortOrder` / `tenantId` 都不在
    // 请求体里——上下架走专门的 DELETE，套餐是平台的数据不带 tenantId。
    const body: Record<string, unknown> = {
      code: trimmedCode,
      name: trimmedName,
      price: priceCents,
      periodDays: period,
      trialDays: trial,
      commissionBps,
    };
    // ⚠️ **说明留空 = 显式传 null**：新建时等于「没有说明」，编辑时等于
    // **清空说明**。不传这个键 = 不改 —— 超管清不掉旧说明，
    // 而界面上却显示「保存成功」，那是最坏的形态（假装成功）。
    // 中转白名单与后端 update() 都已支持 description: null。
    //
    // ⚠️ **传 null 而不是空串**：空串会被写成「空字符串」而不是「没有说明」。
    const trimmedDescription = description.trim();
    body.description = trimmedDescription === '' ? null : trimmedDescription;
    // ⚠️ **额度留空 = 显式传 null（= 不限）**，不是「不放这个键」。
    //
    // 「不传 = 不改」这条规则在这里用不了：表单的额度字段是**预填**的
    // （初值来自 `plan.maxProducts` 等），超管没碰过的字段带着原值
    // （100 就还是 100，null 就还是空），**不存在「没碰过却被清成不限」**。
    // 而反过来：**不放这个键的话，超管就没法把额度改回「不限」**——
    // 编辑页少了「清空」这个手段，「留空 = 不限」的提示就成了空话。
    //
    // 「不传 = 不改」对应的是「不改」这个选项，而表单里没有这个选项：
    // 留空就是超管**明确**表达「这条要不限」。
    body.maxProducts = products.value;
    body.maxSkus = skus.value;
    body.maxStores = stores.value;
    // ⚠️ **不勾选营销工具时整个 `features` 键都不放**（不是
    // `features: { marketing: false }`）——后端的语义是「缺省一律视为
    // false」，缺键与显式 false 等价，但缺键不会在日志里留下噪声，
    // 也不会让「这个键到底是没配还是配成 false」变得分不清。
    if (marketing) {
      body.features = { marketing: true };
    }

    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch(
        editing ? `/api/billing/plans/${planId}` : '/api/billing/plans',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      setSuccess(editing ? '套餐已更新' : '套餐已创建');
      // ⚠️ **成功后必须 router.refresh()**：套餐列表是服务端渲染的，
      // 本组件不持有列表的副本，不刷新就看不到新套餐。
      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? '编辑套餐' : '新建套餐'}</CardTitle>
        <CardDescription>
          金额按「元」填写、费率按「%」填写，提交时会自动换算成
          整数分与基点。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-code">代码</Label>
            <Input
              id="plan-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="如 PRO"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-name">名称</Label>
            <Input
              id="plan-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="如 专业版"
            />
          </div>

          <div className="flex flex-col gap-1">
            {/* ⚠️ **说明的「留空」与额度的「留空」不是一回事**：
                额度留空 = 不限（本来就有的意思），说明留空 = **清空说明**
                （把已有的值抹掉）。文案上必须区分开，否则超管会以为
                「留空」只是「不填」。 */}
            <Label htmlFor="plan-description">说明（留空 = 清空说明）</Label>
            <Input
              id="plan-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="留空表示不填"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-price">周期价格（元）</Label>
            {/* ⚠️ **用 text 而不是 number**：`<input type="number">` 会把
                非法字符**直接吞掉**（敲「abc」框里还是空的），
                于是「金额填错了」这件事根本表达不出来，
                用户只会看到一个空框。而 `yuanToCents` 是按「串」设计的，
                输入框里原样保留用户敲的内容、提交时再校验，
                报错才说得清「哪里填错了」。
                `inputMode="decimal"` 让手机端仍然弹数字键盘。 */}
            <Input
              id="plan-price"
              type="text"
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="如 99.00"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-period">订阅周期（天）</Label>
            <Input
              id="plan-period"
              type="number"
              step="1"
              min="1"
              max="365"
              value={periodDays}
              onChange={(event) => setPeriodDays(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-trial">试用期（天）</Label>
            <Input
              id="plan-trial"
              type="number"
              step="1"
              min="0"
              max="365"
              value={trialDays}
              onChange={(event) => setTrialDays(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-commission">抽佣比例（%）</Label>
            {/* ⚠️ **同样是 text**：理由与价格一样——「费率填错了」要能表达出来。 */}
            <Input
              id="plan-commission"
              type="text"
              inputMode="decimal"
              value={commission}
              onChange={(event) => setCommission(event.target.value)}
              placeholder="如 5"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-max-products">商品数上限（留空 = 不限）</Label>
            <Input
              id="plan-max-products"
              type="number"
              step="1"
              min="0"
              value={maxProducts}
              onChange={(event) => setMaxProducts(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-max-skus">SKU 数上限（留空 = 不限）</Label>
            <Input
              id="plan-max-skus"
              type="number"
              step="1"
              min="0"
              value={maxSkus}
              onChange={(event) => setMaxSkus(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-max-stores">店铺数上限（留空 = 不限）</Label>
            <Input
              id="plan-max-stores"
              type="number"
              step="1"
              min="1"
              value={maxStores}
              onChange={(event) => setMaxStores(event.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            {/* ⚠️ **这里只有一个功能开关**：后端目前只有
                `FEATURE_MARKETING = 'marketing'`（见 api 的
                `quota.service.ts`）。加第二个开关之前，这里也只有 marketing。 */}
            <input
              id="plan-marketing"
              type="checkbox"
              checked={marketing}
              onChange={(event) => setMarketing(event.target.checked)}
            />
            <Label htmlFor="plan-marketing">营销工具</Label>
          </div>

          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          {success && (
            <p role="status" className="text-sm text-primary">
              {success}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              {busy ? '提交中…' : editing ? '保存' : '创建'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * 下架套餐的按钮。
 *
 * ⚠️ **下架是不可逆的**（后端只有下架、没有上架接口），
 * 所以点击前必须 `confirm()` 确认，确认文案里带上套餐名 ——
 * 列表里一屏好几个套餐，只写「确定吗？」超管会点错。
 */
export function PlanDisableButton({
  planId,
  planName,
}: {
  planId: string;
  planName: string;
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function handleDisable() {
    if (
      !confirm(
        `确定下架套餐「${planName}」？下架后商家不能再订阅它，且**无法重新上架**。`,
      )
    ) {
      return;
    }
    if (busyRef.current) return;

    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/billing/plans/${planId}`, {
        method: 'DELETE',
      });
      // ⚠️ **下架返回 204 无内容**：不能无条件去 `response.json()`，
      // 否则会抛「body 已消费」，成功的事被报成失败。
      const problem = await readFailure(response, '下架失败');
      if (problem) throw new Error(problem);

      // 列表是服务端渲染的，不刷新就还是旧的那一行。
      router.refresh();
    } catch (cause) {
      setFailure(
        `下架失败：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={busy}
        onClick={handleDisable}
      >
        {busy ? '下架中…' : '下架'}
      </Button>
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * 解析「可选的整数上限」。
 *
 * ⚠️ **留空 = 不限**：返回 `value: null`，调用方据此**显式传 null**
 * （null = 改成不限；不传 = 不改）。
 *
 * ⚠️ **为什么这次可以传 null**：额度字段是**预填**的（初值来自套餐当前的值），
 * 超管没碰过的字段带着原值（100 就还是 100，null 就还是空），
 * **不存在「没碰过却被清成不限」的情况**。而如果留空就不传这个键，
 * 超管就**没法把额度改回「不限」**——编辑页少了「清空」这个手段，
 * 字段旁边的「留空 = 不限」提示就成了空话。
 *
 * 这里只处理「用户填了但填错」的情况。
 */
function parseOptionalLimit(
  raw: string,
  min: number,
  label: string,
): { value: number | null; error?: undefined } | { value?: undefined; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { value: null };
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < min) {
    return { error: `${label}必须是大于等于 ${min} 的整数（留空表示不限）` };
  }
  return { value: parsed };
}
