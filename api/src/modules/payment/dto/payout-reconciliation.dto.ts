import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** 手动触发对账的入参 */
export class TriggerReconciliationDto {
  /** 渠道名 */
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  channel!: string;

  /** 窗口起点（含），ISO 字符串 */
  @IsDateString()
  from!: string;

  /** 窗口终点（不含），ISO 字符串 */
  @IsDateString()
  to!: string;
}

/** 对账任务列表的查询参数 */
export class ListReconciliationsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // ⚠️ **`page` 不设上限** —— 它是页码不是每页条数，夹住它会让
  //    100 页之后的数据**永远取不到**（对账任务是只增不减的历史表）。
  //    每页条数才要夹（见 `pageSize`）。
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/** 处置一条差异 */
export class ResolveReconciliationItemDto {
  /**
   * 处置结果。
   *
   * ⚠️ **必须用 `@IsIn`，不能用 `@IsString`** ——
   *    TS 的字面量联合类型在**运行时不存在**，class-validator 不看 TS 类型。
   *    只校验字符串的话，`PENDING` 能被提交 → 这条差异**重新回到「未处置」**
   *    （运营明明处置过了，未处置统计却不降），且 `resolvedAt` 已写上、
   *    状态自相矛盾。写成别的字符串还会撞 PG 的 enum → 冒成 500。
   */
  @IsIn(['RESOLVED', 'IGNORED'])
  resolution!: 'RESOLVED' | 'IGNORED';

  /** 处置说明 */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note!: string;
}

/** B 类人工确认已付款 */
export class ConfirmPaidDto {
  /** 操作原因（会进留痕） */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  /** 关联的对账任务 id（可选） */
  @IsOptional()
  @IsString()
  reconciliationId?: string;
}
