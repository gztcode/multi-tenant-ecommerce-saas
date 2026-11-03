import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * CSV 账单导入的入参。
 *
 * ⚠️ **列映射走 JSON 字符串** —— multipart 的 body 部分是字符串，
 *    Nest 的 ValidationPipe 对 `Object` 类型的 metatype 会**跳过校验**，
 *    所以这里声明成 `string` 并在服务层自己 `JSON.parse` + 逐项校验。
 */
export class ImportReconciliationDto {
  /** 列映射（JSON 字符串） */
  @IsString()
  @MinLength(2)
  columnMapping!: string;

  /** 渠道名（选填，默认 `fake-payout`） */
  @IsOptional()
  @IsString()
  @MinLength(1)
  // ⚠️ **长度上限与平台设置一致**：渠道名会原样落进对账任务行的 `channel`，
  //    前端下拉最长 40；超长值只可能是手工构造 / 脏数据。
  @MaxLength(40)
  channel?: string;

  /**
   * 时间窗起点（含，ISO 字符串）
   *
   * ⚠️ **必须用 `@IsDateString`，不能只校验字符串** ——
   *    `new Date('abc')` 得 Invalid Date，而 `assertWindow` 的三道闸
   *    全是 `Date.getTime()` 的比较 → **NaN 比较一律为假 → 全部放行**
   *    → 一路传到 Prisma 冒成 500，而不是 400。
   *    （`TriggerReconciliationDto` 早就用了 `@IsDateString`，
   *    这里漏了 —— 同一个时间窗概念，两处校验口径必须一致。）
   */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** 时间窗终点（不含，ISO 字符串） */
  @IsOptional()
  @IsDateString()
  to?: string;
}
