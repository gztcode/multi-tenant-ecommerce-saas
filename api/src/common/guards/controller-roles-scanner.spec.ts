import { join } from 'node:path';

import * as ts from 'typescript';

import {
  describeViolation,
  findRoleViolations,
  scanControllerRoutes,
  type ControllerRoute,
} from './controller-roles-scanner';
import { CONTROLLER_ROLES_EXEMPTIONS } from './controller-roles-exemptions';

const API_ROOT = join(__dirname, '..', '..', '..');

/**
 * 用一段内联源码建一个最小 Program 并扫描。
 *
 * ⚠️ **为什么要造假宿主**：真实扫描要加载整个 `src/main.ts`（连带所有模块），
 *    慢且脆（某个模块的类型错误会让护栏自己先炸）。这里只喂一段自包含的
 *    源码，护栏的判定逻辑（类级 / 方法级 `@Roles`、`@Public()`、`@Skip()`、
 *    豁免登记）照样被完整验证。
 */
function scanFixture(
  source: string,
  exemptions: Parameters<typeof findRoleViolations>[1] = [],
  fileName = '__controller_roles_fixture__.controller.ts',
): ControllerRoute[] {
  const file = join(API_ROOT, 'src', fileName);
  const host = ts.createCompilerHost({ strict: true });

  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    if (name === file) {
      return ts.createSourceFile(
        name,
        source,
        languageVersion,
        /* setParentNodes */ true,
      );
    }
    return originalGetSourceFile(name, languageVersion, onError, shouldCreate);
  };

  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === file || originalFileExists(name);

  const originalReadFile = host.readFile.bind(host);
  host.readFile = (name) => (name === file ? source : originalReadFile(name));

  const program = ts.createProgram(
    [file],
    {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      // ⚠️ **必须开**：没有它，解析器不会把 `@Roles` 记成装饰器，扫描器会「看到 0 条路由」，
      //    护栏于是**假绿**。
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      // ⚠️ **必须开**：靠 `node.parent` 找到「这个方法属于哪个类」。
      setParentNodes: true,
    },
    host,
  );

  return findRoleViolations(
    scanControllerRoutes(program, API_ROOT),
    exemptions,
  );
}

describe('控制器角色扫描器的判定规则', () => {
  it('既没有 @Roles 也没有登记豁免 → 报出', () => {
    const src = `
      @Controller('things')
      class ThingController {
        @Post()
        create() { return {}; }
      }
    `;
    const violations = scanFixture(src);
    expect(violations).toHaveLength(1);
    expect(violations[0].method).toBe('create');
    expect(violations[0].verb).toBe('Post');
    expect(describeViolation(violations[0])).toContain(
      'ThingController.create',
    );
  });

  it('类级 @Roles → 该类的全部路由都放行', () => {
    const src = `
      @Controller('things')
      @Roles('MERCHANT_OWNER')
      class ThingController {
        @Get()
        list() { return {}; }
        @Post()
        create() { return {}; }
      }
    `;
    expect(scanFixture(src)).toHaveLength(0);
  });

  it('方法级 @Roles → 该方法放行，同类的其他方法照报', () => {
    const src = `
      @Controller('things')
      class ThingController {
        @Get()
        list() { return {}; }
        @Post()
        @Roles('MERCHANT_OWNER')
        create() { return {}; }
      }
    `;
    const violations = scanFixture(src);
    expect(violations).toHaveLength(1);
    expect(violations[0].method).toBe('list');
  });

  it('@Public() → 公开路由放行', () => {
    const src = `
      @Controller('things')
      class ThingController {
        @Get()
        @Public()
        list() { return {}; }
      }
    `;
    expect(scanFixture(src)).toHaveLength(0);
  });

  it('@Skip() → 跳过租户上下文的端点放行', () => {
    const src = `
      @Controller('things')
      class ThingController {
        @Get()
        @Skip()
        health() { return {}; }
      }
    `;
    expect(scanFixture(src)).toHaveLength(0);
  });

  it('登记了豁免 → 放行；同一个文件里没登记的方法照报', () => {
    const src = `
      @Controller('things')
      class ThingController {
        @Get()
        list() { return {}; }
        @Post()
        create() { return {}; }
      }
    `;
    const violations = scanFixture(src, [
      {
        file: 'src/__controller_roles_fixture__.controller.ts',
        methods: ['list'],
        why: '测试用',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].method).toBe('create');
  });

  it('豁免锚点是「文件 + 方法名」→ 文件对不上不豁免', () => {
    const src = `
      @Controller('things')
      class ThingController {
        @Get()
        list() { return {}; }
      }
    `;
    const violations = scanFixture(src, [
      { file: 'src/别的文件.controller.ts', methods: ['list'], why: '测试用' },
    ]);
    expect(violations).toHaveLength(1);
  });

  it('别名导入的 @Roles 也能认出来（防「按名字匹配」的假绿）', () => {
    const src = `
      import { Roles as MerchantRoles } from './roles.decorator';
      @Controller('things')
      class ThingController {
        @Post()
        @MerchantRoles('MERCHANT_OWNER')
        create() { return {}; }
      }
    `;
    expect(scanFixture(src)).toHaveLength(0);
  });

  it('同名但来自别的模块的装饰器不算 @Roles（防误认成假绿）', () => {
    const src = `
      import { Roles } from './别的装饰器';
      @Controller('things')
      class ThingController {
        @Post()
        @Roles()
        create() { return {}; }
      }
    `;
    const violations = scanFixture(src);
    expect(violations).toHaveLength(1);
    expect(violations[0].method).toBe('create');
  });

  it('类上没有 @Controller → 不是路由，不扫', () => {
    const src = `
      class NotAController {
        @Get()
        list() { return {}; }
      }
    `;
    expect(scanFixture(src)).toHaveLength(0);
  });

  it('文件名不是 *.controller.ts → 一条路由都扫不到', () => {
    const src = `
      @Controller('things')
      class ThingController {
        @Get()
        list() { return {}; }
      }
    `;
    expect(
      scanFixture(src, [], '__controller_roles_fixture__.service.ts'),
    ).toHaveLength(0);
  });
});

describe('全仓控制器角色护栏', () => {
  // ⚠️ **建 Program 很慢**（要加载整个 src/main.ts 及其依赖），
  //    给足超时时间，否则会因超时失败（而不是因为发现问题失败）。
  jest.setTimeout(300_000);

  const program = ts.createProgram([join(API_ROOT, 'src', 'main.ts')], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    // ⚠️ **必须开**：没有它，解析器不把 `@Roles` 记成装饰器，
    //    下面的断言会「扫到 0 条路由」→ 护栏**假绿**。
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    // ⚠️ **必须开**：靠 `node.parent` 找「这个方法属于哪个类」。
    setParentNodes: true,
  });
  const routes = scanControllerRoutes(program, API_ROOT);

  it('扫描器真的扫到了控制器路由（防「扫到 0 条 → 假绿」）', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((r) => r.controller === 'ProductsController')).toBe(
      true,
    );
  });

  it('除了已登记的豁免，不允许再有没挂 @Roles 的路由', () => {
    const violations = findRoleViolations(routes, CONTROLLER_ROLES_EXEMPTIONS);
    expect(violations.map(describeViolation)).toEqual([]);
  });

  it('豁免表里的每一条都对应一条真实存在、且确实没挂 @Roles 的路由', () => {
    const problems: string[] = [];
    for (const exemption of CONTROLLER_ROLES_EXEMPTIONS) {
      for (const method of exemption.methods) {
        const route = routes.find(
          (r) => r.file === exemption.file && r.method === method,
        );
        if (!route) {
          problems.push(`豁免指向不存在的路由：${exemption.file} ${method}`);
          continue;
        }
        if (route.classRoles || route.methodRoles) {
          problems.push(
            `豁免指向已经挂了 @Roles 的路由：${exemption.file} ${method}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
