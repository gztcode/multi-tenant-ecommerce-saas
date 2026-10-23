import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Category } from '@prisma/client';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../../common/tenant/tenant-context';
import { rethrowIfUniqueViolation } from '../../../common/errors/unique-constraint';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';

/** 品类树的最大层数。一级品类算第 1 层。 */
export const MAX_CATEGORY_DEPTH = 3;

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 取当前租户 id；没有租户上下文时抛 404（不给调用方泄露「鉴权失败」细节） */
  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 品类树。
   *
   * 一次查平铺列表后在内存里拼树，而不是递归查询：
   * 品类数量在商家尺度上是几十到几百条，一次全取比 N+1 次递归快得多，
   * 而且避免了在循环里发查询（那会让租户上下文在 await 边界上更难保证）。
   *
   * 软删除的过滤不用手写：租户扩展在顶层查询自动合并 `deletedAt: null`
   * （见 common/tenant/tenant-models.ts 的 SOFT_DELETE_MODELS）。
   */
  async tree(): Promise<Array<Category & { children: Category[] }>> {
    const tenantId = this.currentTenantId();
    const all = await this.prisma.category.findMany({
      where: { tenantId },
      orderBy: { sort: 'asc' },
    });

    const byId = new Map<string, Category & { children: Category[] }>();
    for (const row of all) {
      byId.set(row.id, { ...row, children: [] });
    }

    const roots: Array<Category & { children: Category[] }> = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /**
   * 计算某个品类自身的层级深度（自身算第 1 层）。
   *
   * 沿着 parentId 往上走，最多走 MAX_CATEGORY_DEPTH 步。
   * 走满还没到顶说明链已经超深——这在正常数据里不可能（创建时已校验），
   * 但数据被外部改过时不能无限循环，所以给一个硬上限。
   *
   * ⚠️ 计数只在「确认还有父节点要继续往上走」时才 +1。若是无条件 +1，
   * 最后一次读到根节点的 parentId=null 时也会加一次，二级品类会被算成 3 层，
   * 于是三级品类的创建被误拒（off-by-one）。
   */
  private async depthOf(categoryId: string): Promise<number> {
    let depth = 1;
    let currentId: string | null = categoryId;

    while (currentId && depth <= MAX_CATEGORY_DEPTH) {
      const row: { parentId: string | null } | null =
        await this.prisma.category.findFirst({
          where: { id: currentId },
          select: { parentId: true },
        });
      if (!row) return depth;
      // 走到顶了：这条链到此为止，当前 depth 就是答案，不再 +1
      if (!row.parentId) return depth;
      currentId = row.parentId;
      depth += 1;
    }
    return depth;
  }

  /**
   * 校验父品类可以用。
   *
   * ⚠️ 外键 parentId 只引用 Category.id，**不带 tenantId**——数据库层面挡不住
   * 跨租户挂载。而租户扩展只往 data 里注入 tenantId，不校验被引用对象属于哪个租户。
   * 所以必须在这里显式查一次归属：用 findFirst 而不是 findUnique（后者在租户
   * 作用域模型上会被扩展直接拒绝），扩展自动补上的 where.tenantId 就是那道闸门——
   * 别的租户的 id 查不到，自然被拒。
   */
  private async assertParentUsable(parentId: string): Promise<Category> {
    const parent = await this.prisma.category.findFirst({
      where: { id: parentId },
    });
    if (!parent) {
      throw new BadRequestException('父品类不存在');
    }
    const parentDepth = await this.depthOf(parentId);
    if (parentDepth >= MAX_CATEGORY_DEPTH) {
      throw new BadRequestException(
        `品类最多 ${MAX_CATEGORY_DEPTH} 层，「${parent.name}」已经在第 ${parentDepth} 层`,
      );
    }
    return parent;
  }

  /**
   * 以某个品类为根的子树有几层（含自身）。
   *
   * 必须先确认调用前树里没有环——有环时这个递归会栈溢出。
   */
  private async subtreeHeight(categoryId: string): Promise<number> {
    const children = await this.prisma.category.findMany({
      where: { parentId: categoryId },
      select: { id: true },
    });
    if (children.length === 0) return 1;
    let max = 1;
    for (const child of children) {
      const height = await this.subtreeHeight(child.id);
      if (height > max) max = height;
    }
    return max + 1;
  }

  /**
   * 拒绝把品类挂到自己的子孙下面——那会在库里形成环，
   * tree() 拼树时会自引用，subtreeHeight 递归时直接栈溢出。
   *
   * 沿新父节点上溯找自己。步数上限是防御性的：若库里已经存在环
   * （历史脏数据或别处的漏洞），无上限的循环会挂死而不是报错。
   */
  private async assertNoCycle(id: string, newParentId: string): Promise<void> {
    let cursor: string | null = newParentId;
    for (let step = 0; cursor && step <= MAX_CATEGORY_DEPTH + 2; step += 1) {
      if (cursor === id) {
        throw new BadRequestException('品类不能挂到自己的子孙下面');
      }
      const row: { parentId: string | null } | null =
        await this.prisma.category.findFirst({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = row?.parentId ?? null;
    }
    if (cursor) {
      throw new BadRequestException('品类层级数据异常，请检查是否存在循环引用');
    }
  }

  async create(dto: CreateCategoryDto): Promise<Category> {
    // 这里显式取一次租户 id，不是为了写进 data（扩展会注入），而是为了让
    // 「没有租户上下文」在这里就响亮失败，而不是等到下面的查询才报 scope 错误。
    this.currentTenantId();

    if (dto.parentId) {
      await this.assertParentUsable(dto.parentId);
    }

    // as never：data 的类型与 UpdateCategoryDto / CreateCategoryDto 的可选字段
    // 无法直接对齐（展开后 TS 推断为含 undefined 的可选属性），扩展会在运行时
    // 把 tenantId 注入，这里只负责把已知字段传下去。
    try {
      return await this.prisma.category.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
          ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
        } as never,
      });
    } catch (error) {
      // 同租户内 slug 重复 → 409，而不是让 P2002 一路冒成 500。
      // 这个函数签名是 never，所以 catch 之后必然抛出。
      return rethrowIfUniqueViolation(error, '品类 slug');
    }
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<Category> {
    this.currentTenantId();

    const category = await this.prisma.category.findFirst({ where: { id } });
    if (!category) {
      throw new NotFoundException('品类不存在');
    }

    // 换父节点时的校验。parentId 没传、或与原值相同，就整套跳过——
    // 结构没变，深度也就没变，多查都是浪费。
    if (dto.parentId !== undefined && dto.parentId !== null) {
      // 不能把自己挂到自己下面。这条要排在「值没变」的判断之前：
      // 自己挂自己虽然父子 id 相同，但它和「保持原样」不是一回事。
      if (dto.parentId === id) {
        throw new BadRequestException('品类不能作为自己的父品类');
      }
      if (dto.parentId !== category.parentId) {
        // 顺序不能反：环检测必须排在父节点深度校验之前。
        // 新父若是自己的子孙，depthOf 会先撞上 MAX_CATEGORY_DEPTH 的上限而抛错，
        // 环就永远走不到 assertNoCycle——那是碰巧被挡住的，不是检测出来的。
        // 而且下面的 subtreeHeight 一旦在环上递归就会栈溢出。
        await this.assertNoCycle(id, dto.parentId);
        await this.assertParentUsable(dto.parentId);

        // assertParentUsable 只校验「新父」自身的层数，可被移动的节点带着子树一起下沉，
        // 子树底下的叶子会一起掉出上限，所以还要把子树高度算进来。
        // 被移动的节点自己落在新父的下一层，它下面最深的叶子落在 newDepth + height - 1。
        const newDepth = (await this.depthOf(dto.parentId)) + 1;
        const height = await this.subtreeHeight(id);
        if (newDepth + height - 1 > MAX_CATEGORY_DEPTH) {
          throw new BadRequestException(
            `品类最多 ${MAX_CATEGORY_DEPTH} 层，移过去之后整棵子树会占到第 ${newDepth + height - 1} 层`,
          );
        }
      }
    }

    await this.prisma.category.updateMany({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
        ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
      },
    });

    // 上面已经确认过 category 存在，这里再查一次而不是复用旧对象，
    // 因为 update 之后 name / parentId / sort 可能都变了。
    const updated = await this.prisma.category.findFirst({ where: { id } });
    if (!updated) {
      throw new NotFoundException('品类不存在');
    }
    return updated;
  }

  /**
   * 软删除品类。
   *
   * 有子品类或有商品时拒绝：留下指向已删品类的悬空引用会让前台
   * 分类导航出现空栏目。
   *
   * 两次 count 都只数未软删的记录——扩展在顶层自动合并 deletedAt: null，
   * 所以已经删掉的子品类 / 商品不会因为这次 count 而挡住删除。
   */
  async remove(id: string): Promise<void> {
    const category = await this.prisma.category.findFirst({ where: { id } });
    if (!category) {
      throw new NotFoundException('品类不存在');
    }

    const children = await this.prisma.category.count({
      where: { parentId: id },
    });
    if (children > 0) {
      throw new BadRequestException('该品类下还有子品类，请先删除子品类');
    }

    const products = await this.prisma.product.count({
      where: { categoryId: id },
    });
    if (products > 0) {
      throw new BadRequestException('该品类下还有商品，请先移动或删除商品');
    }

    await this.prisma.category.updateMany({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
