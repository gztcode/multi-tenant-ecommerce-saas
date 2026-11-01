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

/** 渠道侧的出款流水（对账用） */
export interface ChannelPayoutRecord {
  /** 渠道侧的业务单号（= 我们传给渠道的 `payoutNo`） */
  referenceNo?: string;
  /** 渠道交易号（= 我们拿到的 `providerTxnId`） */
  providerTxnId: string;
  /** 渠道实际打出的金额（整数分） */
  amount: number;
  /** 渠道侧状态（开放字符串：`SUCCESS` / `FAILED` / `PROCESSING` / …） */
  status: string;
  /** 渠道侧的打款时刻 */
  paidAt?: Date;
  /** 失败原因（渠道原文） */
  failureReason?: string;
}

/**
 * 单笔核实的入参 —— ⚠️ **两个键至少给一个**。
 *
 * ⚠️ **`referenceNo` 是必须支持的** —— 「卡在 `PROCESSING` 的单」**没有 `payoutTxnId`**
 * （它是 `markPaid` 的唯一写入点），而解卡核实闸的对象恰恰是 `PROCESSING` 的单。
 * 只按 `providerTxnId` 查 → 核实闸对它的全部对象都是死代码。
 */
export interface PayoutQuery {
  /** 渠道交易号（`PAID` 的单才有） */
  providerTxnId?: string;
  /** 渠道侧业务单号（= 我们的 `payoutNo`，**所有调过渠道的单都有**） */
  referenceNo?: string;
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

  /**
   * 查一笔打款的状态（对账 / 核实用）。
   *
   * ⚠️ **返回的 `status` 是开放字符串** —— 调用方只认 `'SUCCESS'` 与 `'FAILED'`，
   * 其余一律当「问不出结论」处理（fail-closed）。
   */
  queryPayout(
    query: PayoutQuery,
  ): Promise<{ status: string; amount?: number; paidAt?: Date }>;

  /**
   * ⚠️ **批量查渠道侧的出款流水**（对账用）。
   * 时间窗是**左闭右开**的 `[from, to)`。
   *
   * ⚠️ **必须包含失败的那次尝试** —— 否则「第一次失败第二次成功」在渠道侧
   * 只剩一条 SUCCESS，看起来像「只打了一次」，对账就测不出重试场景。
   */
  listPayouts(query: { from: Date; to: Date }): Promise<ChannelPayoutRecord[]>;
}
