import { ForbiddenException } from '@nestjs/common';
import { requireTenantId } from './require-tenant';
import { tenantContext } from './tenant-context';

describe('requireTenantId（service 层的租户上下文校验）', () => {
  it('上下文里有 tenantId → 原样返回', async () => {
    const tenantId = await tenantContext.run(
      { tenantId: 't1', userId: 'u1', role: null },
      // ⚠️ 回调必须是 async（tenantContext 的约定）；这里同步返回结果，
      //    所以显式豁免 require-await。
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => requireTenantId(),
    );
    expect(tenantId).toBe('t1');
  });

  it('平台作用域（tenantId 为 null）→ ForbiddenException +「无法确定店铺」', async () => {
    await expect(
      tenantContext.run(
        { tenantId: null, userId: 'u1', role: null },
        // ⚠️ 回调必须是 async（tenantContext 的约定）；这里同步返回结果，
        //    所以显式豁免 require-await。
        // eslint-disable-next-line @typescript-eslint/require-await
        async () => requireTenantId(),
      ),
    ).rejects.toThrow(new ForbiddenException('无法确定店铺'));
  });

  it('⚠️ 上下文完全不存在（没经过 TenantContextInterceptor）→ 抛普通 Error，不是 403', () => {
    // ⚠️ 这条边界要钉住：**「没有上下文」与「上下文里没有租户」是两回事**。
    //    前者是 500（进程内没建立作用域，多半是队列消费者忘了重建），
    //    后者才是 403（已认证但角色越界）。混成 403 会把 500 藏起来。
    expect(() => requireTenantId()).toThrow('租户上下文不存在');
  });
});
