import { transactionOptions } from './transaction-options';

describe('事务选项', () => {
  const saved = process.env.PRISMA_TX_TIMEOUT_MS;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.PRISMA_TX_TIMEOUT_MS;
    } else {
      process.env.PRISMA_TX_TIMEOUT_MS = saved;
    }
  });

  it('未设置时用 10 秒（生产默认）', () => {
    delete process.env.PRISMA_TX_TIMEOUT_MS;

    expect(transactionOptions()).toEqual({ maxWait: 10_000, timeout: 10_000 });
  });

  it('正数覆盖 maxWait 与 timeout（CI 慢环境放宽）', () => {
    process.env.PRISMA_TX_TIMEOUT_MS = '30000';

    expect(transactionOptions()).toEqual({ maxWait: 30_000, timeout: 30_000 });
  });

  it('非法值（非数字 / 0 / 负数）落回默认', () => {
    for (const value of ['abc', '0', '-1']) {
      process.env.PRISMA_TX_TIMEOUT_MS = value;
      expect(transactionOptions()).toEqual({
        maxWait: 10_000,
        timeout: 10_000,
      });
    }
  });
});
