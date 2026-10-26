/**
 * 套餐请求体的**白名单重建**。
 *
 * ⚠️ **为什么单独成文件**：创建（POST）与修改（PATCH）两条路由用的是
 * **同一套白名单与校验规则**。规则写两份必然漂移——改了一处忘了另一处，
 * 于是「创建时 price 必须是整数分、修改时能传小数」这种诡异的不一致
 * 就出现了，而它只会在生产上炸。
 *
 * ⚠️ **白名单纪律**：请求体**按白名单重建**，不整体透传。
 * 整体透传等于把「哪些字段可以写」的判断交给后端的 forbidNonWhitelisted——
 * 后端 DTO 哪天加了个字段，它就会静默变成客户端可写。
 */

/**
 * 校验套餐的字段，返回**按白名单重建过的 body**；不合法返回错误信息。
 *
 * ⚠️ **返回值是重建后的 body**（而不是「校验通过就放行原 body」）：
 * 重建发生在同一个函数里，客户端多传的字段不可能有机会溜进去。
 *
 * @param payload 客户端传来的原始 body
 * @param partial `true` = PATCH（全部可选，只放行给了的字段）；
 *                 `false` = POST（必填项缺一个就报错）
 */
export function buildPlanBody(
  payload: Record<string, unknown>,
  partial: boolean,
): { body: Record<string, unknown> } | { error: string } {
  const body: Record<string, unknown> = {};

  // ---- code ----
  if (payload.code !== undefined || !partial) {
    if (typeof payload.code !== 'string' || payload.code.trim() === '') {
      return { error: '套餐代码必须是非空字符串' };
    }
    // ⚠️ **长度上限逐字对齐后端 DTO 的 `@MaxLength(64)`**：
    // 前端只校验「非空字符串」的话，超长的值前端放行、后端 400，
    // 界面上只剩一句没头没尾的校验失败。
    if (payload.code.trim().length > 64) {
      return { error: '套餐代码不能超过 64 个字符' };
    }
    body.code = payload.code.trim();
  }

  // ---- name ----
  if (payload.name !== undefined || !partial) {
    if (typeof payload.name !== 'string' || payload.name.trim() === '') {
      return { error: '套餐名称必须是非空字符串' };
    }
    // ⚠️ **长度上限逐字对齐后端 DTO 的 `@MaxLength(100)`**（同上）。
    if (payload.name.trim().length > 100) {
      return { error: '套餐名称不能超过 100 个字符' };
    }
    body.name = payload.name.trim();
  }

  // ---- description（可选，允许 null） ----
  // ⚠️ **允许 null**：后端 DTO 的 `description` 是 `String?`，而
  // class-validator 的 `@IsOptional()` 是「`value !== null && value !== undefined`」
  // —— **null 直接跳过校验**，是合法的。后端 `plan.service.ts` 的
  // `if (dto.description !== undefined) data.description = dto.description`
  // 能把 null 写进去 = **清空说明**。前端把 null 挡掉的话，
  // 编辑页就**没法清空套餐说明**。
  if (payload.description !== undefined) {
    if (
      payload.description !== null &&
      typeof payload.description !== 'string'
    ) {
      return { error: '套餐说明必须是字符串或 null' };
    }
    // ⚠️ **长度上限逐字对齐后端 DTO 的 `@MaxLength(500)`**（同上）。
    if (
      typeof payload.description === 'string' &&
      payload.description.length > 500
    ) {
      return { error: '套餐说明不能超过 500 个字符' };
    }
    body.description = payload.description;
  }

  // ---- price ----
  // ⚠️ **金额一律整数分**：浮点金额从这里就断掉源头。
  if (payload.price !== undefined || !partial) {
    if (!isIntegerInRange(payload.price, 0, 100_000_000)) {
      return { error: '周期价格必须是不小于 0 的整数（单位：分）' };
    }
    body.price = payload.price;
  }

  // ---- periodDays ----
  if (payload.periodDays !== undefined || !partial) {
    if (!isIntegerInRange(payload.periodDays, 1, 365)) {
      return { error: '订阅周期必须是 1 到 365 之间的整数（单位：天）' };
    }
    body.periodDays = payload.periodDays;
  }

  // ---- trialDays（可选） ----
  if (payload.trialDays !== undefined) {
    if (!isIntegerInRange(payload.trialDays, 0, 365)) {
      return { error: '试用期必须是 0 到 365 之间的整数（单位：天）' };
    }
    body.trialDays = payload.trialDays;
  }

  // ---- commissionBps ----
  if (payload.commissionBps !== undefined || !partial) {
    if (!isIntegerInRange(payload.commissionBps, 0, 10_000)) {
      return { error: '抽佣比例必须是 0 到 10000 之间的整数（单位：基点）' };
    }
    body.commissionBps = payload.commissionBps;
  }

  // ---- maxProducts / maxSkus（可选，null = 不限） ----
  // ⚠️ **`null` 的语义是「改成不限」**，与后端的可空列一致
  // （`maxProducts?: number` + `@IsOptional()`，写进库的是 null）。
  // 与「不传这个字段」不同：不传 = 不改，传 null = 清空上限。
  for (const key of ['maxProducts', 'maxSkus'] as const) {
    const value = payload[key];
    if (value === undefined) continue;
    if (value !== null && !isIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER)) {
      return { error: `${key} 必须是大于等于 0 的整数` };
    }
    body[key] = value;
  }

  // ---- maxStores（可选，后端 DTO 是 @Min(1)） ----
  // ⚠️ **同样是 `null` = 改成「不限」**（与 maxProducts / maxSkus 一致）。
  if (payload.maxStores !== undefined) {
    const value = payload.maxStores;
    if (value !== null && !isIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER)) {
      return { error: 'maxStores 必须是大于等于 1 的整数' };
    }
    body.maxStores = value;
  }

  // ---- features（可选，必须是「每个值都是布尔」的对象） ----
  if (payload.features !== undefined) {
    const features = payload.features;
    if (
      typeof features !== 'object' ||
      features === null ||
      Array.isArray(features)
    ) {
      return { error: '功能开关必须是对象' };
    }
    for (const [key, value] of Object.entries(features)) {
      // ⚠️ **功能开关是开/关**：收到字符串 / 数字一律 400，
      // 不能「顺手转成布尔」——那是在猜客户端的意思。
      if (typeof value !== 'boolean') {
        return { error: `功能开关 ${key} 的值必须是布尔` };
      }
    }
    body.features = features;
  }

  return { body };
}

/** 整数且落在 [min, max] 区间内 */
function isIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}
