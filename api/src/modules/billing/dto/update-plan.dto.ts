import { PartialType } from '@nestjs/swagger';
import { CreatePlanDto } from './create-plan.dto';

/**
 * 修改套餐。
 *
 * ⚠️ **`PartialType(CreatePlanDto)`**（NestJS 的）—— 与阶段 5a 的
 * `UpdateCouponDto` 同款做法。
 */
export class UpdatePlanDto extends PartialType(CreatePlanDto) {}
