import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { OrderService } from './order.service';
import { GuestLookupThrottleService } from './guest-lookup-throttle.service';
import { GuestOrderLookupDto } from './dto/guest-order-lookup.dto';

/**
 * 游客订单查询端点（阶段 11）。
 *
 * ## 为什么是独立 controller
 *
 * OrderController 在**类级**挂了 `JwtAuthGuard`（必须登录），游客查询
 * 恰恰要匿名——混进去就得逐方法换守卫，容易漏。独立成类，守卫策略
 * 一眼可见（与「为什么消费者/商家分两个 controller」同理）。
 *
 * ## 防爆破
 *
 * 猜 (orderNo, phone) 组合的主要手段是穷举手机号。这里加一道
 * 失败计数：同一 `来源 IP × 订单号` 10 分钟内失败 5 次后熔断，
 * 成功即清零。计数在 Redis 里（见 `GuestLookupThrottleService`）。
 *
 * ### 来源 IP 必须可信（这一步单独修过一次）
 *
 * 防爆破按「来源 IP」隔离的前提是**这个 IP 是真的**。api 隔着网关与
 * BFF，Express 默认完全不采信 `x-forwarded-for`，`req.ip` 恒等于
 * TCP 对端地址——生产上就是网关 / BFF 容器的 IP，所有来源共用一个
 * 计数桶，**一个坏客户端就能把真实客户的查单入口锁死 10 分钟**。
 * 现在 api 只信任一跳代理（`app.module.ts` 的 `onModuleInit`），
 * 取的是代理层追加在**最右**的真实对端，客户端伪造的左端值无效。
 *
 * ### 为什么不再是进程内 Map
 *
 * 进程内 Map 有两个问题：多副本部署时各副本各数各的（挡不住分布式
 * 穷举），而且未认证端点上的无界容器就是内存泄漏入口
 * （issue #35 曾用「时间上界 + 容量上界」两条兜底）。迁到 Redis 后
 * 过期由 TTL 负责、条目数由 Redis 管，两条上界都自动成立，
 * `GUEST_LOOKUP_MAX_ATTEMPT_ENTRIES` 这个环境变量随之失效。
 *
 * ## 泄露面控制
 *
 * service 层只返回最小投影（无姓名/电话/地址），404 与 403 的措辞
 * 统一为「订单不存在或信息不匹配」——不给爆破者任何区分信号。
 */
@ApiTags('orders')
@Controller('orders')
export class GuestOrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly throttle: GuestLookupThrottleService,
  ) {}

  @Post('guest-lookup')
  @Public()
  @ApiOperation({ summary: '游客订单查询（订单号 + 收货手机号）' })
  async lookup(
    @Body() dto: GuestOrderLookupDto,
    @Req() request: Request,
  ): Promise<{
    orderNo: string;
    status: string;
    totalAmount: number;
    itemCount: number;
    createdAt: Date;
    paidAt: Date | null;
  }> {
    const ip = request.ip;
    if (await this.throttle.isBlocked(ip, dto.orderNo)) {
      throw new HttpException(
        '尝试次数过多，请 10 分钟后再试',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const order = await this.orderService.guestLookup(dto.orderNo, dto.phone);
    if (!order) {
      await this.throttle.recordFailure(ip, dto.orderNo);
      // ⚠️ 404 与「订单不属于该手机号」同措辞——不给爆破者区分信号
      throw new NotFoundException('订单不存在或信息不匹配');
    }
    await this.throttle.reset(ip, dto.orderNo);
    return order;
  }
}
