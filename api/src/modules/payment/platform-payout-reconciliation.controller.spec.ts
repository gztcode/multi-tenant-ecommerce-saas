// ⚠️ `@nestjs/passport` 是 ESM-only，Jest（CommonJS）加载 `@Roles` 的
//    依赖链时会报错。控制器单测不关心认证实现，用空守卫替身断开这条链。
//    （与 `platform-settlement.controller.spec.ts` 同一做法。）
jest.mock('@nestjs/passport', () => ({
  AuthGuard: () => class {},
}));

import type { PayoutExecutionService } from '../billing/payout-execution.service';
import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { PayoutReconciliationService } from './payout-reconciliation.service';
import { PlatformPayoutReconciliationController } from './platform-payout-reconciliation.controller';

/**
 * 平台对账控制器（审计 §九「出款与结算口径」）。
 *
 * ⚠️ **控制器单测只钉「入参 → 服务调用」这一跳**，不测 CSV 解析本身
 *    （那是 `payout-reconciliation-csv.ts` 的职责）。
 *
 * 锁住一件事：**CSV 导入不传渠道时绝不猜 `fake-payout`** ——
 *    把空值交给 `importRecords` 的 `normalizeChannel` 去报 400
 *    （fail-closed：渠道不明就拒绝，不让运营以为在给假渠道对账）。
 */

// ⚠️ **最小合法列映射**（与 `payout-reconciliation-csv.ts` 的校验一致）：
//    交易号 / 金额 / 金额单位 / 状态列 / 状态映射都必填。
const MAPPING = {
  txnIdColumn: 'txn_id',
  amountColumn: 'amount',
  amountUnit: 'CENT',
  statusColumn: 'status',
  statusMapping: { SUCCESS: 'SUCCESS' },
};

// 一行最小合法流水（交易号 + 金额 + 状态都齐）
const CSV_TEXT = 'txn_id,amount,status\nCH-1,100,SUCCESS\n';

// ⚠️ **具体标注 mock 类型** —— 泛型是 `jest.Mock`（any）时 `.mock.calls[0][0]`
//    访问会触发 `no-unsafe-member-access`；带具体参数类型才能安全取实参断言。
type ImportRecordsMock = jest.Mock<
  Promise<{ id: string; diffCount: number; matchedCount: number }>,
  [unknown]
>;

function makeController(over: { importRecords?: ImportRecordsMock } = {}) {
  const reconciliations = {
    importRecords:
      over.importRecords ??
      jest.fn<
        Promise<{ id: string; diffCount: number; matchedCount: number }>,
        [unknown]
      >(() => Promise.resolve({ id: 'rec-1', diffCount: 0, matchedCount: 0 })),
  };
  const controller = new PlatformPayoutReconciliationController(
    reconciliations as unknown as PayoutReconciliationService,
    {} as PayoutExecutionService,
    {} as TenantPrismaService,
  );
  return { controller, reconciliations };
}

// ⚠️ **注入当前操作人**：`currentOperatorId()` 读 `getTenantContext()`，
//    单测里没有请求上下文 → 用 `tenantContext.run` 备一个平台作用域上下文。
//    （平台超管登录不带 x-tenant-subdomain → `tenantId` 为 null。）
import { UserRole } from '@prisma/client';
import { tenantContext } from '../../common/tenant/tenant-context';

describe('PlatformPayoutReconciliationController（审计 §九）', () => {
  describe('importCsv', () => {
    it('⚠️ 不传 channel → 传给 importRecords 的是空串（不猜 fake-payout，让服务层 400）', async () => {
      const { controller, reconciliations } = makeController();
      const file = { buffer: Buffer.from(CSV_TEXT), originalname: 'b.csv' };

      await tenantContext.run(
        { tenantId: null, userId: 'admin-1', role: UserRole.PLATFORM_ADMIN },
        async () => {
          await controller.importCsv(file as Express.Multer.File, {
            columnMapping: JSON.stringify(MAPPING),
          });
        },
      );

      const arg = reconciliations.importRecords.mock.calls[0][0] as {
        channel: string;
      };
      expect(arg.channel).toBe('');
      expect(arg.channel).not.toBe('fake-payout');
    });

    it('⚠️ 显式传 channel → 原样传给 importRecords（不受影响）', async () => {
      const { controller, reconciliations } = makeController();
      const file = { buffer: Buffer.from(CSV_TEXT), originalname: 'b.csv' };

      await tenantContext.run(
        { tenantId: null, userId: 'admin-1', role: UserRole.PLATFORM_ADMIN },
        async () => {
          await controller.importCsv(file as Express.Multer.File, {
            columnMapping: JSON.stringify(MAPPING),
            channel: 'sandbox',
          });
        },
      );

      const arg = reconciliations.importRecords.mock.calls[0][0] as {
        channel: string;
      };
      expect(arg.channel).toBe('sandbox');
    });
  });
});
