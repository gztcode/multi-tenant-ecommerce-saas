import { UserRole } from '@prisma/client';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';

// ⚠️ `@nestjs/passport` 是 ESM-only，Jest（CommonJS）加载 `@Roles` 的
//    依赖链时会报错。本测试不关心认证实现，用空守卫替身断开这条链。
//    （与 platform-settlement.controller.spec.ts 同一处理。）
jest.mock('@nestjs/passport', () => ({
  AuthGuard: () => class {},
}));

import { ROLES_KEY } from '../decorators/roles.decorator';
import { ProductsController } from '../../modules/catalog/products/products.controller';
import { CategoriesController } from '../../modules/catalog/categories/categories.controller';
import { InventoryController } from '../../modules/inventory/inventory.controller';
import { MediaController } from '../../modules/media/media.controller';
import { StoresController } from '../../modules/stores/stores.controller';

/**
 * 角色契约测试：商家管理端的控制器必须挂 @Roles(MERCHANT_OWNER, MERCHANT_STAFF)。
 *
 * 背景（2026-11-05 审计 P1-1）：`@Roles()` 是挂 RolesGuard 的唯一入口，
 * 漏挂 = 静默敞开——消费者令牌就能改价、改库存、下架商品（对抗验证已端到端复现资损链）。
 * 这份契约的作用是**防回归**：将来任何人往这些控制器加新路由却忘了挂 @Roles，
 * 或者把 StoresController 的公开路由误挂了角色，测试立刻变红。
 *
 * ⚠️ 角色取值是 OWNER + STAFF：店员是合法商家角色，只有出款审批是 owner-only。
 *    写成 owner-only 会误伤店员。
 */

const MERCHANT_ROLES = [UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF];

/** Nest 的 HTTP 动词元数据值：POST / PUT / DELETE / PATCH（1-4）算「写」动词 */
const WRITE_VERBS = new Set([1, 2, 3, 4]);

/** 枚举控制器上的全部路由处理器（含 HTTP 动词、路径与处理器引用） */
interface Route {
  name: string;
  path: string;
  verb: number;
  handler: object;
}

function routesOf(controller: abstract new (...args: never[]) => unknown) {
  const proto = controller.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => ({
      name,
      handler: proto[name] as object,
      path: Reflect.getMetadata(PATH_METADATA, proto[name] as object) as
        string | undefined,
      verb: Reflect.getMetadata(METHOD_METADATA, proto[name] as object) as
        number | undefined,
    }))
    .filter((r): r is Route => r.path !== undefined && r.verb !== undefined);
}

function rolesOfHandler(handler: object): UserRole[] | undefined {
  return Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined;
}

describe('商家管理端控制器的 @Roles 契约（P1-1）', () => {
  describe('catalog/products、catalog/categories、inventory、media —— 类级角色', () => {
    it.each([
      ['ProductsController', ProductsController],
      ['CategoriesController', CategoriesController],
      ['InventoryController', InventoryController],
      ['MediaController', MediaController],
    ])('%s 类级 @Roles 是 OWNER+STAFF，且方法级不覆盖', (_name, controller) => {
      expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual(
        MERCHANT_ROLES,
      );
      // 方法级元数据会把类级覆盖掉（getAllAndOverride）：若有路由自己挂了
      // @Roles，值也必须是同一集合，否则会出现「类收紧、方法漏风」。
      for (const route of routesOf(controller)) {
        expect([route.name, rolesOfHandler(route.handler) ?? null]).toEqual([
          route.name,
          null,
        ]);
      }
    });
  });

  describe('stores —— 只有 PATCH me 收紧，公开路由保持公开', () => {
    it('类级没有角色（GET me 与 by-subdomain 不受角色限制）', () => {
      expect(Reflect.getMetadata(ROLES_KEY, StoresController)).toBeUndefined();
    });

    it('updateMine（PATCH me）的 @Roles 是 OWNER+STAFF', () => {
      const proto = StoresController.prototype as unknown as Record<
        string,
        unknown
      >;
      expect(rolesOfHandler(proto.updateMine as object)).toEqual(
        MERCHANT_ROLES,
      );
    });

    it('findMine（GET me）与 findBySubdomain（公开）不挂角色', () => {
      const proto = StoresController.prototype as unknown as Record<
        string,
        unknown
      >;
      expect(rolesOfHandler(proto.findMine as object)).toBeUndefined();
      expect(rolesOfHandler(proto.findBySubdomain as object)).toBeUndefined();
    });

    it('stores 的全部「写」路由都必须挂角色（防将来新增路由漏挂）', () => {
      for (const route of routesOf(StoresController)) {
        if (WRITE_VERBS.has(route.verb)) {
          expect([route.name, rolesOfHandler(route.handler)]).toEqual([
            route.name,
            MERCHANT_ROLES,
          ]);
        }
      }
    });
  });
});
