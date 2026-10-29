/**
 * 出款渠道的抽象（阶段 5h-2）。
 *
 * ## 为什么与 `PaymentProvider` 并列而不是复用
 *
 * 「打款」与「收款」是**两个不同的动作**：收钱是平台收进来（要跳页面、要回调），
 * 打钱是平台付出去（提交即扣款、没有回调、结果同步返回）。
 * 形状不同就分开定义 —— 复用会逼出「一堆用不上的可选参数」。
 *
 * ## channel 与 provider 的含义与 `PaymentProvider` 一致
 *
 * - `channel`：用户面对的渠道名
 * - `provider`：渠道背后的服务提供方
 *
 * ⚠️ 本阶段只接一个**本地假网关**（见 `fake-payout.provider.ts`）。
 */

/** 发起打款时要传给渠道的信息 */
export interface PayoutExecuteInput {
  /** 出款单 id —— 渠道侧的「打款单号」，也是幂等去重的依据 */
  referenceId: string;
  /** 业务单号（出款单号），渠道对账单上显示的 */
  referenceNo: string;
  /**
   * 打款金额（**整数分**）。
   *
   * ⚠️ 只从出款单的**审批锁定值**读，绝不从请求体读。
   */
  amount: number;
  /**
   * 收款账户。
   *
   * ⚠️ **这是审批那一刻的快照**（`payouts.snapshot*`），
   *    不是实时查出来的 —— 审批后商家改账户，不该改变打款目标（护栏 X2b）。
   */
  account: {
    accountName: string;
    bankName: string;
    accountNo: string;
  };
  /** 第几次尝试（1 = 首次，2、3 = 重试）。渠道侧对账时用得上 */
  attempt: number;
}

/** 打款的结果 */
export interface PayoutExecuteResult {
  /** 渠道交易号。幂等去重要按它走 */
  providerTxnId: string;
  /**
   * 渠道侧的出款状态。
   *
   * ⚠️ **开放字符串**：`'SUCCESS'` / `'FAILED'` 各渠道不同。
   * 调用方只认 `'SUCCESS'`，其余走失败路径。
   */
  status: string;
  /**
   * 渠道**实际打出的金额**（整数分）。
   *
   * ⚠️ **必须有它** —— 护栏 X3「渠道金额核对」靠它与请求金额比对。
   * 不核对就可能「打出去 100 块、账上记 1000 块」。
   */
  amount: number;
  /** 失败原因（`status !== 'SUCCESS'` 时给运营看） */
  failureReason?: string;
}

/**
 * 出款渠道。
 *
 * ⚠️ **`execute` 是同步的**：提交即扣款、结果立刻返回。
 * 真渠道（异步打款）接入时这个接口的形状要重新评估 ——
 * 届时大概率要拆成「提交 → 轮询」两步，**不能**在接口里假装同步。
 */
export interface PayoutProvider {
  /** 渠道名 */
  readonly channel: string;
  /** 服务提供方名 */
  readonly provider: string;

  /** 打款 */
  execute(input: PayoutExecuteInput): Promise<PayoutExecuteResult>;

  /** 查一笔打款的状态（对账用）。本阶段假网关恒返回已完成 */
  queryPayout(providerTxnId: string): Promise<{ status: string }>;
}
