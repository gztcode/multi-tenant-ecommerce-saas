/**
 * 支付渠道共享契约（阶段 6b Task 12，设计 §8.3）。
 *
 * ## 它是什么
 *
 * 「任何支付渠道都必须满足的行为」写一次，对每个实现（`fake` / `sandbox` / 将来的真渠道）
 * 各跑一遍。它是新渠道的**准入闸**：契约不过 = 不允许接入。
 *
 * ## 怎么用
 *
 * ```ts
 * runPaymentProviderContract({
 *   name: 'fake',
 *   createProvider: () => new FakePaymentProvider(),
 * });
 * ```
 *
 * ⚠️ **不要在契约里迁就实现** —— 契约要能抓出真实缺陷；
 *    确实不适用的单条用 `it.skip` 写清原因，而不是放宽断言。
 * ⚠️ **不碰数据库** —— 这里只验渠道本身的行为（验签、幂等、能力门控），
 *    落库与状态机由 e2e 覆盖。
 */
import { randomUUID } from 'node:crypto';
import type {
  NormalizedWebhookEvent,
  PaymentProvider,
  RefundQueryResult,
} from '../../src/modules/payment/payment-provider.interface';

/** 创建支付回调的原始报文（渠道可自定义字节，但签名必须覆盖整段原始字节） */
export type WebhookRawFactory = (event: NormalizedWebhookEvent) => Buffer;

/**
 * 回调原文字节由渠道自己决定（假网关用 `orderNo`、沙箱用 `referenceNo`），
 * 契约只要求「同一份字节 + 正确签名 → 验签通过」，所以由调用方给工厂。
 */
export type WebhookSigner = (
  rawBody: Buffer,
) => Record<string, string | string[] | undefined>;

export interface PaymentProviderContractOptions {
  /** 渠道名（只用于测试名与错误信息） */
  name: string;
  /** 每个用例拿到一个新实例，避免用例之间串状态 */
  createProvider: () => PaymentProvider;
  /** 把归一化事件编码成渠道自己的回调报文 */
  buildWebhookRaw: WebhookRawFactory;
  /** 给回调原文字节算签名请求头 */
  signWebhook: WebhookSigner;
  /**
   * 渠道是否支持异步退款（能力声明 `asyncRefund=true`）。
   *
   * ⚠️ 同步渠道上异步退款用例必须 `it.skip` 并注明原因 —— 不要删用例。
   */
  supportsAsyncRefund?: boolean;
  /**
   * 把渠道调成指定的退款剧本（异步退款三条用例的前置动作）。
   *
   * ⚠️ **必须由调用方提供**：各渠道的注入方式不同（假网关是
   *    `armRefundScenario`、沙箱是 mock 服务的 `setRefundScenario`），
   *    契约层不做猜测，也不允许渠道「自己决定走哪条分支」。
   */
  armRefund?: (
    provider: PaymentProvider,
    scenario: 'processing' | 'reject' | 'unknown',
  ) => void;
}

/** 轮询退款终态的上限（次）与间隔（毫秒） */
const REFUND_POLL_ATTEMPTS = 50;
const REFUND_POLL_INTERVAL_MS = 20;

/**
 * 反复 `queryRefund` 直到拿到终态（或超次数）。
 *
 * ⚠️ 用**真实计时器**而不是假计时器：渠道延迟是它自己的实现细节，
 *    契约只要求「最终问得出结论」，不规定第几次能问出来。
 */
async function pollRefundUntilTerminal(
  provider: PaymentProvider,
  refundTxnId: string,
): Promise<RefundQueryResult> {
  let latest: RefundQueryResult = { status: 'UNKNOWN' };
  for (let i = 0; i < REFUND_POLL_ATTEMPTS; i += 1) {
    latest = await provider.queryRefund(refundTxnId);
    if (latest.status !== 'PROCESSING') {
      return latest;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, REFUND_POLL_INTERVAL_MS),
    );
  }
  return latest;
}

/** 一份典型的支付入参（金额用整数分） */
function samplePaymentInput(): {
  referenceId: string;
  referenceNo: string;
  amount: number;
  subject: string;
} {
  return {
    referenceId: randomUUID(),
    referenceNo: `ORD${Date.now()}${Math.floor(Math.random() * 1000)}`,
    amount: 1999,
    subject: '契约测试商品',
  };
}

/** 一份典型的归一化回调事件 */
function sampleEvent(provider: PaymentProvider): NormalizedWebhookEvent {
  return {
    provider: provider.provider,
    channel: provider.channel,
    eventId: `evt-${randomUUID()}`,
    providerTxnId: `txn-${randomUUID()}`,
    referenceNo: `ORD${Date.now()}`,
    amount: 1999,
    success: true,
  };
}

/**
 * 跑一轮支付契约（6 条）。
 *
 * @param options 渠道实例工厂与回调编码器
 */
export function runPaymentProviderContract(
  options: PaymentProviderContractOptions,
): void {
  describe(`支付渠道契约（${options.name}）`, () => {
    let provider: PaymentProvider;

    // ⚠️ **每个用例一个新实例** —— 渠道可能带进程内状态（幂等表、计数器），
    //    复用同一个实例会让前一个用例的造数影响后一个。
    beforeEach(() => {
      provider = options.createProvider();
    });

    it('createPayment 返回非空 providerTxnId 与未来时刻的 expiresAt', async () => {
      const input = samplePaymentInput();

      const result = await provider.createPayment(input);

      expect(typeof result.providerTxnId).toBe('string');
      expect(result.providerTxnId.length).toBeGreaterThan(0);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(Number.isNaN(result.expiresAt.getTime())).toBe(false);
      // ⚠️ 有效期必须是「未来」，否则调用方刚拿到就过期
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('createPayment 幂等：同 referenceId 两次创建必须返回同一个渠道交易号', async () => {
      // ⚠️ **referenceId 必须固定** —— 它就是渠道侧的幂等键
      //    （服务层传的是**支付单 id**，复用旧单时不新建行 → 跨重试恒定）。
      const input = samplePaymentInput();

      const first = await provider.createPayment(input);
      const second = await provider.createPayment(input);

      // ⚠️ **必须返回同一个渠道交易号**：换号意味着渠道侧多了一笔待付款交易，
      //    用户在两个页面各付一次 = **同一笔订单扣两次钱**。
      //    第二笔只能靠 P1-3 的 `NEEDS_REFUND` 人工闸兜底（会先多收一次）。
      //    这条与出款契约的「submit 幂等」对等 —— 出款侧重复打款比多收更糟，
      //    但支付侧原先**没有**这条，等于新渠道接入时少一道准入闸。
      expect(first.providerTxnId).toBe(second.providerTxnId);

      // ⚠️ **金额一致性不在这里断言**：`payload` 是开放字典，各渠道形状不同
      //    （微信给 `code_url`、支付宝给跳转 URL、假网关给 `payUrl`），
      //    **都不承载金额语义**，渠道契约层拿不到统一的金额字段。
      //    金额一致性由 service 层保证 —— 金额只从**库里**的订单读，
      //    绝不从请求体读（见 `CreatePaymentInput.amount` 的注释），
      //    渠道拿到的金额恒等于订单金额，压根不存在「两次金额不同」的可能。
    });

    it('queryPayment 未知交易号不冒充成功', async () => {
      const result = await provider.queryPayment(
        `不存在的交易号-${randomUUID()}`,
      );

      // ⚠️ 只允许「非 SUCCESS」：抛异常、返回 UNKNOWN / PENDING / FAILED 都可以，
      //    唯独不能编一个 SUCCESS —— 那会把没付的钱当成付了。
      expect(result.status.toUpperCase()).not.toBe('SUCCESS');
    });

    // ⚠️ **「退款金额与支付金额不一致 → 拒绝」在渠道契约层不适用**，
    //    原因：`refund(paymentId, amount, reason)` 只收**退款金额**，
    //    不收原支付金额 —— 渠道拿不到「应退多少」，无从比对。
    //    真实链路里金额由 `payment.service.refund()` 固定成 `payment.amount`
    //    （它读库里的支付单，不接受请求体传金额），超额退款在调用渠道**之前**
    //    就不可能发生；这条的验证属于 service 层，不在这里。
    //    → 用 `it.skip` 而不是放宽断言，见 AGENTS.md「新渠道准入」。
    it.skip('refund 金额与支付金额不一致 → 拒绝（渠道层不适用：接口不带原支付金额）', () => {
      // 保留占位，说明设计 §8.3 的这条由 service 层覆盖。
    });

    it('refund 的返回必须落在 SUCCESS / PROCESSING / FAILED 三种之内', async () => {
      if (!provider.capabilities.refund) {
        return;
      }
      const result = await provider.refund(
        randomUUID(),
        samplePaymentInput().amount,
        '契约测试：退款状态归一',
      );
      expect(['SUCCESS', 'PROCESSING', 'FAILED']).toContain(result.status);
      // ⚠️ **FAILED 必须带 `definitive` 布尔** —— 调用方靠它决定能否安全重试；
      //    缺了它只能当「结果未知」，重试就有重复退款的风险。
      if (result.status === 'FAILED') {
        expect(typeof result.definitive).toBe('boolean');
      }
    });

    it('queryRefund 查无此单 → UNKNOWN（绝不冒充 FAILED）', async () => {
      if (!provider.capabilities.refund) {
        return;
      }
      const result = await provider.queryRefund(
        `不存在的退款单-${randomUUID()}`,
      );
      // ⚠️ 冒充 FAILED 会让运营重试 → 重复退款；冒充 SUCCESS 更糟。
      expect(result.status).toBe('UNKNOWN');
    });

    // ⚠️ **异步退款用例在同步渠道上跳过**（`supportsAsyncRefund` 未开）：
    //    同步渠道的 `refund` 即终态，不存在「受理后查询」这一步。
    //    不要删用例 —— 用开关控制，见 AGENTS.md「新渠道准入」。
    (options.supportsAsyncRefund ? it : it.skip)(
      '异步退款：PROCESSING → queryRefund 最终 SUCCESS',
      async () => {
        if (!provider.capabilities.refund) {
          return;
        }
        // 由调用方把渠道调成「异步受理」剧本（各渠道的钩子不同，不在这里猜）
        options.armRefund?.(provider, 'processing');

        const first = await provider.refund(
          randomUUID(),
          samplePaymentInput().amount,
          '契约测试：异步退款',
        );

        // ⚠️ **这一步必须是 `PROCESSING`**：渠道已经被调成异步剧本，
        //    若直接返回 `SUCCESS` 说明它没有真正实现「受理 → 确认」两段式。
        expect(first.status).toBe('PROCESSING');
        expect(first.refundTxnId).toBeTruthy();

        // ⚠️ **允许渠道在终态确认上「慢一拍」**（沙箱有模拟延迟），
        //    但不能永远停在处理中 —— 最终必须问得出 `SUCCESS`。
        const final = await pollRefundUntilTerminal(
          provider,
          first.refundTxnId!,
        );
        expect(final.status).toBe('SUCCESS');
      },
    );
    // ⚠️ **同步渠道上上面那条必须 `it.skip` 并注明原因**：`refund` 即终态。

    (options.supportsAsyncRefund ? it : it.skip)(
      '明确拒付：FAILED + definitive=true（可安全重试）',
      async () => {
        if (!provider.capabilities.refund) {
          return;
        }
        options.armRefund?.(provider, 'reject');

        const result = await provider.refund(
          randomUUID(),
          samplePaymentInput().amount,
          '契约测试：明确拒付',
        );

        expect(result.status).toBe('FAILED');
        // ⚠️ 只有 `definitive=true` 才允许调用方重试；写成 false 会让单子
        //    永远不能被重试，写成 true 而实际未知则会造成重复退款。
        expect(result.status === 'FAILED' && result.definitive).toBe(true);
      },
    );

    (options.supportsAsyncRefund ? it : it.skip)(
      '结果未知：FAILED + definitive=false（绝不可自动重试）',
      async () => {
        if (!provider.capabilities.refund) {
          return;
        }
        options.armRefund?.(provider, 'unknown');

        const result = await provider.refund(
          randomUUID(),
          samplePaymentInput().amount,
          '契约测试：退款结果未知',
        );

        expect(result.status).toBe('FAILED');
        expect(result.status === 'FAILED' && result.definitive).toBe(false);
      },
    );

    it('不支持退款能力的渠道：refund 必须明确报错，不能静默返回假成功', async () => {
      if (provider.capabilities.refund) {
        // 本渠道支持退款 —— 这条对它不适用，但后面「能力一致性」用例仍会验它。
        return;
      }
      const paymentId = randomUUID();
      await expect(
        provider.refund(paymentId, 1999, '契约测试：不支持的退款'),
      ).rejects.toThrow();
    });

    it('parseWebhook 验签失败必须抛异常', () => {
      const raw = options.buildWebhookRaw(sampleEvent(provider));
      const goodHeaders = options.signWebhook(raw);
      const headerName = Object.keys(goodHeaders)[0];
      expect(headerName).toBeDefined();

      // ① 签名错误
      const wrongHeaders = { ...goodHeaders, [headerName]: 'deadbeef' };
      expect(() => provider.parseWebhook(raw, wrongHeaders)).toThrow();

      // ② 缺签名
      expect(() => provider.parseWebhook(raw, {})).toThrow();

      // ③ 签名正确但报文被改过（签名必须覆盖原始字节，不是解析后的字段）
      const tampered = Buffer.from(
        raw.toString('utf8').replace('1999', '1'),
        'utf8',
      );
      expect(() => provider.parseWebhook(tampered, goodHeaders)).toThrow();
    });

    it('parseWebhook 验签通过返回归一化事件', () => {
      const event = sampleEvent(provider);
      const raw = options.buildWebhookRaw(event);
      const headers = options.signWebhook(raw);

      const parsed = provider.parseWebhook(raw, headers);

      expect(parsed).toEqual({
        provider: provider.provider,
        channel: provider.channel,
        eventId: event.eventId,
        providerTxnId: event.providerTxnId,
        referenceNo: event.referenceNo,
        amount: event.amount,
        success: true,
        // ⚠️ 阶段 6c：归一化事件必须显式带 `eventType`，缺省按 `PAYMENT`。
        eventType: 'PAYMENT',
      });
    });

    it('createPaymentMethod / chargeAuthorized 与 capabilities 声明一致', async () => {
      const { capabilities } = provider;

      if (capabilities.paymentMethod) {
        const method = await provider.createPaymentMethod({ type: 'CARD' });
        expect(typeof method.token).toBe('string');
        expect(method.token.length).toBeGreaterThan(0);
      } else {
        // ⚠️ 不支持就必须**抛错**，不能静默返回一个假 token
        await expect(
          provider.createPaymentMethod({ type: 'CARD' }),
        ).rejects.toThrow();
      }

      if (capabilities.authorizedCharge) {
        const input = samplePaymentInput();
        const charged = await provider.chargeAuthorized({
          ...input,
          paymentMethodToken: 'contract-token',
        });
        expect(typeof charged.providerTxnId).toBe('string');
        expect(charged.providerTxnId.length).toBeGreaterThan(0);
      } else {
        const input = samplePaymentInput();
        await expect(
          provider.chargeAuthorized({
            ...input,
            paymentMethodToken: 'contract-token',
          }),
        ).rejects.toThrow();
      }
    });
  });
}
