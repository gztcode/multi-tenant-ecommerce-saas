/**
 * 多标签页会话同步。
 *
 * ⚠️ 这个模块守的是「开第二个标签页就被踢下线」：
 * 两个标签页带着同一枚旧刷新令牌去刷，后到的那个会被后端判成重放，
 * 吊销该用户**所有设备**的登录。所以同一时刻只能有一个标签页去刷。
 *
 * 测试里每个用例用**独立的频道名**，避免用例之间通过 BroadcastChannel 串味。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createSessionSync,
  type SessionSyncOptions,
  type StorageLike,
} from '../src/session-sync';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  dump(): Record<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    dump: () => Object.fromEntries(data),
  };
}

const STORAGE_KEY = 'test.sync.last-refresh';

let channelSeq = 0;
/** 每个用例一个独立频道 + 固定 storage 键，互不干扰 */
function uniqueChannel(): string {
  channelSeq += 1;
  return `test-session-sync-${channelSeq}`;
}

function okFetch() {
  return vi.fn(async () => new Response('{}', { status: 200 }));
}

function options(overrides: SessionSyncOptions = {}): SessionSyncOptions {
  return {
    channelName: uniqueChannel(),
    storageKey: STORAGE_KEY,
    claimWindowMs: 20,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storedAt(storage: ReturnType<typeof memoryStorage>, key = STORAGE_KEY): number | null {
  const raw = storage.dump()[key];
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { at?: unknown };
  return typeof parsed.at === 'number' ? parsed.at : null;
}

describe('单标签页', () => {
  it('没有新近的刷新记录 → 自己去刷新，并记下时间', async () => {
    const storage = memoryStorage();
    const fetchImpl = okFetch();
    const sync = createSessionSync(
      options({ storage, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    try {
      await expect(sync.start()).resolves.toBe('refreshed');

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/auth/session');
      expect(init.method).toBe('GET');
      expect(init.cache).toBe('no-store');

      const at = storedAt(storage);
      expect(at).not.toBeNull();
      expect(Date.now() - at!).toBeLessThan(5_000);
    } finally {
      sync.stop();
    }
  });

  it('⚠️ 刚刷过（幂等窗口内）→ skipped，且不发请求', async () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ at: Date.now() - 1_000, owner: 'other-tab' }),
    });
    const fetchImpl = okFetch();
    const sync = createSessionSync(
      options({ storage, fetchImpl: fetchImpl as unknown as typeof fetch, freshnessMs: 30_000 }),
    );

    try {
      await expect(sync.start()).resolves.toBe('skipped');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      sync.stop();
    }
  });

  it('别人的占位已经过期 → 接管去刷新（不会永远没人刷）', async () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ at: Date.now() - 10_000, owner: 'dead-tab' }),
    });
    const fetchImpl = okFetch();
    const sync = createSessionSync(
      options({
        storage,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        freshnessMs: 1_000,
      }),
    );

    try {
      await expect(sync.start()).resolves.toBe('refreshed');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      sync.stop();
    }
  });

  it('没有 localStorage（storage 为 null）也能工作，只是没有跨标签页幂等', async () => {
    const fetchImpl = okFetch();
    const sync = createSessionSync(
      options({ storage: null, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    try {
      await expect(sync.start()).resolves.toBe('refreshed');
      await expect(sync.start()).resolves.toBe('refreshed');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      sync.stop();
    }
  });

  it('storage 抛错（隐私模式）不影响刷新', async () => {
    const brokenStorage: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const fetchImpl = okFetch();
    const sync = createSessionSync(
      options({ storage: brokenStorage, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    try {
      await expect(sync.start()).resolves.toBe('refreshed');
    } finally {
      sync.stop();
    }
  });
});

describe('失败路径', () => {
  it('后端返回 401 → failed，并撤销占位（下一个标签页还能再刷）', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    const sync = createSessionSync({
      ...options({ storage, fetchImpl: fetchImpl as unknown as typeof fetch }),
      claimWindowMs: 10,
    });

    try {
      await expect(sync.start()).resolves.toBe('failed');
      // ⚠️ 占位必须撤销：不然窗口内别的标签页都会以为「已经刷过了」，
      //    令牌就再也刷不出来
      expect(storage.dump()[STORAGE_KEY]).toBeUndefined();
    } finally {
      sync.stop();
    }
  });

  it('网络异常 → failed，并撤销占位', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const sync = createSessionSync(
      options({ storage, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    try {
      await expect(sync.start()).resolves.toBe('failed');
      expect(storage.dump()[STORAGE_KEY]).toBeUndefined();
    } finally {
      sync.stop();
    }
  });

  it('失败之后，同一个标签页能重新抢到名额', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response('', { status: calls === 1 ? 500 : 200 });
    });
    const sync = createSessionSync(
      options({ storage, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    try {
      await expect(sync.start()).resolves.toBe('failed');
      await expect(sync.start()).resolves.toBe('refreshed');
      expect(calls).toBe(2);
    } finally {
      sync.stop();
    }
  });
});

describe('多标签页', () => {
  it('⚠️ 两个标签页同时启动 → 只有一个去刷新，另一个 skipped，请求只发一次', async () => {
    const channelName = uniqueChannel();
    const storage = memoryStorage();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      // 让刷新慢一点，另一个标签页才有机会看到 claim
      await sleep(30);
      return new Response('{}', { status: 200 });
    });

    const tabA = createSessionSync({
      channelName,
      storageKey: STORAGE_KEY,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      claimWindowMs: 60,
    });
    const tabB = createSessionSync({
      channelName,
      storageKey: STORAGE_KEY,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      claimWindowMs: 60,
    });

    try {
      const outcomes = await Promise.all([tabA.start(), tabB.start()]);

      expect(outcomes.filter((outcome) => outcome === 'refreshed')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'skipped')).toHaveLength(1);
      expect(calls).toBe(1);
    } finally {
      tabA.stop();
      tabB.stop();
    }
  });

  it('A 刷完之后 B 再启动 → B 直接 skipped（复用 A 的结果）', async () => {
    const channelName = uniqueChannel();
    const storage = memoryStorage();
    const fetchImpl = okFetch();

    const tabA = createSessionSync({
      channelName,
      storageKey: STORAGE_KEY,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      claimWindowMs: 10,
    });
    const tabB = createSessionSync({
      channelName,
      storageKey: STORAGE_KEY,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      claimWindowMs: 10,
    });

    try {
      await expect(tabA.start()).resolves.toBe('refreshed');
      await expect(tabB.start()).resolves.toBe('skipped');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      tabA.stop();
      tabB.stop();
    }
  });

  it('收到别的标签页的 done 广播 → 记下时间并回调 onSynced', async () => {
    const channelName = uniqueChannel();
    const storage = memoryStorage();
    const onSynced = vi.fn();

    const listener = createSessionSync({ channelName, storageKey: STORAGE_KEY, storage, onSynced });
    const refresher = createSessionSync({
      channelName,
      storageKey: STORAGE_KEY,
      storage: memoryStorage(),
      fetchImpl: okFetch() as unknown as typeof fetch,
      claimWindowMs: 10,
    });

    try {
      await expect(refresher.start()).resolves.toBe('refreshed');
      await vi.waitFor(() => expect(onSynced).toHaveBeenCalled());

      const at = storedAt(storage);
      expect(at).not.toBeNull();
      expect(Date.now() - at!).toBeLessThan(5_000);
    } finally {
      listener.stop();
      refresher.stop();
    }
  });
});

describe('stop', () => {
  it('停止之后 start 一律 skipped，不发请求', async () => {
    const fetchImpl = okFetch();
    const sync = createSessionSync(
      options({ storage: memoryStorage(), fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    sync.stop();

    await expect(sync.start()).resolves.toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('等待窗口期间被 stop → skipped，不发请求', async () => {
    const storage = memoryStorage();
    const fetchImpl = okFetch();
    const sync = createSessionSync(
      options({ storage, fetchImpl: fetchImpl as unknown as typeof fetch, claimWindowMs: 200 }),
    );

    try {
      const pending = sync.start();
      sync.stop();

      await expect(pending).resolves.toBe('skipped');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      sync.stop();
    }
  });
});
