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
import { GuestOrderLookupDto } from './dto/guest-order-lookup.dto';

/** 每个客户端对每个订单号的最大连续失败次数 */
const MAX_ATTEMPTS = 5;

/** 失败计数窗口（毫秒） */
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

interface AttemptRecord {
  count: number;
  firstAt: number;
}

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
 * 进程内的失败计数：同一 `IP × 订单号` 10 分钟内失败 5 次后熔断，
 * 成功即清零。**没有用 Redis**：这是低价值目标（查询不产生副作用），
 * 多副本部署时各副本独立计数，防爆破强度略降但可接受——
 * 真正的兜底是网关层 limit_req（阶段 11 已加）。
 *
 * ## 泄露面控制
 *
 * service 层只返回最小投影（无姓名/电话/地址），404 与 403 的措辞
 * 统一为「订单不存在或信息不匹配」——不给爆破者任何区分信号。
 */
@ApiTags('orders')
@Controller('orders')
export class GuestOrderController {
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(private readonly orderService: OrderService) {}

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
    const key = `${request.ip ?? 'unknown'}:${dto.orderNo}`;
    if (this.isBlocked(key)) {
      throw new HttpException(
        '尝试次数过多，请 10 分钟后再试',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const order = await this.orderService.guestLookup(dto.orderNo, dto.phone);
    if (!order) {
      this.recordFailure(key);
      // ⚠️ 404 与「订单不属于该手机号」同措辞——不给爆破者区分信号
      throw new NotFoundException('订单不存在或信息不匹配');
    }
    this.attempts.delete(key);
    return order;
  }

  private isBlocked(key: string): boolean {
    const record = this.attempts.get(key);
    if (!record) return false;
    if (Date.now() - record.firstAt > ATTEMPT_WINDOW_MS) {
      this.attempts.delete(key);
      return false;
    }
    return record.count >= MAX_ATTEMPTS;
  }

  private recordFailure(key: string): void {
    const now = Date.now();
    const record = this.attempts.get(key);
    if (!record || now - record.firstAt > ATTEMPT_WINDOW_MS) {
      this.attempts.set(key, { count: 1, firstAt: now });
      return;
    }
    record.count += 1;
  }
}
