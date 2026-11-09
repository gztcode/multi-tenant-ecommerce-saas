/**
 * 「`.env` 加载顺序」扫描器。
 *
 * ⚠️ **为什么要它**：`api/scripts/` 下的运维脚本要 import 整个 Nest
 *    应用图（`AppModule`）。应用图里有 `queue.module.ts` ——
 *    它的 `BullModule.forRoot` 参数是**模块装饰器求值时**（import 的那一刻）
 *    定死的。那时 `.env` 若还没加载，`REDIS_URL` 就是 undefined →
 *    落到不带密码的 fallback → 本机 Redis 开了 `requirepass` →
 *    `NOAUTH HELLO ...`（报错说「认证失败」，真实原因却是「`.env` 没加载」）。
 *
 * ⚠️ **静态 import 会被提升**：写
 *    `import { AppModule } from '../src/app.module'` 时，整个应用图在
 *    **文件顶部**就被求值 —— 比脚本里任何一行代码都早，包括 `loadEnv()`。
 *    → 必须把加载推迟到 `.env` 加载**之后**：要么用 `await import(...)`，
 *    要么把 `require()` 放进函数体（`require()` 在被调用的那一刻才求值）。
 *
 * ⚠️ **这个坑极难自查**：报错是「Redis 认证失败」，而真正的原因是
 *    「模块求值顺序」——两者之间没有任何提示性的关联。
 *    脚本作者改一行无关代码就可能把问题带回来 → 需要静态护栏。
 */

import * as ts from 'typescript';

/** 一处「`.env` 加载顺序」问题 */
export interface EnvImportOrderFinding {
  /** 相对 api 根的路径 */
  file: string;
  /** 1 起始的行号（静态 import 所在行） */
  line: number;
  /** 命中的 import 原文 */
  snippet: string;
  /** 为什么判定为有问题 */
  reason: string;
}

/**
 * 判定「这个模块是应用图」的模块说明符。
 *
 * ⚠️ **只认 `app.module`**：能触发这个坑的模块图必须包含
 *    `queue.module.ts`，而目前只有 `app.module.ts` 满足。
 *    将来若新增别的应用图入口，在这里登记即可。
 */
const APP_MODULE_SPECIFIERS = ['../src/app.module', './app.module'];

/**
 * 判定「这个 import 有运行期求值」。
 *
 * ⚠️ **动态 import 不算**：`await import('../src/app.module')` 的求值
 *    发生在调用点，脚本可以在它之前加载 `.env` → 正是我们想要的写法。
 *    （本仓的运维脚本实际用的是「函数体内的 `require()`」——
 *    原因见 `scripts/check-ledger.ts` 里的注释：`await import()` 在
 *    `tsc --noEmit` 的 `nodenext` 解析下要求带扩展名，
 *    那个路径在 ts-node 的 CommonJS 运行期又找不到文件。）
 *
 * ⚠️ **纯类型 import 不算**：`import type { X } from '...'` 与
 *    `import { type X } from '...'` 在编译期被**擦除**，不产生任何
 *    运行期求值 → 不会把模块提前求值 → 不构成这个问题。
 *
 * ⚠️ **副作用 import 算**：`import '../src/app.module';`（只有模块说明符）
 *    明确要求「执行这个模块」→ 一定是运行期求值 → 要报。
 */
function hasRuntimeEvaluation(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;

  // 副作用 import：没有 importClause，但仍然有运行期求值。
  if (clause === undefined) {
    return true;
  }

  // `import type { X } from '...'`：整个 import 被擦除。
  if (clause.isTypeOnly) {
    return false;
  }

  // `import { type X } from '...'`：命名导入全是类型 → 整个 import 被擦除。
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    const allTypeOnly =
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly);
    if (allTypeOnly) {
      return false;
    }
  }

  return true;
}

/**
 * 判定「这个 `require()` 调用的是应用图」。
 *
 * ⚠️ **`require()` 没有延迟语义**：它在**被调用的那一刻**就求值。
 *    所以「在不在函数体内」决定了它会不会早于 `.env` 加载 ——
 *    函数体内的 `require()` 在调用时才求值，脚本可以先加载 `.env` 再调用它。
 */
function isAppModuleRequire(node: ts.CallExpression): boolean {
  if (
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'require' ||
    node.arguments.length !== 1
  ) {
    return false;
  }
  const arg = node.arguments[0];
  return ts.isStringLiteral(arg) && APP_MODULE_SPECIFIERS.includes(arg.text);
}

/** 是不是「函数体」——进入它就意味着里面的 `require()` 是延迟求值的 */
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * 扫一个 Program，找出「静态 import 应用图」的文件。
 *
 * ⚠️ **只看 `scripts/` 下的文件**：应用本身（`src/main.ts`）由容器注入
 *    环境变量，且 `main.ts` 走的是「启动前读 env」的路子，不适用这条规则。
 */
export function scanProgram(
  program: ts.Program,
  apiRoot: string,
): EnvImportOrderFinding[] {
  const findings: EnvImportOrderFinding[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes('node_modules')) {
      continue;
    }

    // ⚠️ **只扫 `scripts/`**：应用代码（`src/`）不受这条规则约束。
    const relative = sf.fileName.replace(apiRoot + '/', '');
    if (!relative.startsWith('scripts/')) {
      continue;
    }

    // ⚠️ **不用 `node.parent` 判定「在不在函数体内」**：
    //    `ts.createProgram` 在本仓的编译选项下**不填 parent 指针**
    //    （只有 `ts.createSourceFile` 会填）→ 靠 parent 上爬会拿到
    //    `undefined` → 判定恒为「不在函数体内」→ 函数体内的 `require()`
    //    被误报。→ 改成**手动递归并自己数函数深度**。
    //
    //    同款做法见 `common/guards/controller-roles-scanner.ts`（它干脆不用 parent）。
    const visit = (node: ts.Node, functionDepth: number): void => {
      if (ts.isCallExpression(node) && functionDepth === 0) {
        if (isAppModuleRequire(node)) {
          const arg = node.arguments[0] as ts.StringLiteral;
          findings.push({
            file: relative,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            snippet: arg.text,
            reason:
              '顶层 require() 会立即求值：应用图（含 queue.module.ts）在 .env ' +
              '加载前就被求值 → REDIS_URL 读不到 → 落到无密码的 fallback → ' +
              'Redis 报 NOAUTH。把 require 挪进函数体，或改用 `await import(...)`。',
          });
        }
      }

      if (ts.isImportDeclaration(node) && hasRuntimeEvaluation(node)) {
        const specifier = node.moduleSpecifier;
        if (
          ts.isStringLiteral(specifier) &&
          APP_MODULE_SPECIFIERS.includes(specifier.text)
        ) {
          findings.push({
            file: relative,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            snippet: specifier.text,
            reason:
              '静态 import 会被提升到文件顶部：应用图（含 queue.module.ts）' +
              '在 .env 加载前就被求值 → REDIS_URL 读不到 → 落到无密码的 ' +
              'fallback → Redis 报 NOAUTH。改用 `await import(...)`。',
          });
        }
      }

      const depth = isFunctionLike(node) ? functionDepth + 1 : functionDepth;
      ts.forEachChild(node, (child) => visit(child, depth));
    };

    visit(sf, 0);
  }

  return findings;
}

/** 把一条命中渲染成人能读的说明 */
export function describeViolation(finding: EnvImportOrderFinding): string {
  return `${finding.file}:${finding.line} → ${finding.snippet}\n  ${finding.reason}`;
}
