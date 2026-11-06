/**
 * 扫描 api 源码，列出「没有角色限定、也没登记豁免」的控制器路由。
 *
 * 用法（在 api/ 目录下）：
 *   npm run scan:controller-roles
 *
 * ⚠️ **CI 门禁在 `src/common/guards/controller-roles-scanner.spec.ts`** ——
 *    那个 spec 会扫全仓并在有违规时变红。这个脚本是给人看的：
 *    想看「到底哪些路由没限角色」时直接跑它。
 */
import { join } from 'node:path';

import * as ts from 'typescript';

import {
  describeViolation,
  findRoleViolations,
  scanControllerRoutes,
} from '../src/common/guards/controller-roles-scanner';
import { CONTROLLER_ROLES_EXEMPTIONS } from '../src/common/guards/controller-roles-exemptions';

const API_ROOT = join(__dirname, '..');

const program = ts.createProgram(
  [join(API_ROOT, 'src', 'main.ts')],
  {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    // ⚠️ **必须开**：没有它，解析器不把 `@Roles` 记成装饰器 → 扫到 0 条路由。
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    // ⚠️ **必须开**：靠 `node.parent` 找「这个方法属于哪个类」。
    setParentNodes: true,
  },
  undefined,
  // ⚠️ 只解析本仓的源文件，不去解析 node_modules（快很多）
  undefined,
);

const routes = scanControllerRoutes(program, API_ROOT);
const violations = findRoleViolations(routes, CONTROLLER_ROLES_EXEMPTIONS);

for (const route of violations) {
  console.log(describeViolation(route));
}
console.log(
  `\n共 ${routes.length} 条控制器路由，其中 ${violations.length} 条既没有 @Roles 也没有登记豁免`,
);

// ⚠️ **有违规就退出码非零**：让这个脚本也能当门禁用。
process.exit(violations.length > 0 ? 1 : 0);
