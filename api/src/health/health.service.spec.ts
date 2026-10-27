import { Test } from '@nestjs/testing';

import { TenantPrismaService } from '../common/tenant/tenant-prisma.service';
import { HealthService } from './health.service';
import { RedisProbe } from './redis-probe';

/**
 * 探活服务的降级判定。
 *
 * 关键性质：**任何一项探活抛错都只让那一项变 false**，不能让整个 /health 挂住。
 * 探活自己的目的是「快速告诉外界我是不是还活着」——
 * 如果探活会挂住，它就失去了意义（那正是本阶段要修的 Redis 挂死）。
 */
describe('HealthService', () => {
  async function makeService(redisOk: boolean, dbOk: boolean) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: RedisProbe,
          useValue: { check: () => Promise.resolve(redisOk) },
        },
        {
          provide: TenantPrismaService,
          useValue: {
            databaseNow: () =>
              dbOk
                ? Promise.resolve(new Date())
                : Promise.reject(new Error('数据库连不上')),
          },
        },
      ],
    }).compile();
    return moduleRef.get(HealthService);
  }

  it('两项都通 → ok', async () => {
    const service = await makeService(true, true);
    const report = await service.check();
    expect(report.status).toBe('ok');
    expect(report.checks).toEqual({ redis: true, database: true });
    expect(typeof report.timestamp).toBe('string');
  });

  it('Redis 不通 → degraded，且数据库仍报 true', async () => {
    const service = await makeService(false, true);
    const report = await service.check();
    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ redis: false, database: true });
  });

  it('数据库不通 → degraded', async () => {
    const service = await makeService(true, false);
    const report = await service.check();
    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ redis: true, database: false });
  });

  it('两项都不通 → degraded', async () => {
    const service = await makeService(false, false);
    const report = await service.check();
    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ redis: false, database: false });
  });
});
