import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * 批量确认 CSV 来源 A 类差异的入参（阶段 6a Task 7）。
 *
 * 两种模式：
 * - `IDS`：勾选当前列表。`itemIds` 上限 200 且去重，`note` 1–200 字；
 * - `FILTER`：全选筛选结果。服务端按固定条件 + 游标一次取一批，
 *   客户端循环调用直到 `nextCursor = null`。
 *
 * ⚠️ **用 `@ValidateIf` 做「按模式校验」** —— `itemIds` 只在 `IDS` 时可传、
 *    `cursor` / `limit` 只在 `FILTER` 时可传；否则 `FILTER` 请求会被
 *    「缺少 itemIds」莫名拒掉。
 * ⚠️ **全局 `ValidationPipe` 开了 `forbidNonWhitelisted`** —— 本 DTO 声明了
 *    哪些字段，就只能传哪些字段，多一个直接 400。
 */
export class BatchConfirmReconciliationDto {
  /** 批量确认模式 */
  @IsIn(['IDS', 'FILTER'])
  mode!: 'IDS' | 'FILTER';

  /** `IDS` 模式：勾选的差异项 id（1–200 条，去重） */
  @ValidateIf((dto: BatchConfirmReconciliationDto) => dto.mode === 'IDS')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  itemIds?: string[];

  /** `FILTER` 模式：上一批返回的游标（第一批不传） */
  @ValidateIf((dto: BatchConfirmReconciliationDto) => dto.mode === 'FILTER')
  @IsOptional()
  @IsUUID('4')
  cursor?: string;

  /** `FILTER` 模式：单批条数（1–200，默认 200） */
  @ValidateIf((dto: BatchConfirmReconciliationDto) => dto.mode === 'FILTER')
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** 统一确认说明（会进每条出款的操作留痕） */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  note!: string;
}
