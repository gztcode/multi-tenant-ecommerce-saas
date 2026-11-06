/**
 * 控制器角色限定的静态扫描器（2026-11-05 审计 §四 护栏）。
 *
 * ⚠️ **为什么要它**：`@Roles()` 是挂 `RolesGuard` 的唯一入口，
 *    漏挂 = 静默敞开——消费者令牌就能改价、改库存、下架商品
 *    （审计 P1-1 已在运行中的栈上端到端复现过资损链）。
 *    逐路由显式开启是**系统性风险**：这次漏挂 5 个控制器，下次可能漏别的。
 *    `roles.contract.spec.ts` 只能盯住「已知的 5 个控制器」，
 *    新增控制器就漏了 —— 本扫描器盯的是**全仓所有控制器路由**。
 *
 * ⚠️ **规则不能是「无 `@Roles` 就报错」**：全仓 129 条控制器路由里，
 *    39 条按设计就不该有角色限定（消费者路由 / 公开路由 / 渠道回调 /
 *    假网关 / 注册与登录 / 健康检查）。硬报会让规则永远 exit 1，
 *    护栏变成噪音（与 tx 边界扫描器踩过的坑同源）。
 *    → 规则分成三层：
 *      ① **有角色限定**（类级或方法级 `@Roles`）→ 放行；
 *      ② **公开 / 跳过上下文**（`@Public()` 或 `@Skip()`）→ 放行；
 *      ③ **其余的按设计免角色** → 必须登记在
 *         `controller-roles-exemptions.ts` 里，否则报错。
 *    ③ 的登记是**逐条列方法名**的：往任何一个控制器新增路由而没登记，
 *    扫描立刻变红 → 新路由必须被显式分类（要么挂角色，要么登记理由）。
 */

import * as ts from 'typescript';

/**
 * 一条已登记的「按设计免角色限定」豁免。
 *
 * ⚠️ **锚点用「文件 + 方法名」，不用行号**：行号会随任何改动漂移，
 *    豁免会莫名其妙失效（或误放行）。
 */
export interface ControllerRolesExemption {
  /** 相对 api 根的路径 */
  file: string;
  /** 该文件里按设计免角色限定的方法名 */
  methods: string[];
  /** 为什么这些路由按设计不需要角色限定 */
  why: string;
}

/** 一条控制器路由 */
export interface ControllerRoute {
  /** 相对 api 根的路径 */
  file: string;
  /** 1 起始的行号（路由方法所在行） */
  line: number;
  /** 控制器类名 */
  controller: string;
  /** 路由方法名 */
  method: string;
  /** HTTP 动词装饰器名（Get / Post / Put / Patch / Delete / All） */
  verb: string;
  /** 控制器的路径前缀（`@Controller('...')` 的参数） */
  controllerPath: string;
  /** 方法上的路径片段 */
  path: string;
  /** 类级是否挂了 `@Roles` */
  classRoles: boolean;
  /** 方法级是否挂了 `@Roles` */
  methodRoles: boolean;
  /** 是否 `@Public()`（公开路由：放行身份认证，但照常解析租户） */
  isPublic: boolean;
  /** 是否 `@Skip()`（跳过租户上下文解析与身份认证） */
  isSkip: boolean;
}

/** Nest 的 HTTP 动词装饰器 */
const HTTP_VERBS = new Set([
  'Get',
  'Post',
  'Put',
  'Delete',
  'Patch',
  'All',
  'Head',
  'Options',
]);

/**
 * 取一个节点上的装饰器名字。
 *
 * ⚠️ **只读 `Identifier.text`，不调 `getText()`**：`getText()` 依赖
 *    `node.getSourceFile()`，而装饰器表达式在某些 AST 形态下拿不到
 *    sourceFile（会抛 `Cannot read properties of undefined`）。
 *    `text` 是节点自带的字面量，不需要 sourceFile。
 */
function decoratorNames(node: ts.Node): string[] {
  if (!ts.canHaveDecorators(node)) return [];
  const names: string[] = [];
  for (const d of ts.getDecorators(node) ?? []) {
    const expr = d.expression;
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      names.push(ts.isIdentifier(callee) ? callee.text : '');
    } else if (ts.isIdentifier(expr)) {
      names.push(expr.text);
    }
  }
  return names;
}

/**
 * 取某个装饰器的**第一个字符串参数**（如 `@Get(':id')` 的 `':id'`）。
 *
 * @returns 参数原文；没有字符串参数时返回空串
 */
function stringArgOf(node: ts.Node, decorator: string): string {
  if (!ts.canHaveDecorators(node)) return '';
  for (const d of ts.getDecorators(node) ?? []) {
    const expr = d.expression;
    if (!ts.isCallExpression(expr)) continue;
    const callee = expr.expression;
    if (!ts.isIdentifier(callee) || callee.text !== decorator) continue;
    const arg = expr.arguments[0];
    return arg && ts.isStringLiteral(arg) ? arg.text : '';
  }
  return '';
}

/** 节点所在的行号（1 起始） */
function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return line + 1;
}

/**
 * 一个文件里「本地名 → 它是从哪个装饰器模块导入的」的映射。
 *
 * ⚠️ **为什么要按导入来源解析，而不是直接认装饰器名字**：
 *    有人写 `import { Roles as MerchantRoles } from '.../roles.decorator'`
 *    再写 `@MerchantRoles(...)` 时，按名字匹配的扫描器会**认不出来**
 *    → 那些路由会被当成「没挂角色」→ 护栏报错（吵，但安全）；
 *    反过来更糟的是有人把 `Roles` 换成一个**同名的别的装饰器**，
 *    按名字匹配就分不清了。
 *    → 按「从哪个模块导入 + 本地叫什么」来认，才不会认错。
 */
interface DecoratorBindings {
  /** 指向 `roles.decorator` 的本地名 */
  roles: Set<string>;
  /** 指向 `public.decorator` 的本地名 */
  public: Set<string>;
  /** 指向 `skip.decorator` 的本地名 */
  skip: Set<string>;
}

/** 从装饰器模块的导入声明里，取出「被导入名」对应的本地名 */
function localNamesOf(
  sf: ts.SourceFile,
  moduleSuffix: string,
  importedName: string,
): string[] {
  const names: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!stmt.moduleSpecifier.text.endsWith(moduleSuffix)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      // `import { Roles as R }` → 被导入名是 'Roles'，本地名是 'R'
      const imported = el.propertyName?.text ?? el.name.text;
      if (imported === importedName) names.push(el.name.text);
    }
  }
  return names;
}

/** 任意模块里被导入成这个名字的本地名（不限来源模块） */
function localNamesAnywhere(sf: ts.SourceFile, importedName: string): string[] {
  const names: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = el.propertyName?.text ?? el.name.text;
      if (imported === importedName) names.push(el.name.text);
    }
  }
  return names;
}

/**
 * 解析一个装饰器在这个文件里的本地名集合。
 *
 * ⚠️ **回退只在本文件压根没 import 过这个名字时生效**：
 *    单测的假宿主不 import 真实装饰器，靠回退仍能测判定规则；
 *    但如果它 import 了**别的模块的同名符号**，就不能回退 ——
 *    否则会把「另一个模块的 Roles」误认成角色限定（护栏假绿）。
 */
function resolveBinding(
  sf: ts.SourceFile,
  moduleSuffix: string,
  importedName: string,
): Set<string> {
  const fromModule = localNamesOf(sf, moduleSuffix, importedName);
  if (fromModule.length > 0) return new Set(fromModule);
  const fromElsewhere = localNamesAnywhere(sf, importedName);
  return new Set(fromElsewhere.length > 0 ? [] : [importedName]);
}

/**
 * 取一个文件里三个装饰器的本地名。
 */
function decoratorBindings(sf: ts.SourceFile): DecoratorBindings {
  return {
    roles: resolveBinding(sf, 'roles.decorator', 'Roles'),
    public: resolveBinding(sf, 'public.decorator', 'Public'),
    skip: resolveBinding(sf, 'skip.decorator', 'Skip'),
  };
}

/** 收集一个控制器类里的全部路由 */
function collectRoutes(
  sf: ts.SourceFile,
  cls: ts.ClassDeclaration,
  apiRoot: string,
  out: ControllerRoute[],
): void {
  const classDecorators = decoratorNames(cls);
  // ⚠️ **没有 `@Controller` 的类不是控制器** —— Nest 不会给它注册路由，
  //    它也就没有「该不该限角色」这回事。放在 `*.controller.ts` 文件里的
  //    普通类（比如被别处 import 的辅助类）不能算进扫描范围。
  if (!classDecorators.includes('Controller')) return;

  const bindings = decoratorBindings(sf);
  const hasAny = (names: string[], bound: Set<string>): boolean =>
    names.some((n) => bound.has(n));

  const classRoles = hasAny(classDecorators, bindings.roles);
  const classPublic = hasAny(classDecorators, bindings.public);
  const classSkip = hasAny(classDecorators, bindings.skip);
  const controllerPath = stringArgOf(cls, 'Controller');

  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member) || !member.name) continue;

    const methodDecorators = decoratorNames(member);
    const verb = methodDecorators.find((d) => HTTP_VERBS.has(d));
    if (!verb) continue;

    out.push({
      file: sf.fileName.slice(apiRoot.length + 1),
      line: lineOf(member, sf),
      controller: cls.name?.text ?? '<匿名>',
      method: ts.isIdentifier(member.name)
        ? member.name.text
        : member.name.getText(),
      verb,
      controllerPath,
      path: stringArgOf(member, verb),
      classRoles,
      methodRoles: hasAny(methodDecorators, bindings.roles),
      // ⚠️ **方法级覆盖类级**（`Reflector.getAllAndOverride` 的语义）：
      //    `@Public()` 只有 true 一种取值，所以「或」与「覆盖」等价。
      isPublic: hasAny(methodDecorators, bindings.public) || classPublic,
      isSkip: hasAny(methodDecorators, bindings.skip) || classSkip,
    });
  }
}

/**
 * 扫描整个程序，列出**全部控制器路由**。
 *
 * @param program 已加载类型信息的 ts.Program
 * @param apiRoot api 目录绝对路径（用于产出相对路径）
 */
export function scanControllerRoutes(
  program: ts.Program,
  apiRoot: string,
): ControllerRoute[] {
  const routes: ControllerRoute[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes('node_modules')) continue;
    if (!sf.fileName.includes('/src/')) continue;
    if (!sf.fileName.endsWith('.controller.ts')) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        collectRoutes(sf, node, apiRoot, routes);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return routes;
}

/** 这条路由是不是被登记的豁免盖住了 */
export function isExempt(
  route: ControllerRoute,
  exemptions: readonly ControllerRolesExemption[],
): boolean {
  return exemptions.some(
    (e) => e.file === route.file && e.methods.includes(route.method),
  );
}

/**
 * 找出「应当有角色限定却没有」的路由。
 *
 * 判定顺序（与 `RolesGuard` / `JwtAuthGuard` 的实际语义一致）：
 * 1. 类级或方法级挂了 `@Roles` → 有角色限定，放行；
 * 2. 挂了 `@Public()` 或 `@Skip()` → 公开 / 不建租户上下文，放行；
 * 3. 登记在豁免表里 → 按设计免角色，放行；
 * 4. 其余 → **违规**。
 */
export function findRoleViolations(
  routes: readonly ControllerRoute[],
  exemptions: readonly ControllerRolesExemption[],
): ControllerRoute[] {
  return routes.filter((route) => {
    if (route.classRoles || route.methodRoles) return false;
    if (route.isPublic || route.isSkip) return false;
    return !isExempt(route, exemptions);
  });
}

/** 给违规路由拼一句人话（报错信息用） */
export function describeViolation(route: ControllerRoute): string {
  const full = [route.controllerPath, route.path]
    .filter((p) => p && p !== '-')
    .join('/')
    .replace(/\/+/g, '/');
  return `${route.file}:${route.line} ${route.controller}.${route.method}（${route.verb} ${full || '/'}）没有 @Roles，也没有登记豁免`;
}
