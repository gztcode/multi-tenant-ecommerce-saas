/**
 * 沙箱渠道的 HTTP mock 服务（阶段 6b Task 11，设计 §8.2）。
 *
 * ## 为什么要有它
 *
 * 沙箱 provider 必须**真的走 HTTP**（`SANDBOX_CHANNEL_URL` 指向这里），
 * 而不是进程内直调 —— 否则「超时」「连接断开」「报文格式漂移」这类
 * 只有真网络才暴露的问题，在测试里永远不会出现。
 *
 * ## 用法
 *
 * ```ts
 * const server = await startMockChannelServer({ scenario: 'reject' });
 * process.env.SANDBOX_CHANNEL_URL = server.url;
 * // …
 * server.setScenario('success'); // 场景可随时切换
 * await server.close();          // 必须在 afterAll 里关
 * ```
 *
 * ⚠️ **端口用 `0`**：由内核分配空闲端口，测试并行时不撞端口。
 * ⚠️ **只给测试与本地 e2e 用**，不要挂进生产代码。
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from 'node:http';

/** 失败注入场景 */
export type MockScenario =
  'success' | 'reject' | 'timeout' | 'amount_mismatch' | 'processing';

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  'success',
  'reject',
  'timeout',
  'amount_mismatch',
  'processing',
];

/** 默认共享密钥（测试与沙箱 provider 两端都要用同一个值） */
export const DEFAULT_MOCK_WEBHOOK_SECRET =
  'mock-sandbox-webhook-secret-32chars';

/** 回调签名请求头（与沙箱 provider 约定一致） */
export const MOCK_SIGNATURE_HEADER = 'x-sandbox-signature';

/** `timeout` 剧本挂住请求的时长（测试里够触发客户端超时，又不至于拖慢套件） */
const DEFAULT_TIMEOUT_DELAY_MS = 5_000;

/** `processing` 剧本在「处理中」停留的时长（之后查询转 `SUCCESS`） */
const DEFAULT_PROCESSING_DELAY_MS = 120;

/** `amount_mismatch` 剧本在渠道侧金额上加的偏移（分） */
const AMOUNT_MISMATCH_OFFSET = 100;

/** 渠道侧的出款流水 */
interface MockPayout {
  referenceNo: string;
  providerTxnId: string;
  /** 请求里的金额（幂等重放时原样带回） */
  requestedAmount: number;
  /** 渠道侧金额（`amount_mismatch` 时与请求不同） */
  amount: number;
  status: 'SUCCESS' | 'FAILED' | 'PROCESSING';
  definitive?: boolean;
  failureReason?: string;
  /** 处理中转成功的时刻（毫秒时间戳）；`null` 表示永远停在处理中 */
  settlesAt: number | null;
  paidAt: string;
}

/** 渠道侧的支付单 */
interface MockPayment {
  paymentId: string;
  referenceNo: string;
  amount: number;
  subject: string;
  providerTxnId: string;
}

/** 退款剧本（阶段 6c） */
export type MockRefundScenario =
  'success' | 'processing' | 'reject' | 'unknown';

/** 渠道侧的退款单 */
interface MockRefund {
  refundTxnId: string;
  paymentId: string;
  amount: number;
  reason: string;
  status: 'SUCCESS' | 'PROCESSING' | 'FAILED';
  /** 处理中转成功的时刻（毫秒时间戳）；`null` = 永远停在处理中 */
  settlesAt: number | null;
  /** `FAILED` 时是否「确定没退」（决定调用方能否重试） */
  definitive?: boolean;
  failureReason?: string;
}

/** 渠道侧的一笔操作记录 */
export interface MockCallRecord {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  at: Date;
}

export interface MockChannelServerOptions {
  /** 初始场景，默认 `success` */
  scenario?: MockScenario;
  /** 回调签名密钥，默认 `DEFAULT_MOCK_WEBHOOK_SECRET` */
  webhookSecret?: string;
  /**
   * 出款是否异步。
   *
   * ⚠️ **与场景叠加**：`processing` 剧本本身总会返回 `PROCESSING`；
   *    这里为 `true` 时其它场景也先返回 `PROCESSING`、稍后由查询给出终态。
   */
  payoutAsync?: boolean;
  /** `processing` 剧本停留时长（毫秒） */
  processingDelayMs?: number;
  /** `timeout` 剧本挂住请求的时长（毫秒） */
  timeoutDelayMs?: number;
  /** 退款剧本，默认 `success`（阶段 6c） */
  refundScenario?: MockRefundScenario;
  /**
   * 退款是否异步。
   *
   * ⚠️ **与 `processingDelayMs` 叠加**：`processing` 剧本总会先返回 `PROCESSING`；
   *    这里为 `true` 时 `success` / `reject` 也先返回 `PROCESSING`，稍后由查询给出终态。
   */
  refundAsync?: boolean;
}

export interface MockChannelServer {
  /** 形如 `http://127.0.0.1:<随机端口>`，直接用作 `SANDBOX_CHANNEL_URL` */
  url: string;
  close(): Promise<void>;
  /** 切换失败注入场景 */
  setScenario(scenario: MockScenario): void;
  /** 切换退款剧本（阶段 6c） */
  setRefundScenario(scenario: MockRefundScenario): void;
  /** 当前场景 */
  scenario(): MockScenario;
  /** 收到的全部请求（断言「真的走了 HTTP」用） */
  readonly calls: readonly MockCallRecord[];
  /** 清空记录与全部单据（同一份 server 复用多个用例时用） */
  reset(): void;
}

/** 读 `SANDBOX_REFUND_SCENARIO`；非法值按 `success` 处理（不静默变成别的剧本） */
function refundScenarioFromEnv(): MockRefundScenario {
  const raw = process.env.SANDBOX_REFUND_SCENARIO;
  return raw === 'processing' || raw === 'reject' || raw === 'unknown'
    ? raw
    : 'success';
}

/**
 * 启动 mock 渠道服务（端口 `0`，内核分配）。
 *
 * @param options 场景、密钥、异步开关
 */
export async function startMockChannelServer(
  options: MockChannelServerOptions = {},
): Promise<MockChannelServer> {
  const state = {
    // ⚠️ 显式入参优先；没传才读 `.env` 里的 `SANDBOX_SCENARIO`（与 .env.example 对齐）
    scenario: options.scenario ?? scenarioFromEnv() ?? 'success',
    // 同理：`SANDBOX_PAYOUT_ASYNC` 只影响 mock 的行为，不影响 provider 的能力声明
    payoutAsync:
      options.payoutAsync ?? process.env.SANDBOX_PAYOUT_ASYNC === 'true',
    processingDelayMs: options.processingDelayMs ?? DEFAULT_PROCESSING_DELAY_MS,
    timeoutDelayMs: options.timeoutDelayMs ?? DEFAULT_TIMEOUT_DELAY_MS,
    // ⚠️ 显式入参优先；没传才读 `SANDBOX_REFUND_ASYNC`（与 .env.example 对齐）
    refundAsync:
      options.refundAsync ?? process.env.SANDBOX_REFUND_ASYNC === 'true',
    // 同理：`SANDBOX_REFUND_SCENARIO` 只影响 mock 的默认剧本
    refundScenario: options.refundScenario ?? refundScenarioFromEnv(),
    webhookSecret: options.webhookSecret ?? DEFAULT_MOCK_WEBHOOK_SECRET,
    payments: new Map<string, MockPayment>(),
    payouts: new Map<string, MockPayout>(),
    refunds: new Map<string, MockRefund>(),
    calls: [] as MockCallRecord[],
  };

  const handler: RequestListener = (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  /** 把出款流水推进到「查询时刻」应有的状态 */
  function settle(payout: MockPayout): MockPayout {
    if (
      payout.status === 'PROCESSING' &&
      payout.settlesAt !== null &&
      Date.now() >= payout.settlesAt
    ) {
      payout.status = 'SUCCESS';
      payout.paidAt = new Date().toISOString();
    }
    return payout;
  }

  function payoutResponse(payout: MockPayout): Record<string, unknown> {
    return {
      referenceNo: payout.referenceNo,
      providerTxnId: payout.providerTxnId,
      amount: payout.amount,
      status: payout.status,
      definitive:
        payout.status === 'FAILED' ? payout.definitive === true : undefined,
      failureReason: payout.failureReason,
      paidAt: payout.status === 'SUCCESS' ? payout.paidAt : undefined,
    };
  }

  /** 按场景生成一笔新的出款结果 */
  function createPayout(body: Record<string, unknown>): MockPayout {
    const referenceNo = readString(body, 'referenceNo') || randomUUID();
    const referenceId = readString(body, 'referenceId');
    const requestedAmount = Number(body.amount ?? 0);
    const now = Date.now();
    const base: MockPayout = {
      referenceNo,
      providerTxnId: `mock-payout-${randomUUID()}`,
      requestedAmount,
      amount: requestedAmount,
      status: 'SUCCESS',
      settlesAt: null,
      paidAt: new Date(now).toISOString(),
    };

    switch (state.scenario) {
      case 'reject':
        return {
          ...base,
          status: 'FAILED',
          definitive: true,
          failureReason: `沙箱模拟拒付（本次尝试单 ${referenceId || referenceNo}）`,
        };
      case 'amount_mismatch':
        return { ...base, amount: requestedAmount + AMOUNT_MISMATCH_OFFSET };
      case 'processing':
        return {
          ...base,
          status: 'PROCESSING',
          settlesAt: now + state.processingDelayMs,
        };
      case 'success':
      case 'timeout':
      default:
        if (state.payoutAsync) {
          return {
            ...base,
            status: 'PROCESSING',
            settlesAt: now + state.processingDelayMs,
          };
        }
        return base;
    }
  }

  /** 处理中转终态：到点后 `PROCESSING → SUCCESS` */
  function settleRefund(refund: MockRefund): MockRefund {
    if (
      refund.status === 'PROCESSING' &&
      refund.settlesAt !== null &&
      Date.now() >= refund.settlesAt
    ) {
      refund.status = 'SUCCESS';
    }
    return refund;
  }

  function refundResponse(refund: MockRefund): Record<string, unknown> {
    return {
      refundTxnId: refund.refundTxnId,
      paymentId: refund.paymentId,
      amount: refund.amount,
      status: refund.status,
      // ⚠️ `definitive` 只对 FAILED 有意义；其余状态不要给（给了会诱导调用方误用）
      definitive:
        refund.status === 'FAILED' ? refund.definitive === true : undefined,
      failureReason: refund.failureReason,
    };
  }

  /** 按退款剧本生成一笔新退款 */
  function createRefund(body: Record<string, unknown>): MockRefund {
    const now = Date.now();
    const base: MockRefund = {
      refundTxnId: `mock-refund-${randomUUID()}`,
      paymentId: readString(body, 'paymentId'),
      amount: Number(body.amount ?? 0),
      reason: readString(body, 'reason'),
      status: 'SUCCESS',
      settlesAt: null,
    };

    switch (state.refundScenario) {
      case 'reject':
        return {
          ...base,
          status: 'FAILED',
          // ⚠️ 明确拒付 → 允许调用方重试
          definitive: true,
          failureReason: '沙箱模拟退款被拒付',
        };
      case 'unknown':
        return {
          ...base,
          status: 'FAILED',
          // ⚠️ 结果未知 → 绝不能自动重试
          definitive: false,
          failureReason: '沙箱模拟退款结果未知',
        };
      case 'processing':
        return {
          ...base,
          status: 'PROCESSING',
          settlesAt: now + state.processingDelayMs,
        };
      case 'success':
      default:
        if (state.refundAsync) {
          return {
            ...base,
            status: 'PROCESSING',
            settlesAt: now + state.processingDelayMs,
          };
        }
        return base;
    }
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x'}`);
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const body = await readJson(req);
    state.calls.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      at: new Date(),
    });

    // ---- 支付 ----
    if (method === 'POST' && path === '/pay') {
      const paymentId = readString(body, 'referenceId');

      // ⚠️ **已授权扣款**：同一个 `/pay` 端点，带 `authorized` 标记时
      //    直接返回同步扣款结果（不建待付款单）。
      if (body.authorized === true) {
        sendJson(res, 200, {
          providerTxnId: `mock-charge-${randomUUID()}`,
          status: state.scenario === 'reject' ? 'FAILED' : 'SUCCESS',
        });
        return;
      }

      const existing = state.payments.get(paymentId);
      if (existing) {
        // ⚠️ 渠道侧幂等：同一支付单重复创建返回同一笔
        sendJson(res, 200, paymentPayload(existing));
        return;
      }
      const payment: MockPayment = {
        paymentId,
        referenceNo: readString(body, 'referenceNo'),
        amount: Number(body.amount ?? 0),
        subject: readString(body, 'subject'),
        providerTxnId: `mock-pay-${randomUUID()}`,
      };
      state.payments.set(paymentId, payment);
      sendJson(res, 200, paymentPayload(payment));
      return;
    }

    if (method === 'GET' && path.startsWith('/pay/')) {
      const paymentId = decodeURIComponent(path.slice('/pay/'.length));
      const payment = state.payments.get(paymentId);
      if (!payment) {
        sendJson(res, 404, { message: '查无此支付单' });
        return;
      }
      // ⚠️ 支付状态由回调推动，mock 侧没有确认动作 → 恒为待支付
      sendJson(res, 200, { ...paymentPayload(payment), status: 'PENDING' });
      return;
    }

    if (method === 'POST' && path === '/payment-method') {
      sendJson(res, 200, { token: `mock-pm-${randomUUID()}` });
      return;
    }

    // ---- 出款 ----
    if (method === 'POST' && path === '/payout') {
      if (state.scenario === 'timeout') {
        // ⚠️ **不回响应挂住连接** —— 这是「结果未知」的唯一真实来源
        await wait(state.timeoutDelayMs);
        res.destroy();
        return;
      }
      const referenceNo = readString(body, 'referenceNo');
      const existing = [...state.payouts.values()].find(
        (item) => item.referenceNo === referenceNo && item.status !== 'FAILED',
      );
      if (existing) {
        // ⚠️ 渠道侧幂等：已成功 / 处理中的单重复提交返回原结果
        sendJson(res, 200, payoutResponse(existing));
        return;
      }
      const payout = createPayout(body);
      state.payouts.set(payout.providerTxnId, payout);
      sendJson(res, 200, payoutResponse(payout));
      return;
    }

    if (method === 'GET' && path.startsWith('/payout/')) {
      const referenceNo = decodeURIComponent(path.slice('/payout/'.length));
      // ⚠️ **必须取「最后一次」尝试**（阶段 6 审查结论）：
      //    重试会为同一个 `referenceNo` 追加一条新流水（旧的那条是 FAILED）。
      //    取插入顺序的第一条会一直返回**上一次的 FAILED**，
      //    `scanStuck` 据此把已经打款成功的单记成失败 → 运营重试 → 重复打款。
      const payout = [...state.payouts.values()]
        .reverse()
        .find((item) => item.referenceNo === referenceNo);
      if (!payout) {
        sendJson(res, 404, { message: '查无此单' });
        return;
      }
      sendJson(res, 200, payoutResponse(settle(payout)));
      return;
    }

    if (method === 'GET' && path === '/payouts') {
      const from = Date.parse(url.searchParams.get('from') ?? '');
      const to = Date.parse(url.searchParams.get('to') ?? '');
      const page = parseIntOrNull(url.searchParams.get('page'));
      const pageSize = parseIntOrNull(url.searchParams.get('pageSize'));

      const records = [...state.payouts.values()]
        .map(settle)
        .filter((item) => {
          const at = Date.parse(item.paidAt);
          if (Number.isNaN(from) || Number.isNaN(to)) {
            return true;
          }
          // ⚠️ 时间窗左闭右开 [from, to)
          return at >= from && at < to;
        })
        .map(payoutResponse);

      // ⚠️ **契约 B**：非有限数一律回落到默认值，绝不返回空数组
      const safePage = page !== null && page > 0 ? page : 1;
      const safePageSize = pageSize !== null && pageSize > 0 ? pageSize : 500;
      const start = (safePage - 1) * safePageSize;
      sendJson(res, 200, {
        items: records.slice(start, start + safePageSize),
        total: records.length,
        page: safePage,
        pageSize: safePageSize,
      });
      return;
    }

    // ---- 退款（阶段 6c：支持异步受理 / 明确拒付 / 结果未知）----
    if (method === 'POST' && path === '/refund') {
      const refund = createRefund(body);
      state.refunds.set(refund.refundTxnId, refund);
      sendJson(res, 200, refundResponse(refund));
      return;
    }

    if (method === 'GET' && path.startsWith('/refund/')) {
      const refundTxnId = decodeURIComponent(path.slice('/refund/'.length));
      const refund = state.refunds.get(refundTxnId);
      if (!refund) {
        // ⚠️ **查无此单必须 404** —— provider 侧据此归一化成 `UNKNOWN`，
        //    绝不能因为查不到就把单子判成「已退款」或「确定失败」。
        sendJson(res, 404, { message: '查无此退款单' });
        return;
      }
      sendJson(res, 200, refundResponse(settleRefund(refund)));
      return;
    }

    // ---- 回调投递 ----
    if (method === 'POST' && path === '/webhook') {
      const target = readString(body, 'url');
      const event = (body.event ?? {}) as Record<string, unknown>;
      if (target.length === 0) {
        sendJson(res, 400, { message: '缺少 url' });
        return;
      }
      const raw = Buffer.from(JSON.stringify(event), 'utf8');
      const signature = createHmac('sha256', state.webhookSecret)
        .update(raw)
        .digest('hex');
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [MOCK_SIGNATURE_HEADER]: signature,
        },
        body: raw,
      });
      // ⚠️ 渠道侧只关心「受理」：投递本身已发出，回 202
      sendJson(res, 202, { delivered: true, status: response.status });
      return;
    }

    sendJson(res, 404, { message: `mock 渠道不支持 ${method} ${path}` });
  }

  function paymentPayload(payment: MockPayment): Record<string, unknown> {
    return {
      providerTxnId: payment.providerTxnId,
      payload: { url: `${baseUrl}/pay/${payment.paymentId}` },
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  return {
    url: baseUrl,
    calls: state.calls,
    scenario: () => state.scenario,
    setRefundScenario(scenario: MockRefundScenario): void {
      state.refundScenario = scenario;
    },
    setScenario(scenario: MockScenario): void {
      if (!MOCK_SCENARIOS.includes(scenario)) {
        throw new Error(`未知的 mock 场景：${scenario}`);
      }
      state.scenario = scenario;
    },
    reset(): void {
      state.calls.length = 0;
      state.payments.clear();
      state.payouts.clear();
      state.refunds.clear();
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // ⚠️ `timeout` 剧本里挂住的连接会让 close 一直等 —— 主动断开
        server.closeAllConnections();
      });
    },
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  if (res.headersSent || res.destroyed) {
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  // ⚠️ 异步迭代里的 chunk 是 `any`：显式收窄，别让 lint 的 unsafe 规则放行
  for await (const chunk of req as AsyncIterable<unknown>) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? Buffer.from(chunk)
        : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk)),
    );
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 读环境变量里的初始场景；未设置 / 不合法返回 `null` */
function scenarioFromEnv(): MockScenario | null {
  const raw = (process.env.SANDBOX_SCENARIO ?? '').trim();
  return MOCK_SCENARIOS.includes(raw as MockScenario)
    ? (raw as MockScenario)
    : null;
}

/** 从报文里读一个字符串字段；缺失 / 非字符串返回空串 */
function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function parseIntOrNull(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
