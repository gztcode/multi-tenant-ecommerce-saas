import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../../common/tenant/tenant-context';
import { ReplaceSpecsDto } from '../dto/replace-specs.dto';
import { MinPriceService } from '../pricing/min-price.service';

/** 最多允许的规格维度数 */
export const MAX_SPEC_DIMENSIONS = 2;
/** 每个维度最多允许的规格值数 */
export const MAX_SPEC_VALUES = 20;

/**
 * 规格矩阵的整体替换。
 *
 * 一次提交完整结构，后端在一个事务里完成：
 *   1. 维度按 name 与既有维度匹配（复用 id），多余的软删
 *   2. 规格值按 (specId, value) 的**文本**匹配（复用 id），多余的软删
 *   3. 算笛卡尔积，与既有 SKU 按「规格值 id 集合」匹配
 *   4. 匹配到的保留（价格、库存、编码不动）
 *   5. 缺失的新建（价格与库存为 0）
 *   6. 多余的 SKU **一律置 INACTIVE**（不软删除，理由见步骤 6 的注释）
 *
 * 第 6 条是关键：商家调了下架一个颜色，不能把这批 SKU 的历史库存流水弄没了。
 */
@Injectable()
export class SpecMatrixService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly minPrice: MinPriceService,
  ) {}

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 笛卡尔积：规格维度 × 规格值 → 规格值 id 的组合列表。
   *
   * 每个组合是「每个维度各取一个值」的 id 数组，顺序与维度顺序一致——
   * 顺序稳定才能让「按组合匹配 SKU」有确定的结果。
   *
   * ⚠️ 规格维度为空数组时（把商品的规格整体清空）返回**空列表**，不生成组合。
   * 笛卡尔积的数学起点是「空集的单元素集 `[[]]`」，直接 reduce 的话会产出一个
   * 不挂任何规格值的 SKU——那是一条没有意义的记录，商家在界面上看不到它，
   * 却会污染 SKU 列表与计数。清空规格就该一个 SKU 都不剩。
   */
  private cartesian(
    dims: Array<{ values: Array<{ id: string }> }>,
  ): string[][] {
    if (dims.length === 0) return [];
    return dims.reduce<string[][]>(
      (acc, dim) =>
        acc.flatMap((prefix) => dim.values.map((v) => [...prefix, v.id])),
      [[]],
    );
  }

  /** 把一组规格值 id 排序成稳定的键，用于比较两个组合是否相同 */
  private comboKey(valueIds: string[]): string {
    return [...valueIds].sort().join(',');
  }

  async replace(productId: string, dto: ReplaceSpecsDto) {
    const tenantId = this.currentTenantId();

    const product = await this.prisma.product.findFirst({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    if (dto.version !== product.version) {
      throw new ConflictException('商品已被他人修改，请刷新后重试');
    }

    if (dto.specs.length > MAX_SPEC_DIMENSIONS) {
      throw new BadRequestException(`规格维度最多 ${MAX_SPEC_DIMENSIONS} 个`);
    }
    // 同一次提交里维度名重复会匹配到同一条既有维度、写出两套取值，
    // 结果不可预测；取值文本重复同理。数据库上的部分唯一索引
    // （软删除后不占用）挡不住「同一次请求内」的两行，直接在应用层拒绝。
    // seenNames 必须跨维度共用——每个维度各建一个 Set 就永远发现不了重名。
    const seenNames = new Set<string>();
    for (const dim of dto.specs) {
      if (dim.values.length > MAX_SPEC_VALUES) {
        throw new BadRequestException(
          `规格「${dim.name}」最多 ${MAX_SPEC_VALUES} 个值`,
        );
      }
      if (seenNames.has(dim.name)) {
        throw new BadRequestException(`规格维度「${dim.name}」重复`);
      }
      seenNames.add(dim.name);

      const seenValues = new Set<string>();
      for (const value of dim.values) {
        if (seenValues.has(value.value)) {
          throw new BadRequestException(
            `规格「${dim.name}」的取值「${value.value}」重复`,
          );
        }
        seenValues.add(value.value);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // ---- 1. 维度：按 name 匹配 ----
      const existingSpecs = await tx.productSpec.findMany({
        where: { productId },
      });
      const specIdByName = new Map(existingSpecs.map((s) => [s.name, s.id]));
      const keptSpecIds = new Set<string>();

      const resolvedDims: Array<{
        id: string;
        name: string;
        values: Array<{ id: string; value: string }>;
      }> = [];

      for (const [index, dim] of dto.specs.entries()) {
        const existingSpecId = specIdByName.get(dim.name);
        let specId: string;

        if (existingSpecId) {
          specId = existingSpecId;
          keptSpecIds.add(existingSpecId);
          await tx.productSpec.updateMany({
            where: { id: existingSpecId },
            data: { sort: dim.sort ?? index },
          });
        } else {
          // 显式传 tenantId：不依赖「扩展在事务客户端上也会注入」这个前提。
          // 显式传是安全的——扩展的注入逻辑是 `{ ...data, tenantId }`，
          // 会用上下文里的值覆盖，传错也传不进去。
          const created = await tx.productSpec.create({
            data: {
              tenantId,
              productId,
              name: dim.name,
              sort: dim.sort ?? index,
            },
          });
          specId = created.id;
          keptSpecIds.add(specId);
        }

        // ---- 2. 规格值：按 (specId, value) 匹配 ----
        const existingValues = await tx.productSpecValue.findMany({
          where: { specId },
        });
        const valueIdByText = new Map(
          existingValues.map((v) => [v.value, v.id]),
        );
        const keptValueIds = new Set<string>();
        const resolvedValues: Array<{ id: string; value: string }> = [];

        for (const [valueIndex, valueInput] of dim.values.entries()) {
          let valueId: string;
          const existingValueId = valueIdByText.get(valueInput.value);

          if (existingValueId) {
            // 已软删的值同样会被上面的 findMany 过滤掉（扩展合并 deletedAt: null），
            // 所以走不到这里；命中的一定是活的，直接复用。
            valueId = existingValueId;
            keptValueIds.add(existingValueId);
            await tx.productSpecValue.updateMany({
              where: { id: existingValueId },
              data: { sort: valueIndex },
            });
          } else {
            const created = await tx.productSpecValue.create({
              data: {
                tenantId,
                specId,
                value: valueInput.value,
                sort: valueIndex,
              },
            });
            valueId = created.id;
            keptValueIds.add(valueId);
          }
          resolvedValues.push({ id: valueId, value: valueInput.value });
        }

        // 本维度里不再出现的值：软删除。
        // keptValueIds 为空（维度被整体清空）时 notIn: [] 匹配不到任何行，
        // 得走另一条 where 才能真的把剩下的值都删掉。
        const staleValueWhere =
          keptValueIds.size > 0
            ? { where: { specId, id: { notIn: [...keptValueIds] } } }
            : { where: { specId } };
        await tx.productSpecValue.updateMany({
          ...staleValueWhere,
          data: { deletedAt: new Date() },
        });

        resolvedDims.push({
          id: specId,
          name: dim.name,
          values: resolvedValues,
        });
      }

      // 不再出现的维度：软删除。
      // 同上：specs 传空数组时 keptSpecIds 为空，要走 { where: { productId } }
      // 才能把该商品的所有维度都下架，否则「清空规格」会一个都删不掉。
      const staleSpecWhere =
        keptSpecIds.size > 0
          ? { where: { productId, id: { notIn: [...keptSpecIds] } } }
          : { where: { productId } };
      await tx.productSpec.updateMany({
        ...staleSpecWhere,
        data: { deletedAt: new Date() },
      });

      // 被软删维度下的取值要一并软删。
      //
      // ⚠️ 上面步骤 2 只在**逐个维度处理时**软删了「不再出现的取值」，
      // 维度被整体清空时那个循环一次都不跑，取值就成了孤儿：它们的
      // spec.deletedAt 已经是过去时间，但自己还活着——将来商家新建一个
      // 同名的维度时，`product_spec_values` 上那条部分唯一索引会认为
      // 这个值还占着位置而拒绝写入。软删除没有外键级联，这一处得手动做。
      await tx.productSpecValue.updateMany({
        where: { spec: { productId, deletedAt: { not: null } } },
        data: { deletedAt: new Date() },
      });

      // ---- 3. 笛卡尔积 ----
      const combos = this.cartesian(
        resolvedDims.map((d) => ({ values: d.values })),
      );

      // ---- 4. 既有 SKU 与它们的规格值 ----
      const existingSkus = await tx.sku.findMany({
        where: { productId },
        include: { specValues: true },
      });
      const skuByCombo = new Map<string, (typeof existingSkus)[number]>();
      for (const sku of existingSkus) {
        const key = this.comboKey(sku.specValues.map((sv) => sv.valueId));
        skuByCombo.set(key, sku);
      }

      // ---- 5. 匹配到的保留，缺失的新建 ----
      const keptSkuIds = new Set<string>();
      for (const combo of combos) {
        const key = this.comboKey(combo);
        const existing = skuByCombo.get(key);

        if (existing) {
          keptSkuIds.add(existing.id);
          // 规格值关联可能需要补齐（值被重建过的情况）
          const existingValueIds = new Set(
            existing.specValues.map((sv) => sv.valueId),
          );
          for (const valueId of combo) {
            if (!existingValueIds.has(valueId)) {
              await tx.skuSpecValue.create({
                data: { tenantId, skuId: existing.id, valueId },
              });
            }
          }
          continue;
        }

        const created = await tx.sku.create({
          data: { tenantId, productId, price: 0 },
        });
        for (const valueId of combo) {
          await tx.skuSpecValue.create({
            data: { tenantId, skuId: created.id, valueId },
          });
        }
        keptSkuIds.add(created.id);
      }

      // ---- 6. 多余的 SKU 一律置 INACTIVE ----
      //
      // **不用软删除**：商家把某个规格值删掉又加回来时（先下架「蓝色」，
      // 几天后重新上架），软删的 SKU 查不到了——扩展会过滤 deletedAt——
      // 重新算规格组合时会新建一个同组合的 SKU，库里就留下两条逻辑重复的记录。
      //
      // 置 INACTIVE 没有这个问题：它只表示「这个 SKU 不再使用」，
      // 不参与 minPrice 计算，公开接口也只返回 ACTIVE 的 SKU。
      // 代价是留下一点存储，但换来了「规格反复调整不会产生垃圾数据」。
      const surplus = existingSkus.filter((s) => !keptSkuIds.has(s.id));
      if (surplus.length > 0) {
        await tx.sku.updateMany({
          where: { id: { in: surplus.map((s) => s.id) } },
          data: { status: 'INACTIVE' },
        });
      }

      // 商品版本递增
      await tx.product.updateMany({
        where: { id: productId },
        data: { version: { increment: 1 } },
      });

      // 重算最低价。
      //
      // 规格替换会改变「有哪些可售 SKU」，而 `minPrice` 是公开列表的**价格筛选与
      // 价格排序**直接读的字段——不重算的话前台展示的是过期价格：
      // 1. 新生成的 SKU 初始 price=0，商品的最低价却还是老 SKU 的价，新组合被
      //    价格区间漏掉；
      // 2. 最便宜的那个 SKU 被置 INACTIVE 后，minPrice 仍指向它，商品显示一个
      //    买家根本买不到的价格；
      // 3. 规格整体清空时没有任何 ACTIVE 的 SKU，minPrice 应为 0。
      //
      // 必须在同一事务里：否则「SKU 已停用但最低价还是旧的」这个中间态能被读到。
      await this.minPrice.recalculate(tx, tenantId, [productId]);

      // ⚠️ include 的每一处 to-many 都要显式写 where: { deletedAt: null }：
      // 租户扩展的软删除过滤只作用于顶层查询，嵌套关联不会被自动过滤。
      //
      // `values` 上的那道是**当前真正生效**的——第 1、2 步刚软删掉不再出现的
      // 规格值与维度，漏写就会把它们一起返回，前端会显示出已经下架的取值。
      // `skus` 上的那道目前还没有触发路径：第 6 步只置 INACTIVE、不软删 SKU，
      // 而删商品走的是另一条链路（那时商品本身已经查不到了）。
      // 仍然写上是与 ProductsService.findOne 保持一致——等真出现软删 SKU 的
      // 业务时，这里不用再补，漏写的那类 bug 也不会趁那时候溜进来。
      const result = await tx.product.findFirst({
        where: { id: productId },
        include: {
          skus: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            include: { specValues: true },
          },
          specs: {
            where: { deletedAt: null },
            orderBy: { sort: 'asc' },
            include: {
              values: { where: { deletedAt: null }, orderBy: { sort: 'asc' } },
            },
          },
        },
      });
      return result;
    });
  }
}
