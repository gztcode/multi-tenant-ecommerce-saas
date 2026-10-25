/**
 * 护栏：多标签页「先后」刷新竞态（L20）。
 *
 * ## 这个护栏守的是什么
 *
 * 阶段 4 验收实测：**商家在后台开第二个标签页，就会被踢下线**。
 *
 * 失效链（已核实）：
 * 1. 刷新令牌存在**浏览器 cookie** 里，**跨标签页共享**——所以每个标签页
 *    拿到的是**同一枚**旧令牌 T0。
 * 2. 标签页 A 刷新成功 → 后端把 T0 标记 `ROTATED`、下发新令牌 T1。
 * 3. 标签页 B 之后用 T0 刷新 → 后端 `auth.service.ts` 的
 *    `isConcurrentRace` 判否（轮换时间早于 B 的请求起始时间）→ 落到
 *    「③ 真正的重放」→ `revokeTokenFamily` → **吊销该用户全部设备的登录**。
 *
 * ## 为什么前端能救
 *
 * 根因在后端（刷新是**轮换**式的，且没有宽限期），那属于阶段 5。
 * 但前端可以把「多个标签页先后用同一枚旧令牌」这件事**消掉**：
 * 让**同一时刻只有一个标签页去刷新**，刷新完把结果广播出去，
 * 其它标签页直接用新的（cookie jar 本来就是共享的）。
 *
 * ⚠️ **这是缓解，不是根治**（见 `src/lib/session-sync.ts` 的文件头注释）：
 * 多浏览器 / 多设备之间没有共享的 cookie jar，前端救不了，
 * 后端的宽限期改造仍然必要。
 *
 * ## 为什么不需要 jsdom
 *
 * `BroadcastChannel` 是 Node 18+ 的全局（来自 `worker_threads`），
 * jsdom 反而**没有**实现它。所以这个测试在 **node 环境**下跑，
 * 两份前端（storefront / merchant-admin）的这个测试文件也逐行一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionSync, type StorageLike } from '@/lib/session-sync';

/**
 * localStorage 的内存实现。
 *
 * ⚠️ node 环境**没有** localStorage（只有浏览器有），
 * 所以单元测试必须塞一个进去。多个标签页**共用同一个实例**
 * ——这正是「跨标签页共享」在测试里的对应物。
 */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** 造一个成功的会话响应（响应体不重要，重要的是它带 Set-Cookie） */
function sessionResponse(): Response {
  return new Response(JSON.stringify({ user: { email: 'm@x.com' } }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': 'authjs.session-token=new; Path=/; HttpOnly',
    },
  });
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe('多标签页会话同步', () => {
  it('没有别的标签页时，自己去刷新一次', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      // ⚠️ 每次调用都造**新的** Response：同一个 Response 的 body 只能读一次，
      // 复用会让第二次调用抛「Body is unusable」（阶段 4 踩过）。
      Promise.resolve(sessionResponse()),
    );

    const sync = createSessionSync({
      channelName: 'test-single',
      endpoint: '/api/auth/session',
      fetchImpl,
      claimWindowMs: 5,
      storage: memoryStorage(),
    });
    cleanups.push(() => sync.stop());

    const outcome = await sync.start();

    expect(outcome).toBe('refreshed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/session');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
  });

  it('别的标签页已经刷过了，自己就不再刷（避免重放旧令牌）', async () => {
    // 模拟「标签页 A 刚刷完，标签页 B 这时才起来」。
    //
    // ⚠️ B 醒来时 A 的广播早就发完了（广播是瞬时的），B 只能靠
    // `localStorage` 里记下的「最近一次刷新时间」判断。
    const storage = memoryStorage();
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(sessionResponse()),
    );

    // 先起一个「A」，让它刷完。
    const tabA = createSessionSync({
      channelName: 'test-two-tabs',
      endpoint: '/api/auth/session',
      fetchImpl,
      claimWindowMs: 5,
      storage,
    });
    cleanups.push(() => tabA.stop());
    expect(await tabA.start()).toBe('refreshed');

    // 再起「B」，它应该看到「刚刚刷过」而跳过刷新。
    const fetchImplB = vi.fn().mockImplementation(() =>
      Promise.resolve(sessionResponse()),
    );
    const tabB = createSessionSync({
      channelName: 'test-two-tabs',
      endpoint: '/api/auth/session',
      fetchImpl: fetchImplB,
      claimWindowMs: 5,
      storage,
    });
    cleanups.push(() => tabB.stop());

    const outcome = await tabB.start();

    expect(outcome).toBe('skipped');
    expect(fetchImplB).not.toHaveBeenCalled();
  });

  it('两个标签页同时起来，只有一个真的去刷新', async () => {
    // ⚠️ 这是最要紧的一条：两个标签页**同时**触发刷新时，
    // 两个请求都带着同一枚旧令牌 T0 打过去 → 后端轮换掉 T0 →
    // 第二个被判成「真正的重放」→ 吊销该用户所有设备的登录。
    const storage = memoryStorage();
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(sessionResponse()),
    );

    const tabA = createSessionSync({
      channelName: 'test-race',
      endpoint: '/api/auth/session',
      fetchImpl,
      claimWindowMs: 20,
      storage,
    });
    const tabB = createSessionSync({
      channelName: 'test-race',
      endpoint: '/api/auth/session',
      fetchImpl,
      claimWindowMs: 20,
      storage,
    });
    cleanups.push(() => tabA.stop());
    cleanups.push(() => tabB.stop());

    const [outcomeA, outcomeB] = await Promise.all([
      tabA.start(),
      tabB.start(),
    ]);

    // 两个标签页里恰好一个去刷、另一个跳过
    expect([outcomeA, outcomeB].filter((o) => o === 'refreshed')).toHaveLength(1);
    expect([outcomeA, outcomeB].filter((o) => o === 'skipped')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('刷新失败不算「已同步」，也不该把会话作废', async () => {
    // 后端没起来（网络失败）不该让用户掉登录——
    // 保留旧令牌，下次再试（与 token-refresh 的「网络失败 ≠ 凭证失效」一致）。
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const sync = createSessionSync({
      channelName: 'test-network-fail',
      endpoint: '/api/auth/session',
      fetchImpl,
      claimWindowMs: 5,
      storage: memoryStorage(),
    });
    cleanups.push(() => sync.stop());

    const outcome = await sync.start();

    expect(outcome).toBe('failed');
  });

  it('刷新失败后占位要撤销，否则之后的标签页会一直以为「已经刷过了」', async () => {
    // ⚠️ 这条防的是「一次网络抖动把刷新功能永久卡死」：
    // 占位没撤销 → 幂等窗口内的其它标签页都跳过刷新 → 令牌再也刷不出来。
    const storage = memoryStorage();
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const tabA = createSessionSync({
      channelName: 'test-clear-claim',
      endpoint: '/api/auth/session',
      fetchImpl,
      claimWindowMs: 5,
      storage,
    });
    cleanups.push(() => tabA.stop());
    expect(await tabA.start()).toBe('failed');

    // 紧接着再起一个标签页：占位已撤销 → 它应该自己去刷。
    const fetchImplB = vi.fn().mockImplementation(() =>
      Promise.resolve(sessionResponse()),
    );
    const tabB = createSessionSync({
      channelName: 'test-clear-claim',
      endpoint: '/api/auth/session',
      fetchImpl: fetchImplB,
      claimWindowMs: 5,
      storage,
    });
    cleanups.push(() => tabB.stop());

    expect(await tabB.start()).toBe('refreshed');
    expect(fetchImplB).toHaveBeenCalledTimes(1);
  });

  it('后端明确拒绝（401/403）时如实报告失败，不假装同步成功', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401 }));

    const sync = createSessionSync({
      channelName: 'test-401',
      endpoint: '/api/auth/session',
      fetchImpl,
      claimWindowMs: 5,
      storage: memoryStorage(),
    });
    cleanups.push(() => sync.stop());

    const outcome = await sync.start();

    expect(outcome).toBe('failed');
  });

  it('stop() 之后不再发请求', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(sessionResponse()),
    );

    const sync = createSessionSync({
      channelName: 'test-stop',
      endpoint: '/api/auth/session',
      fetchImpl,
      claimWindowMs: 5,
      storage: memoryStorage(),
    });

    await sync.start();
    const callsAfterStart = fetchImpl.mock.calls.length;
    sync.stop();

    expect(await sync.start()).toBe('skipped');
    expect(fetchImpl.mock.calls.length).toBe(callsAfterStart);
  });
});
