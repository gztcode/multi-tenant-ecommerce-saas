import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 库存汇总的查询参数。
 *
 * ⚠️ **`productId` 必须在这里声明为必填**，不能像 `movements` 那样
 * 用裸 `@Query('productId')` + 事后判空：
 *
 * 1. 裸参数拿不到校验，缺参时 `productId` 是 `undefined`，
 *    而 Prisma 会把 `where: { productId: undefined }` 这个键**整个丢掉** ——
 *    where 退化成无条件查询，返回**该租户下所有 SKU** 的库存。
 *    接口声称「按商品查」，实际却把全店库存倒给调用方。
 * 2. 全局 ValidationPipe 开了 `forbidNonWhitelisted`，
 *    只有类实例 DTO 才会触发校验与白名单剔除。
 */
export class InventorySummaryQueryDto {
  @ApiProperty({ description: '商品 ID（必填）' })
  @IsString()
  @IsNotEmpty()
  productId!: string;
}
