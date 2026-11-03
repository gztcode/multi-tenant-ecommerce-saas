/**
 * 平台默认出款渠道服务的单元测试（阶段 6a Task 4）。
 *
 * ⚠️ **只测纯逻辑，不碰数据库** —— 全部用例跑在「假 Prisma client」上，
 *    只断言 service 有没有调用正确的 Prisma 方法。
 */
import { ConflictException, BadRequestException } from '@nestjs/common';
import {
  PAYOUT_DEFAULT_CHANNEL_KEY,
  PlatformSettingService,
} from './platform-setting.service';

/**
 * 假 Prisma client。
 *
 * ⚠️ **`findUnique` / `upsert` 的签名显式声明** —— `jest.fn(() => ...)`
 *    会被推断成**零参元组**，`mock.calls[0][0]` 就成了类型错误
 *    （jest 的 transform 不做完整类型检查，单测能跑过、`tsc --noEmit` 却会红）。
 */
interface FakePlatformSettingDelegate {
  findUnique: jest.Mock<Promise<unknown>, [{ where: { key: string } }]>;
  upsert: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
}

interface FakePrisma {
  platformSetting: FakePlatformSettingDelegate;
}

function makePrisma(
  overrides: Partial<FakePlatformSettingDelegate> = {},
): FakePrisma {
  return {
    platformSetting: {
      findUnique: jest.fn<Promise<unknown>, [{ where: { key: string } }]>(() =>
        Promise.resolve(null),
      ),
      upsert: jest.fn<Promise<unknown>, [Record<string, unknown>]>(() =>
        Promise.resolve({}),
      ),
      ...overrides,
    },
  };
}

function makeService(prisma: FakePrisma): PlatformSettingService {
  return new PlatformSettingService(prisma as never);
}

describe('PlatformSettingService', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL;
    process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL = 'fake-payout';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL;
    } else {
      process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL = originalEnv;
    }
  });

  it('DB 无行、env 有值 → 回落 ENV 兜底', async () => {
    const prisma = makePrisma();
    const result = await makeService(prisma).getPayoutDefaultChannel();

    expect(result).toEqual({ channel: 'fake-payout', source: 'ENV' });
  });

  it('⚠️ 展示用读取：DB 无行且 env 无值 → channel=null / source=NONE（不抛 409）', async () => {
    delete process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL;

    const result = await makeService(makePrisma()).readPayoutDefaultChannel();

    // ⚠️ **「还没配」不是错误**：设置页要靠这次 GET 渲染保存表单，
    //    抛 409 会让全新环境永远没有配置入口。
    expect(result).toEqual({ channel: null, source: 'NONE' });
  });

  it('⚠️ 展示用读取：配置损坏 / 渠道已停用 → 仍然抛错（不能展示成一个能用的值）', async () => {
    const prisma = makePrisma({
      findUnique: jest.fn<Promise<unknown>, [{ where: { key: string } }]>(() =>
        Promise.resolve({
          id: 'row-1',
          key: PAYOUT_DEFAULT_CHANNEL_KEY,
          value: { channel: 'not-enabled-channel' },
        }),
      ),
    });

    await expect(
      makeService(prisma).readPayoutDefaultChannel(),
    ).rejects.toThrow(ConflictException);
  });

  it('DB 有行 → DATABASE 且覆盖 env', async () => {
    const prisma = makePrisma({
      findUnique: jest.fn<Promise<unknown>, [{ where: { key: string } }]>(() =>
        Promise.resolve({
          id: 'row-1',
          key: PAYOUT_DEFAULT_CHANNEL_KEY,
          value: { channel: 'fake-payout' },
        }),
      ),
    });
    const result = await makeService(prisma).getPayoutDefaultChannel();

    expect(result).toEqual({ channel: 'fake-payout', source: 'DATABASE' });
    expect(prisma.platformSetting.findUnique).toHaveBeenCalledWith({
      where: { key: PAYOUT_DEFAULT_CHANNEL_KEY },
    });
  });

  it('⚠️ DB 行指向未启用渠道 → 抛中文错误且不回落 env', async () => {
    const prisma = makePrisma({
      findUnique: jest.fn<Promise<unknown>, [{ where: { key: string } }]>(() =>
        Promise.resolve({
          id: 'row-1',
          key: PAYOUT_DEFAULT_CHANNEL_KEY,
          value: { channel: 'not-enabled-channel' },
        }),
      ),
    });

    await expect(makeService(prisma).getPayoutDefaultChannel()).rejects.toThrow(
      ConflictException,
    );
    await expect(makeService(prisma).getPayoutDefaultChannel()).rejects.toThrow(
      /已停用/,
    );
  });

  it('保存未启用渠道 → 抛错且 Prisma 未被写入', async () => {
    const prisma = makePrisma();

    await expect(
      makeService(prisma).setPayoutDefaultChannel(
        'not-enabled-channel',
        'admin-1',
      ),
    ).rejects.toThrow(ConflictException);

    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('保存成功 → updatedBy 为操作人 id', async () => {
    const prisma = makePrisma();
    const result = await makeService(prisma).setPayoutDefaultChannel(
      'fake-payout',
      'admin-1',
    );

    expect(result).toEqual({ channel: 'fake-payout', source: 'DATABASE' });
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith({
      where: { key: PAYOUT_DEFAULT_CHANNEL_KEY },
      create: {
        key: PAYOUT_DEFAULT_CHANNEL_KEY,
        value: { channel: 'fake-payout' },
        updatedBy: 'admin-1',
      },
      update: {
        value: { channel: 'fake-payout' },
        updatedBy: 'admin-1',
      },
    });
  });

  it('保存空渠道 → 中文 400', async () => {
    const prisma = makePrisma();

    await expect(
      makeService(prisma).setPayoutDefaultChannel('   ', 'admin-1'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('⚠️ DB 行 value 损坏 → 抛中文错误，不回落 env', async () => {
    const prisma = makePrisma({
      findUnique: jest.fn<Promise<unknown>, [{ where: { key: string } }]>(() =>
        Promise.resolve({
          id: 'row-1',
          key: PAYOUT_DEFAULT_CHANNEL_KEY,
          value: 'not-an-object',
        }),
      ),
    });

    await expect(makeService(prisma).getPayoutDefaultChannel()).rejects.toThrow(
      /已损坏/,
    );
  });

  it('⚠️ DB 无行且 env 无值 → 抛中文 409', async () => {
    delete process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL;
    const prisma = makePrisma();

    await expect(makeService(prisma).getPayoutDefaultChannel()).rejects.toThrow(
      ConflictException,
    );
    await expect(makeService(prisma).getPayoutDefaultChannel()).rejects.toThrow(
      /平台未配置默认出款渠道/,
    );
  });
});
