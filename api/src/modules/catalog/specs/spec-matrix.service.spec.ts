import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { tenantContext } from '../../../common/tenant/tenant-context';
import type { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { ReplaceSpecsDto } from '../dto/replace-specs.dto';
import { SpecMatrixService } from './spec-matrix.service';
import { MinPriceService } from '../pricing/min-price.service';

/**
 * 规格矩阵服务里**只靠 HTTP 测不到**的那部分守卫。
 *
 * DTO 上的 `@ArrayMaxSize(2)` / `@ArrayMaxSize(20)` 会在 ValidationPipe
 * 里就把超限请求挡成 400，走不到服务里的同名校验。e2e 里那条「规格数量超限被拒绝」
 * 断言的是 DTO 校验器，删掉服务里的检查它照样通过——那样的检查就是死代码。
 * 这里直接调 replace，绕过管道，让服务层自己的守卫真的被执行一次。
 */
describe('SpecMatrixService 的服务层守卫', () => {
  /** 只提供 replace 在校验阶段会碰到的委托；校验失败时不该走到事务 */
  const productFindFirst = jest.fn();

  const prisma = {
    product: { findFirst: productFindFirst },
  } as unknown as TenantPrismaService;

  // 第二个依赖是 MinPriceService：这个 spec 只测校验阶段，事务不会走到重算，
  // 给个空壳即可（真跑事务的路径由 e2e 覆盖）。
  const minPrice = {
    recalculate: jest.fn().mockResolvedValue(undefined),
  } as unknown as MinPriceService;

  const service = new SpecMatrixService(prisma, minPrice);

  /** 在租户上下文里调用（currentTenantId 依赖它） */
  function replace(dto: unknown, productId = 'p1') {
    return tenantContext.run({ tenantId: 't1', userId: null, role: null }, () =>
      service.replace(productId, dto as ReplaceSpecsDto),
    );
  }

  const spec = (name: string, values: string[]) => ({
    name,
    values: values.map((value) => ({ value })),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    productFindFirst.mockResolvedValue({ id: 'p1', version: 1 });
  });

  it('维度数超限时拒绝', async () => {
    await expect(
      replace({
        version: 1,
        specs: [
          spec('颜色', ['红']),
          spec('尺码', ['M']),
          spec('厚度', ['薄']),
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('单个维度的取值数超限时拒绝', async () => {
    await expect(
      replace({
        version: 1,
        specs: [
          spec(
            '颜色',
            Array.from({ length: 21 }, (_, i) => `色${i}`),
          ),
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('同一次提交里维度名重复时拒绝', async () => {
    // 两个同名维度会匹配到同一条既有维度、写出两套互相矛盾的取值
    await expect(
      replace({
        version: 1,
        specs: [spec('颜色', ['红色']), spec('颜色', ['蓝色'])],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('同一次提交里同一维度的取值重复时拒绝', async () => {
    // 数据库的部分唯一索引只在提交时拦，同一次请求里的两行要靠应用层
    await expect(
      replace({
        version: 1,
        specs: [spec('颜色', ['红色', '红色'])],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('version 不匹配时冲突', async () => {
    await expect(
      replace({ version: 99, specs: [spec('颜色', ['红色'])] }),
    ).rejects.toThrow(ConflictException);
  });

  it('商品不存在时 404', async () => {
    productFindFirst.mockResolvedValue(null);
    await expect(
      replace({ version: 1, specs: [spec('颜色', ['红色'])] }),
    ).rejects.toThrow(NotFoundException);
  });
});
