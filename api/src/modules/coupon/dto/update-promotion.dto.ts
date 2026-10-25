import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PromotionStatus } from '@prisma/client';
import { CreatePromotionDto } from './create-promotion.dto';

/**
 * 修改满减活动。
 *
 * `CreatePromotionDto` 的全 Partial 版本。
 *
 * ⚠️ **`status` 只允许 ACTIVE / PAUSED**：`EXPIRED` 是系统在活动过期时
 * 算出来的展示态，本阶段的过期判定靠 `endsAt` 不靠 `status`。
 */
export class UpdatePromotionDto extends PartialType(CreatePromotionDto) {
  @ApiProperty({
    required: false,
    enum: [PromotionStatus.ACTIVE, PromotionStatus.PAUSED],
    description: '启用 / 暂停',
  })
  @IsOptional()
  @IsEnum(PromotionStatus)
  status?: PromotionStatus;
}
