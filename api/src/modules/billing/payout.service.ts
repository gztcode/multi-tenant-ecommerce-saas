import { PayoutQueryService } from './payout-query.service';
import { PayoutStateService } from './payout-state.service';
import {
  AvailablePeriodView,
  Paging,
  PayoutDetailView,
  PayoutEntryView,
  PayoutOperationView,
  PayoutView,
  PlatformPayoutView,
} from './payout-types';
import { Injectable } from '@nestjs/common';
import { PayoutStatus } from '@prisma/client';

export type {
  PayoutView,
  PayoutEntryView,
  PayoutDetailView,
  PlatformPayoutView,
  PayoutOperationView,
  AvailablePeriodView,
} from './payout-types';

/**
 * PayoutService —— facade（阶段 11 拆分）。
 *
 * 原 2052 行巨石按职责拆为两个服务：
 *
 * | 文件 | 类 | 职责 |
 * |------|------|------|
 * | payout-query.service.ts | PayoutQueryService | 列表/详情/可申请周期 + 视图构造 |
 * | payout-state.service.ts | PayoutStateService | 申请/审批/驳回/重试/解卡 状态机 |
 *
 * 本类**不再承载业务逻辑**：public 方法原签名委托，类型原地 re-export，
 * 注入方式保持「外部类注入 PayoutService」不变。
 * 事务纪律同 payment：子服务方法在事务回调中使用时必须显式接收 tx。
 */
@Injectable()
export class PayoutService {
  private readonly queries: PayoutQueryService;
  private readonly states: PayoutStateService;

  constructor(queries: PayoutQueryService, states: PayoutStateService) {
    this.queries = queries;
    this.states = states;
  }

  /** @see states#apply（阶段 11 拆分，逻辑见实现文件） */
  async apply(input: { period: string }): Promise<PayoutView> {
    return this.states.apply(input);
  }
  /** @see states#cancel（阶段 11 拆分，逻辑见实现文件） */
  async cancel(payoutId: string): Promise<PayoutView> {
    return this.states.cancel(payoutId);
  }
  /** @see states#approve（阶段 11 拆分，逻辑见实现文件） */
  async approve(payoutId: string): Promise<PlatformPayoutView> {
    return this.states.approve(payoutId);
  }
  /** @see states#reject（阶段 11 拆分，逻辑见实现文件） */
  async reject(payoutId: string, reason: string): Promise<PlatformPayoutView> {
    return this.states.reject(payoutId, reason);
  }
  /** @see states#retry（阶段 11 拆分，逻辑见实现文件） */
  async retry(payoutId: string, reason: string): Promise<PlatformPayoutView> {
    return this.states.retry(payoutId, reason);
  }
  /** @see states#unstick（阶段 11 拆分，逻辑见实现文件） */
  async unstick(
    payoutId: string,
    input: { to: 'FAILED' | 'APPROVED'; reason: string },
  ): Promise<PlatformPayoutView> {
    return this.states.unstick(payoutId, input);
  }
  /** @see queries#listForTenant（阶段 11 拆分，逻辑见实现文件） */
  async listForTenant(
    query: { status?: PayoutStatus; period?: string } & Paging = {},
  ): Promise<{ items: PayoutView[]; total: number }> {
    return this.queries.listForTenant(query);
  }
  /** @see queries#detailForTenant（阶段 11 拆分，逻辑见实现文件） */
  async detailForTenant(payoutId: string): Promise<PayoutDetailView> {
    return this.queries.detailForTenant(payoutId);
  }
  /** @see queries#listForPlatform（阶段 11 拆分，逻辑见实现文件） */
  async listForPlatform(
    query: { status?: PayoutStatus; period?: string } & Paging = {},
  ): Promise<{ items: PlatformPayoutView[]; total: number }> {
    return this.queries.listForPlatform(query);
  }
  /** @see queries#detailForPlatform（阶段 11 拆分，逻辑见实现文件） */
  async detailForPlatform(payoutId: string): Promise<
    PlatformPayoutView & {
      entries: PayoutEntryView[];
      operations: PayoutOperationView[];
    }
  > {
    return this.queries.detailForPlatform(payoutId);
  }
  /** @see queries#availablePeriods（阶段 11 拆分，逻辑见实现文件） */
  async availablePeriods(): Promise<AvailablePeriodView[]> {
    return this.queries.availablePeriods();
  }
}
