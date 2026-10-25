import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { CouponStatus } from '@prisma/client';
import { CreateCouponDto } from './create-coupon.dto';

/**
 * 修改优惠券。
 *
 * `CreateCouponDto` 的全 Partial 版本（NestJS 的 PartialType）。
 *
 * ⚠️ **`scope` 依然不在这里**（M7）：作用域是创建时定下的身份属性，
 * 不是能改的业务字段——改了就等于「先发店铺券，再改成平台券」，
 * 那正是 M7 要堵的越权路径。
 *
 * ⚠️ **计数与 `type` 也不在**：计数是服务端的账，`type` 本阶段固定 FIXED。
 *
 * ⚠️ **`status` 只允许 ACTIVE / PAUSED**：`EXPIRED` 是系统在券过期时
 * 算出来的展示态，本阶段的过期判定靠 `endsAt` 不靠 `status`，
 * 客户端设了也没意义。
 */
export class UpdateCouponDto extends PartialType(CreateCouponDto) {
  @ApiProperty({
    required: false,
    enum: [CouponStatus.ACTIVE, CouponStatus.PAUSED],
    description: '启用 / 暂停',
  })
  @IsOptional()
  @IsEnum(CouponStatus)
  status?: CouponStatus;
}
