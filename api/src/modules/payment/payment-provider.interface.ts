/**
 * 支付渠道的抽象（阶段 3 Task 5）。
 *
 * ## 为什么先定接口再写实现
 *
 * 真实渠道（微信支付、支付宝）需要商户资质与密钥，本机拿不到；
 * 但「支付」这件事的**形状**是稳定的：建一笔支付、查一笔支付、退一笔支付、
 * 解析渠道回调。把这四件事定成接口，真沙箱适配器就只是「填密钥」的工作，
 * 而不是「改架构」的工作。
 *
 * ⚠️ 本阶段只接一个**本地假网关**（见 `fake-payment.provider.ts`）。
 * 假网关不是「临时的假实现」，它是**能跑通全链路的真渠道**——
 * 幂等、金额核对、状态机都被走到，所以阶段 3 的验收有东西可测。
 *
 * ## channel 与 provider 不是一回事
 *
 * - `channel`：用户面对的渠道名（微信 / 支付宝 / 本地假网关）
 * - `provider`：渠道背后的服务提供方（微信支付 vs 微信服务商、支付宝 vs 支付宝服务商）
 *
 * 幂等去重按 `provider` 走：同一笔交易在服务商模式下会**同时**收到
 * 「服务商」与「直连」两个渠道的通知，只有按 provider 才能识别成同一笔。
 */

/** 发起支付时要传给渠道的信息 */
export interface CreatePaymentInput {
  /** 订单 id（uuid） */
  orderId: string;
  /** 订单号（对外可见的凭证，会出现在渠道页面与对账单里） */
  orderNo: string;
  /** 支付金额（**整数分**）。⚠️ 只从订单读，绝不从请求体读。 */
  amount: number;
  /** 商品标题（渠道页面上的显示名） */
  subject: string;
}

/** 渠道返回的支付信息 */
export interface CreatePaymentResult {
  /** 渠道交易号。幂等去重要按它走（配合 `payments` 的唯一索引）。 */
  providerTxnId: string;
  /**
   * 渠道相关的支付数据。
   *
   * 微信是 `code_url`、支付宝是跳转 URL、假网关是本地页面 URL——
   * 各渠道形状不同，所以这里是开放的字典而不是固定字段。
   */
  payload: Record<string, unknown>;
  /** 支付有效期 */
  expiresAt: Date;
}

/** 查支付的结果 */
export interface QueryPaymentResult {
  /** 渠道侧的支付状态（各渠道自己的枚举，原样返回） */
  status: string;
}

/** 退款的结果 */
export interface RefundResult {
  /** 渠道侧的退款状态 */
  status: string;
}

/**
 * 归一化后的渠道回调事件。
 *
 * 各渠道的回调格式千差万别（微信是 XML、支付宝是表单、假网关是 JSON），
 * `parseWebhook` 负责把它们归一化成这一种形状——**验签也在那一步完成**。
 */
export interface NormalizedWebhookEvent {
  /** 服务提供方名（幂等去重按它走） */
  provider: string;
  /** 渠道名 */
  channel: string;
  /** 渠道事件 id（幂等去重按它走） */
  eventId: string;
  /** 渠道交易号 */
  providerTxnId: string;
  /** 订单号 */
  orderNo: string;
  /** 支付金额（整数分） */
  amount: number;
  /** 这次回调表示「支付成功」还是「支付失败」 */
  success: boolean;
}

/**
 * 支付渠道。
 *
 * ⚠️ `parseWebhook` **必须在验签失败时抛异常**（HTTP 层会转成 401），
 * 而且**验签通过之后才允许落库**——顺序反了就是一个资金漏洞，
 * 详见 `webhook.controller.ts` 的注释。
 */
export interface PaymentProvider {
  /** 渠道名 */
  readonly channel: string;
  /** 服务提供方名 */
  readonly provider: string;

  /** 发起支付，返回支付页面所需的数据 */
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;

  /** 查一笔支付的状态（对账、补单用） */
  queryPayment(providerTxnId: string): Promise<QueryPaymentResult>;

  /**
   * 退款。
   *
   * @param paymentId 支付单 id（渠道侧的退款单号）
   * @param amount 退款金额（整数分）
   * @param reason 退款原因
   */
  refund(
    paymentId: string,
    amount: number,
    reason: string,
  ): Promise<RefundResult>;

  /**
   * 解析渠道回调：验签 + 归一化。
   *
   * ⚠️ **验签失败必须抛异常**（而不是返回 null 之类的「失败标记」）——
   * 抛异常才能保证「一个字都不写进数据库」（设计 §3.7）。
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedWebhookEvent;
}
