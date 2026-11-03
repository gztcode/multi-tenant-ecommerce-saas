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
import type { ChannelCapabilities } from '../channel/channel.types';

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

/**
 * 提交打款的结果（阶段 6b）。
 *
 * ⚠️ **提交不再等于终态**：异步渠道会返回 `PROCESSING`，最终状态要
 *    `queryPayout` 轮询。调用方必须按三种状态分别处置，**不能**把
 *    非 `SUCCESS` 一律当失败（那会把「钱可能已经打出去」的单重试成重复打款）。
 */
export type PayoutSubmitResult =
  | { status: 'SUCCESS'; providerTxnId: string; amount: number; paidAt?: Date }
  | { status: 'PROCESSING'; providerTxnId?: string; amount?: number }
  | {
      status: 'FAILED';
      providerTxnId?: string;
      amount?: number;
      /**
       * 失败是否**确定**。
       *
       * - `true`：渠道明确说没打 → 可以安全重试；
       * - `false`：结果未知（超时 / 网络中断 / 渠道内部错误）→ 钱**可能**
       *   已经打出去 → 绝不能自动重试，只能人工核对。
       */
      definitive: boolean;
      failureReason?: string;
    };

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
 * 查询打款状态的结果（阶段 6b）。
 *
 * ⚠️ **`FAILED` 必须看 `definitive`** —— 只有 `definitive === true` 才是
 *    「渠道明确说没打」的结论；否则（含缺省）一律当「问不出结论」处理（fail-closed）。
 * ⚠️ **`UNKNOWN` 不等于 `FAILED`** —— 「查不到这一单」不是「渠道说没打」。
 */
export interface PayoutQueryResult {
  status: 'SUCCESS' | 'FAILED' | 'PROCESSING' | 'UNKNOWN';
  providerTxnId?: string;
  amount?: number;
  paidAt?: Date;
  definitive?: boolean;
  failureReason?: string;
}

/**
 * 出款渠道。
 *
 * ## 提交 → 查询（阶段 6b）
 *
 * ⚠️ **`submit` 提交即返回，但不保证是终态**：同步渠道（如假网关）
 *    可能直接返回 `SUCCESS` / `FAILED`，异步渠道会返回 `PROCESSING`，
 *    最终状态要 `queryPayout` 查。
 * ⚠️ **接口里不假装同步**：提交与查询是两个动作，各自有明确的结果类型。
 */
export interface PayoutProvider {
  /** 渠道名 */
  readonly channel: string;
  /** 服务提供方名 */
  readonly provider: string;
  /**
   * 能力声明（阶段 6a）。
   *
   * ⚠️ **必填**：能力门控靠它；缺省按「全不支持」会静默降级，
   *    所以注册表对没写能力的实现只会退回 `NO_CAPABILITIES`，
   *    调用方据此显式报错，而不是假装成功。
   */
  readonly capabilities: ChannelCapabilities;
  /** 是否仅限非生产环境（`sandbox` 之类）；生产环境注册表直接拒绝 */
  readonly devOnly?: boolean;
  /** 单次调用超时预算（毫秒），不写用默认值 */
  readonly timeoutMs?: number;

  /** 提交打款（结果可能是终态，也可能是 `PROCESSING`） */
  submit(input: PayoutExecuteInput): Promise<PayoutSubmitResult>;

  /**
   * 查一笔打款的状态（对账 / 核实用）。
   *
   * ⚠️ **状态是归一化的** —— 只允许 `SUCCESS` / `FAILED` / `PROCESSING` / `UNKNOWN`
   *    四种；渠道的原始字符串由实现方归一化。
   * ⚠️ **调用方只认**「`SUCCESS`」与「`FAILED` 且 `definitive === true`」，
   *    其余一律当「问不出结论」处理（fail-closed）。
   */
  queryPayout(query: PayoutQuery): Promise<PayoutQueryResult>;

  /**
   * ⚠️ **批量查渠道侧的出款流水**（对账用）。
   * 时间窗是**左闭右开**的 `[from, to)`。
   *
   * ⚠️ **必须包含失败的那次尝试** —— 否则「第一次失败第二次成功」在渠道侧
   * 只剩一条 SUCCESS，看起来像「只打了一次」，对账就测不出重试场景。
   *
   * ⚠️ **`page` / `pageSize` 是可选的分页参数**（阶段 5m 技术债）——
   *    真渠道一次拉不动整个时间窗（银行 / 支付渠道都有分页上限）。
   *    - **两个都不传** = 一次性返回全部（旧行为，假网关与旧调用方不受影响）；
   *    - **传了** = 按页返回，调用方循环翻页，结束条件是
   *      「返回条数 < `pageSize`」（拿满一页还要再翻，翻到空数组才停）。
   *
   * ⚠️ **实现方契约 A：必须真的给满 `pageSize` 条**（除非已经到末尾）。
   *    调用方靠「本页不满一页」判断「到底了」—— 某个渠道若自作主张把每页
   *    压得比请求的 `pageSize` 更小（比如最多只给 100 条），调用方会在
   *    第 1 页就判定到底 → **静默只拿到一小部分流水**，比对结果全错且不报错。
   *    → 接真渠道时要么让渠道按请求的条数返回，要么在适配层自己翻够这一页。
   *
   * ⚠️ **实现方契约 B：非有限数的 `page` / `pageSize`（`NaN` / `Infinity`）
   *    一律回落到默认值**（`page` → 1，`pageSize` → `CHANNEL_LIST_PAGE_SIZE`），
   *    **绝不能返回空数组** —— 调用方会把空数组当成「渠道说这段时间没有流水」
   *    → 所有本地已付单全变成 E 类差异（假告警）。
   *    （`Math.max(1, NaN)` 仍然是 `NaN`，不能指望它做下界保护。）
   */
  listPayouts(query: {
    from: Date;
    to: Date;
    /** 页码，从 1 开始。不传 = 不分页 */
    page?: number;
    /** 每页条数。不传 = 不分页 */
    pageSize?: number;
  }): Promise<ChannelPayoutRecord[]>;
}
