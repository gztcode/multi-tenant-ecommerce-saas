import { UserRole } from '@prisma/client';

// ⚠️ `@nestjs/passport` 是 ESM-only，Jest（CommonJS）加载 `@Roles` 的
//    依赖链时会报错。控制器单测不关心认证实现，用空守卫替身断开这条链。
jest.mock('@nestjs/passport', () => ({
  AuthGuard: () => class {},
}));

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PlatformSettlementController } from './platform-settlement.controller';

describe('PlatformSettlementController CSV 导出', () => {
  it('类级权限是 PLATFORM_ADMIN', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, PlatformSettlementController),
    ).toEqual([UserRole.PLATFORM_ADMIN]);
  });

  it('空列表也返回表头，并带 UTF-8 BOM', async () => {
    const service = {
      exportCsv: jest.fn().mockResolvedValue('结算单号,商家\r\n'),
    };
    const controller = new PlatformSettlementController(service as never);

    const file = await controller.export({});
    // 用公开的 getStream() 收集内容，不依赖 StreamableFile 的私有字段名。
    const chunks: Buffer[] = [];
    for await (const chunk of file.getStream() as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');

    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain('结算单号,商家');
    expect(service.exportCsv).toHaveBeenCalledWith({ period: undefined });
  });
});
