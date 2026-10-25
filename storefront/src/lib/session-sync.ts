/**
 * 多标签页之间的会话同步。
 *
 * ## 这个模块解决什么问题
 *
 * 阶段 4 验收实测：**商家在后台开第二个标签页，就会被踢下线**。
 *
 * 失效链（已核实）：
 * 1. 刷新令牌存在**浏览器 cookie** 里（NextAuth 的 `authjs.session-token`），
 *    而 cookie jar 是**跨标签页共享**的——所以每个标签页拿到的都是
 *    **同一枚**旧令牌 T0。
 * 2. 标签页 A 刷新成功 → 后端把 T0 标记 `ROTATED`、下发新令牌 T1。
 * 3. 标签页 B 之后用 T0 刷新 → 后端 `api/src/modules/auth/auth.service.ts`
 *    的 `isConcurrentRace` 判否（轮换时间早于 B 的请求起始时间）→
 *    落到「③ 真正的重放」→ `revokeTokenFamily` → **吊销该用户全部设备的登录**。
 *
 * 前端的防线：**同一时刻只让一个标签页去刷新**，刷完把结果广播出去，
 * 其它标签页直接用刷新后的 cookie。
 *
 * ⚠️ **cookie jar 本来就是跨标签页共享的**，所以刷新完**不需要**把令牌
 * 本身传来传去——只要**别让第二个标签页再用旧令牌去刷**就够了。
 * （任务书里说的「广播 refreshToken」在这个架构下是**多余且有害**的：
 * 把长期凭证写进 JS 可读的存储，等于把它从 HttpOnly 降级成 XSS 可读。
 * 这里**只广播一个时间戳**，不广播任何令牌。）
 *
 * ## ⚠️ 这是缓解，不是根治
 *
 * 后端的刷新是**轮换**式的且**没有宽限期**（RFC 9700 建议旧令牌在窗口内
 * 仍可用、且应返回同一枚新令牌）——那才是根治，属于**阶段 5**。
 *
 * 这个模块**只解决同源多标签页**的场景：
 * - **多浏览器 / 多设备**之间**没有共享的 cookie jar**，
 *   各自的刷新令牌是各自独立的，不会互相踩；
 *   但也**共享不了**刷新结果，所以后端的宽限期改造**仍然必要**。
 * - 同源多标签页之外的**同一枚令牌被两处使用**的场景
 *   （例如用户复制了会话 cookie 到别处），前端也救不了。
 *
 * ## 为什么刷新请求打到 `/api/auth/session`（同源）而不是直接打后端
 *
 * 后端的 `/auth/refresh` 会返回新令牌，但**新令牌要落到浏览器的 cookie 里**
 * 才能被下次请求带上。而 cookie 是 **HttpOnly** 的，客户端 JS 读不到、
 * 也写不了——只有**同源的 Route Handler** 能通过响应头 `Set-Cookie` 写它。
 *
 * `/api/auth/session` 是 NextAuth **自带**的 Route Handler
 * （`src/app/api/auth/[...nextauth]/route.ts` 导出的那个）：
 * 它会跑 `jwt` 回调（也就是刷新），并把刷新后的会话 cookie 写进响应头。
 * 浏览器收到 `Set-Cookie` 就更新 cookie jar——
 * **那个 cookie jar 是所有标签页共享的**，于是所有标签页一起拿到了新令牌。
 *
 * ⚠️ Server Component 里的 `await auth()` **做不到**这件事：
 * next-auth 的那条分支只取响应体（`parseSessionResponse`），把响应头丢掉了；
 * 而 Next.js 又只允许在 Server Action 或 Route Handler 里写 cookie。
 * 这两点合起来就是本模块必须走 Route Handler 的原因。
 *
 * ## 竞态（两个标签页同时刷）
 *
 * 两个标签页**完全同时**触发刷新时，两个请求会带着同一枚 T0 打过去。
 * 两道防线：
 *
 * 1. **先占位再刷新**：抢到名额的标签页**先**把「有人正在刷」写进
 *    `localStorage`，**再**发请求。同一瞬间启动的另一个标签页读到占位就
 *    让路，不会跟着刷。
 * 2. **服务端的在途去重**：两个 `/api/auth/session` 请求打到
 *    **同一个 Next.js 进程**，`src/lib/token-refresh.ts` 的
 *    `inFlightRefreshes` 会把同一枚令牌的并发刷新**合并成一次**——
 *    所以后端只轮换一次，不会判成重放。
 *
 * ⚠️ 第 2 条依赖「两个请求落在同一个 Next.js 进程」。
 * 扩副本后必须换成 Redis 侧的分布式锁，或让后端提供幂等刷新端点
 * （设计文档 §5.1 的 L19 / §七 遗留项 12）。
 */

/** 同步的结果。 */
export type SyncOutcome =
  /** 本标签页去刷新了。 */
  | 'refreshed'
  /** 别的标签页刚刷新过（或正在刷），本标签页直接用刷新后的 cookie（没发请求）。 */
  | 'skipped'
  /** 刷新没成功（网络失败或后端拒绝）。旧令牌保留，下次再试。 */
  | 'failed';

export interface SessionSyncOptions {
  /** 广播频道名。同源同浏览器的标签页会收到彼此的消息。 */
  channelName?: string;
  /** 存放「最近一次刷新」时间的 localStorage 键。 */
  storageKey?: string;
  /** 刷新会话的同源地址。必须是 Route Handler（它才能写回 cookie）。 */
  endpoint?: string;
  /** 实际发请求的函数。测试用假实现替换。 */
  fetchImpl?: typeof fetch;
  /** 抢占窗口（毫秒）：广播 claim 后等这么久，看有没有别人已经刷过。 */
  claimWindowMs?: number;
  /**
   * 「刷新结果有多新算数」的窗口（毫秒）。
   *
   * ⚠️ 这是**幂等窗口**：在这个窗口内再开一个标签页，它会直接复用
   * 刚才那次刷新的结果（cookie jar 已经是新的了），不再发请求。
   * 窗口取 0 就退化成「每个标签页都自己刷一次」——那正是要避免的。
   */
  freshnessMs?: number;
  /** 收到别的标签页「已刷新」的广播时的回调。 */
  onSynced?: () => void;
  /** localStorage 实现。测试用假实现替换（node 环境没有 localStorage）。 */
  storage?: StorageLike | null;
}

/**
 * localStorage 的最小接口。
 *
 * ⚠️ 单独定义而不是直接用 DOM 的 `Storage`：
 * node 环境（单元测试）里没有 `localStorage`，
 * 用这个接口就能塞一个内存实现进去测。
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const DEFAULT_CHANNEL_NAME = 'ecommerce.session-sync';
const DEFAULT_STORAGE_KEY = 'ecommerce.session-sync.last-refresh';
/**
 * 默认的刷新地址。
 *
 * ⚠️ 必须是 **NextAuth 自带的** `/api/auth/session`——
 * 那条路由会跑 `jwt` 回调（刷新）并把刷新后的会话 cookie 写进响应头，
 * 浏览器收到就更新 cookie jar。详见文件头的说明。
 */
const DEFAULT_ENDPOINT = '/api/auth/session';
const DEFAULT_CLAIM_WINDOW_MS = 150;
/** 幂等窗口：30 秒。够覆盖「开第二个标签页」的动作，又不至于让令牌真的该刷时刷不了。 */
const DEFAULT_FRESHNESS_MS = 30_000;

/** 频道里的两类消息。 */
type SyncMessage =
  /** 「我刷完了」——别人收到就知道 cookie 已经是新的了，别刷。 */
  | { type: 'done'; at: number; id: string }
  /** 「我正在刷」——别人收到就让路，别跟着刷。 */
  | { type: 'claim'; at: number; id: string };

/**
 * `localStorage` 里存的状态。
 *
 * ⚠️ **只有时间戳与实例 id，没有任何令牌**。
 */
interface SyncState {
  /** 最近一次刷新（或占位）发生的时间（Unix 毫秒）。 */
  at: number;
  /** 占位者的实例 id。 */
  owner: string;
}

/** 本标签页的实例标识。用来识别「自己发的消息」（广播不会回送给发送方）。 */
let instanceCounter = 0;

export interface SessionSync {
  /** 跑一次同步。返回结果。 */
  start(): Promise<SyncOutcome>;
  /** 停掉：不再监听广播，也不再发。 */
  stop(): void;
}

/** 浏览器里的 localStorage；node 环境（单元测试）没有，返回 null。 */
function defaultStorage(): StorageLike | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

/**
 * 造一个会话同步器。
 *
 * ⚠️ **不自动开始**——由调用方决定什么时候同步（组件挂载时、页面可见时……）。
 * 这样它才能进单元测试（Node 的 `BroadcastChannel` 与浏览器的行为一致，
 * jsdom 反而**没有**实现 `BroadcastChannel`）。
 */
export function createSessionSync(
  options: SessionSyncOptions = {},
): SessionSync {
  const channelName = options.channelName ?? DEFAULT_CHANNEL_NAME;
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const claimWindowMs = options.claimWindowMs ?? DEFAULT_CLAIM_WINDOW_MS;
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const onSynced = options.onSynced;

  const storage =
    options.storage === undefined ? defaultStorage() : options.storage;

  instanceCounter += 1;
  const id = `sync-${instanceCounter}`;

  // ⚠️ **BroadcastChannel 不是所有环境都有**（老浏览器、以及某些 SSR 环境）。
  // 没有它就退化成「单标签页」——本标签页自己刷，多标签页的竞态回到老样子，
  // 但**不会更糟**（总比没有这个模块强）。
  const channel: BroadcastChannel | null =
    typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(channelName)
      : null;

  let stopped = false;

  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as SyncMessage | null;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'done') {
        // 别的标签页刷完了 → 我们的 cookie 已经是新的 → 不用再刷。
        writeState(message.at, message.id);
        onSynced?.();
      }
    };
  }

  /**
   * 记住「最近一次刷新发生在什么时候，由哪个标签页占的名」。
   *
   * ⚠️ localStorage 的**值必须是字符串**——这里存的是 JSON 字符串。
   * ⚠️ **绝对不存任何令牌**：这个键是 JS 可读的，
   * 把长期凭证写进来等于把 HttpOnly 的保护降级成 XSS 可读。
   * 这里只存时间戳与一个随机的实例 id。
   */
  function writeState(at: number, owner: string): void {
    if (!storage) return;
    try {
      storage.setItem(storageKey, JSON.stringify({ at, owner }));
    } catch {
      // 隐私模式下 localStorage 会抛（配额/禁用）。**不影响主流程**——
      // 没有了跨标签页的幂等，退化成「每个标签页自己刷一次」而已。
    }
  }

  /** 读出当前的状态；没有就返回 null。 */
  function readState(): SyncState | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(storageKey);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const state = parsed as { at?: unknown; owner?: unknown };
      if (typeof state.at !== 'number' || !Number.isFinite(state.at)) return null;
      return {
        at: state.at,
        owner: typeof state.owner === 'string' ? state.owner : '',
      };
    } catch {
      return null;
    }
  }

  /**
   * 抢「去刷新」的名额。
   *
   * ⚠️ `localStorage` 没有原子的 compare-and-set，但**「写完再读回」**
   * 近似地实现了它：两个标签页同时写时，最后写入的那个会看到
   * **自己**的值（它写得更晚），而先写的那个读回来会看到**别人**的值 →
   * 先写的那个让路。
   *
   * ⚠️ 这个协议**不是**严格的互斥（两个标签页的写-读完全交错时仍可能双赢）。
   * 真正的兜底是**服务端**的在途去重
   * （`token-refresh.ts` 的 `inFlightRefreshes`）——
   * 两个请求打到同一个 Next.js 进程，后端只会轮换一次，不会判成重放。
   */
  function tryClaim(): boolean {
    if (!storage) return true;
    const now = Date.now();
    writeState(now, id);
    // 写完读回：值不是自己写的 → 有人抢先了。
    const state = readState();
    if (state && state.owner !== id) {
      // 别人的占位**还新鲜** → 让路；已经不新鲜（那个人挂了/超时了）→ 接管。
      if (now - state.at < freshnessMs) return false;
      writeState(now, id);
      const after = readState();
      return !after || after.owner === id;
    }
    return true;
  }

  /** 最近一次刷新是不是**新到足以复用**。 */
  function isFresh(): boolean {
    const state = readState();
    if (state === null) return false;
    return Date.now() - state.at < freshnessMs;
  }

  /**
   * 等一小段窗口，看有没有别的标签页已经刷完了。
   *
   * ⚠️ 这是**启发式**的，不是真正的互斥：
   * 两个标签页在同一瞬间启动时，谁都看不到对方的「已刷新」，
   * 于是两个都会去刷。真正的防线是**服务端**的在途去重
   * （`token-refresh.ts` 的 `inFlightRefreshes`）——
   * 两个请求打到同一个 Next.js 进程，后端只会轮换一次。
   */
  function waitForOthers(): Promise<boolean> {
    if (!channel) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        channel.removeEventListener('message', onMessage);
        resolve(result);
      };
      const onMessage = (event: MessageEvent) => {
        const message = event.data as SyncMessage | null;
        if (message && message.type === 'done') {
          finish(true);
        }
      };
      channel.addEventListener('message', onMessage);
      const timer = setTimeout(() => finish(false), claimWindowMs);
    });
  }

  async function start(): Promise<SyncOutcome> {
    if (stopped) return 'skipped';

    // ① 已经有一次**新近的**刷新 → cookie jar 里已经是新令牌了，直接复用。
    //
    // ⚠️ 这一条治的是「**后开的**标签页」：它错过了 A 广播的 `done`，
    // 但 `localStorage` 里的时间戳还在（广播是瞬时的，存储是持久的）。
    if (isFresh()) return 'skipped';

    // ② 抢名额：先占位再干活。
    //    ⚠️ 「写完读回」不是严格的互斥（两个标签页的写-读完全交错时仍可能双赢），
    //    但它挡住了绝大多数情况；剩下的由**服务端**的在途去重兜底。
    if (!tryClaim()) return 'skipped';

    // ③ 亮明「我要去刷了」，让**已经醒着**的标签页让路。
    channel?.postMessage({
      type: 'claim',
      at: Date.now(),
      id,
    } satisfies SyncMessage);

    // ④ 等一小段窗口：这期间有别的标签页刷完了，就不用我们刷。
    const someoneElseDidIt = await waitForOthers();
    if (stopped) return 'skipped';
    if (someoneElseDidIt) {
      // 让路给那位 → 撤销占位（它刷完后会写自己的）。
      clearClaim();
      return 'skipped';
    }

    try {
      const response = await fetchImpl(endpoint, {
        method: 'GET',
        cache: 'no-store',
      });
      if (!response.ok) {
        // ⚠️ **后端明确拒绝**（401/403）：会话真的没了。
        // 这里**只报告失败**，不去作废任何东西——作废与否由
        // `src/auth.ts` 的会话回调决定，不在这里越权。
        //
        // ⚠️ 占位要**撤销**：不然这一轮失败之后，接下来的窗口内
        // 别的标签页都会以为「已经刷过了」而跳过刷新，
        // 令牌就再也刷不出来了。
        clearClaim();
        return 'failed';
      }
    } catch {
      // ⚠️ **网络失败**：请求没发出去或没拿到响应。
      // 保留旧令牌，下次再试（与 `token-refresh.ts` 的
      // 「网络失败 ≠ 凭证失效」一致）。一次抖动就把商家踢出登录是不可逆的。
      clearClaim();
      return 'failed';
    }

    if (stopped) return 'skipped';

    // ⑤ 刷完了 → 记下时间并告诉别的标签页「cookie 已经是新的了，别刷」。
    writeState(Date.now(), id);
    channel?.postMessage({
      type: 'done',
      at: Date.now(),
      id,
    } satisfies SyncMessage);
    return 'refreshed';
  }

  /** 撤销占位（刷新失败时用）。 */
  function clearClaim(): void {
    if (!storage) return;
    try {
      storage.removeItem(storageKey);
    } catch {
      // 同上：写不了就算了，不影响主流程。
    }
  }

  function stop(): void {
    stopped = true;
    channel?.close();
  }

  return { start, stop };
}
