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

/**
 * 失败计数 Map 的容量上限（issue #35）。
 *
 * 未认证端点上的**无界容器**就是内存泄漏的入口：攻击者用不同的 orderNo
 * 持续打请求（每个都查不到 → 每个都记一条失败），条目数就单调增长。
 * 默认 10000 条（约 0.6 MB）——可以忽略，但**必须有**。
 *
 * 可用环境变量 `GUEST_LOOKUP_MAX_ATTEMPT_ENTRIES` 覆盖（测试用小值验证淘汰行为）。
 */
const DEFAULT_MAX_ATTEMPT_ENTRIES = 10000;

/**
 * 读容量上限。非法值（非数字 / 非正数）一律回落到默认值——
 * **绝不让上限变成 0 或 NaN**，那会让防爆破计数直接失效（比内存泄漏更糟）。
 */
function readMaxAttemptEntries(): number {
  const raw = process.env.GUEST_LOOKUP_MAX_ATTEMPT_ENTRIES;
  if (!raw) return DEFAULT_MAX_ATTEMPT_ENTRIES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_ATTEMPT_ENTRIES;
  }
  return parsed;
}

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
 * ## 计数 Map 的两个上界（issue #35）
 *
 * 失败计数放在进程内 Map 里，所以**必须有界**，否则未认证端点就是个
 * 内存泄漏入口。两条上界一起管：
 *
 * 1. **时间上界**：`sweepExpired()` 主动回收窗口已过的条目，与「当前查的
 *    是哪个 key」**无关**。原来的清理只挂在 `isBlocked()` 上（查这个 key
 *    时顺手删它自己），于是查不到的 key 永远等不到自己被查，也就永远留在 Map 里。
 * 2. **容量上界**：`enforceCapacity()` 保证条目数不超过 `maxAttemptEntries`，
 *    超限淘汰**最旧**的条目。
 *
 * 淘汰最旧而不是最热是有意的取舍：被淘汰的条目本来也快过期了，
 * 而热点 key 保留下来才能继续挡住正在进行的穷举。
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

  /** 失败计数 Map 的容量上限 */
  private readonly maxAttemptEntries: number;

  constructor(private readonly orderService: OrderService) {
    this.maxAttemptEntries = readMaxAttemptEntries();
  }

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

    // ⚠️ 回收过期条目必须**独立于查询路径**：否则查不到的 key 永远不会被回收
    this.sweepExpired(now);

    const record = this.attempts.get(key);
    if (!record || now - record.firstAt > ATTEMPT_WINDOW_MS) {
      // 窗口已过 → 重新计数。
      // ⚠️ 先 delete 再 set：让 firstAt 与 Map 的插入顺序保持一致
      // （sweepExpired 依赖「firstAt 沿插入顺序非递减」这个不变式）。
      this.attempts.delete(key);
      this.attempts.set(key, { count: 1, firstAt: now });
      this.enforceCapacity();
      return;
    }
    record.count += 1;
  }

  /**
   * 回收窗口已过的条目。
   *
   * ⚠️ Map 的迭代顺序 = 插入顺序，而记录的 `firstAt` 沿插入顺序**非递减**
   * （窗口过期后重置的 key 会先 delete 再 set，挪到队尾并带上新的 firstAt）。
   * 所以「已过期」的那一批必然是**队首的一段连续区间**——从队首往后扫，
   * 扫到未过期的就停。每次请求的清扫成本是 O(1)（摊还），不是 O(n)。
   */
  private sweepExpired(now: number): void {
    for (const [key, record] of this.attempts) {
      if (now - record.firstAt <= ATTEMPT_WINDOW_MS) return;
      this.attempts.delete(key);
    }
  }

  /**
   * 容量上界：超限时淘汰**最旧**的条目。
   *
   * 队首 = 插入顺序最靠前 = firstAt 最小 = 最旧，所以直接从队首淘汰。
   */
  private enforceCapacity(): void {
    while (this.attempts.size > this.maxAttemptEntries) {
      const oldest = this.attempts.keys().next();
      if (oldest.done) return;
      this.attempts.delete(oldest.value);
    }
  }
}
