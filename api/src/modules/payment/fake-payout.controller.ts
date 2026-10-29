import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  FakePayoutProvider,
  isFakePayoutEnabled,
} from './fake-payout.provider';

/**
 * 假出款网关的控制端。
 *
 * ⚠️ **与假支付网关的形态不同**：假支付网关有「支付页面 + 确认支付」，
 *    因为收钱是**用户点一下**触发的。而打款是 **worker 自动调渠道**，
 *    没有「用户点一下」这个环节 → **没有「确认打款」端点**。
 *
 * ⚠️ **唯一需要暴露的是「模拟失败」** —— 它是测「失败 → 重试 → FAILED」
 *    这条链路的开关。
 *
 * ⚠️ **必须限平台超管**（`@Roles(UserRole.PLATFORM_ADMIN)`）：
 *    这个开关能让「打款失败」→ 攻击者可以让商家出不了款。
 *    假支付网关的端点是无需登录的（因为 `FAKE_PAYMENT_ENABLED` 默认关闭），
 *    但**打款失败的后果更严重**，这里不做同样的取舍 ——
 *    平台超管本来就要登录才能审批，多这一次校验没有成本。
 *
 * ⚠️ **开关没开 → 404**（与假支付网关一致）：
 *    「这里没这个接口」比「存在但不许用」更不容易被扫到。
 *
 * ⚠️ **路由前缀是 `pay/fake-payout` 而不是 `pay/fake/payouts`** ——
 *    假支付网关占着 `pay/fake/:paymentId` 这个参数路由，Express 按注册顺序匹配，
 *    将来在 `pay/fake/` 下加任何 `:param` 形式的路由都会跟它撞车。
 *    换个不共前缀的路径就彻底避开。
 */
@ApiTags('fake-payout')
@Controller('pay/fake-payout')
@Roles(UserRole.PLATFORM_ADMIN)
export class FakePayoutController {
  constructor(private readonly fake: FakePayoutProvider) {}

  @Post('fail-next')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '假出款网关：设定接下来 N 次打款的剧本（仅本地开发）',
  })
  failNext(@Body() body: { times?: number; amountOffset?: number }): {
    remaining: number;
  } {
    if (!isFakePayoutEnabled()) {
      throw new NotFoundException('未知的支付渠道');
    }
    this.fake.armScenario({
      failTimes: body.times ?? 1,
      amountOffset: body.amountOffset ?? 0,
    });
    return { remaining: this.fake.remainingFailures() };
  }
}
