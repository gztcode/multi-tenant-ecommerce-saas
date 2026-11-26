// ⚠️ 装饰器元数据：`class-validator` / `class-transformer` 依赖它，
//    应用里由 `main.ts` 的 `import 'reflect-metadata'` 提供，单测要自己引。
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ReconciliationDiffType,
  ReconciliationResolution,
  ReconciliationSeverity,
} from '@prisma/client';
import { DetailReconciliationDto } from './payout-reconciliation.dto';

/**
 * 详情筛选参数的校验（对账差异详情支持筛选）。
 *
 * ⚠️ **为什么单独测 DTO** —— `main.ts` 的全局 `ValidationPipe` 是
 *    `whitelist + forbidNonWhitelisted + transform`，校验失败即 400。
 *    也就是说「非法枚举值 → 400」这件事的**唯一实现**就是这里的装饰器；
 *    只测 service 的话，把 `@IsEnum` 删掉照样全绿，线上却会拿非法值去撞
 *    PG 的 enum（冒成 500）。真实 HTTP 上的 400 另有 e2e 守住。
 */
describe('DetailReconciliationDto', () => {
  const toDto = (query: Record<string, unknown>) =>
    plainToInstance(DetailReconciliationDto, query);

  it('三个参数都合法 → 无校验错误', async () => {
    const errors = await validate(
      toDto({
        severity: ReconciliationSeverity.CRITICAL,
        resolution: ReconciliationResolution.PENDING,
        type: ReconciliationDiffType.AMOUNT_MISMATCH,
      }),
    );

    expect(errors).toHaveLength(0);
  });

  it('不传参数 → 无校验错误（无参数行为必须与改造前一致）', async () => {
    expect(await validate(toDto({}))).toHaveLength(0);
  });

  it.each([
    ['severity', 'BOGUS'],
    ['severity', 'critical'],
    ['resolution', 'DONE'],
    ['type', 'SOMETHING_ELSE'],
  ])(
    '非法 %s=%s → 校验失败（ValidationPipe 会转成 400）',
    async (key, value) => {
      const errors = await validate(toDto({ [key]: value }));

      expect(errors.map((e) => e.property)).toEqual([key]);
    },
  );

  it('枚举值给成数组也会被拒', async () => {
    const errors = await validate(
      toDto({ severity: [ReconciliationSeverity.CRITICAL] }),
    );

    expect(errors.map((e) => e.property)).toEqual(['severity']);
  });
});
