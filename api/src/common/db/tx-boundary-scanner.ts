/**
 * 事务边界检测器（阶段 10）。
 *
 * ⚠️ **为什么要它**：Prisma 的交互事务（`$transaction(async (tx) => ...)`）
 *    会**独占一条连接**。若回调内部经非事务客户端（`this.prisma`）再查一次库，
 *    就要**再借一条连接** —— 连接池小时（GitHub 2 核 runner 默认只有 5）
 *    并发写路径会互相等死，报 `P2024`「Timed out fetching a new connection」。
 *
 * ⚠️ **检测靠类型信息 + 全局调用图，不靠文本匹配**：
 *    真实的问题几乎都藏在**方法转调链**里 ——
 *    `this.coupon.computeForOrder(...)` 自己不碰库，但它转调的
 *    `buildDiscountContext` 里用了 `this.prisma`。
 *    文本匹配只能看到第一层，静态类型 + 调用图才能看到完整链路。
 *
 * ⚠️ **判定口径是「会不会借到第二条连接」**：
 *    - `this.prisma`（裸的或带成员访问）→ 一定借第二条（危险）；
 *    - 事务客户端 `tx.*` → 复用同一条（安全）；
 *    - 纯内存计算 → 不碰库（安全）。
 */

import * as ts from 'typescript';

/** 一处可疑点 */
export interface TxBoundaryFinding {
  /** 相对 api 根的路径 */
  file: string;
  /** 1 起始的行号 */
  line: number;
  /** 命中处调用表达式原文 */
  snippet: string;
  /** 为什么判定为可疑 */
  reason: string;
  /** 调用链：从事务回调一路到真正借连接的那一处 */
  chain: string[];
  /**
   * 借用点所在的方法名。
   *
   * ⚠️ **豁免锚点用它，不用行号**：行号会随任何改动漂移，
   *    豁免会莫名其妙失效（或误放行）。
   */
  method: string;
  /**
   * 借用点的整条属性访问表达式（如 `this.prisma.coupon.findMany`）。
   *
   * ⚠️ 同上：它比行号稳定，是豁免锚点的另一半。
   */
  expr: string;
}

/** 调用链的最大深度（够用且不会无限递归） */
const MAX_DEPTH = 6;

/** 方法声明的身份：所属类名 + 方法名 */
type MethodKey = string;

interface Analyzer {
  checker: ts.TypeChecker;
  /** 方法声明 → 所属类 */
  ownerOf: Map<ts.MethodDeclaration, ts.ClassDeclaration>;
  /** 类 → 它的方法 */
  methodsOf: Map<ts.ClassDeclaration, Map<string, ts.MethodDeclaration>>;
  /** api 根目录绝对路径（用于产出相对路径） */
  apiRoot: string;
}

/** 方法声明的身份键 */
function keyOf(
  owner: ts.ClassDeclaration,
  method: ts.MethodDeclaration,
): MethodKey {
  return `${owner.name?.text ?? '<anonymous>'}#${method.name?.getText() ?? ''}`;
}

/**
 * 建索引：每个方法声明属于哪个类、每个类有哪些方法。
 */
function buildIndex(sourceFiles: ts.SourceFile[]): {
  ownerOf: Map<ts.MethodDeclaration, ts.ClassDeclaration>;
  methodsOf: Map<ts.ClassDeclaration, Map<string, ts.MethodDeclaration>>;
} {
  const ownerOf = new Map<ts.MethodDeclaration, ts.ClassDeclaration>();
  const methodsOf = new Map<
    ts.ClassDeclaration,
    Map<string, ts.MethodDeclaration>
  >();

  for (const sf of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const methods = new Map<string, ts.MethodDeclaration>();
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            const key = ts.isIdentifier(member.name)
              ? member.name.text
              : member.name.getText();
            methods.set(key, member);
            ownerOf.set(member, node);
          }
        }
        methodsOf.set(node, methods);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { ownerOf, methodsOf };
}

/** 一处借用第二连接的位置 */
interface PrismaUsage {
  /** 借用点所在文件（相对 api 根） */
  file: string;
  /** 借用点行号 */
  line: number;
  /** 借用点原文 */
  snippet: string;
  /** 从事务回调到借用点的调用链 */
  chain: string[];
  /** 借用点所在的方法名 */
  method: string;
  /** 借用点的整条属性访问表达式 */
  expr: string;
}

/**
 * 找出某个节点所在的方法名。
 *
 * ⚠️ 事务回调本身常是箭头函数（不是方法声明），
 *    所以要沿 `parent` 往上找到第一个 `MethodDeclaration`。
 */
function enclosingMethodName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isMethodDeclaration(current) && current.name) {
      return current.name.getText();
    }
    current = current.parent;
  }
  return '<anonymous>';
}

/**
 * 从 `this.prisma` 往上爬到**最外层**的属性访问表达式。
 *
 * `this.prisma.coupon.findMany(...)` 里，`this.prisma` 只是链的一环；
 * 豁免锚点要用整条链（`this.prisma.coupon.findMany`），
 * 否则同一行里换一个模型就会「碰巧不匹配」。
 *
 * ⚠️ **只能沿 `parent` 往上爬**：`ts.forEachChild` 是向下走的，
 *    拿不到外层表达式。
 */
function outermostPropertyAccess(node: ts.PropertyAccessExpression): string {
  let current: ts.Node = node;
  let text = node.getText();
  while (
    current.parent &&
    ts.isPropertyAccessExpression(current.parent) &&
    current.parent.expression === current
  ) {
    current = current.parent;
    text = current.getText();
  }
  return text;
}

/**
 * 在一个方法体里找所有「用了 `this.prisma`」的地方。
 *
 * ⚠️ **递归跟进任意方法调用**（同类 / 跨类都行），因为链可以很长：
 *    `createOrderInTx` → `this.coupon.computeForOrder` → `this.buildDiscountContext`
 *    → `this.prisma`。
 *
 * @param argCount 调用点传的实参个数（用于判断「client 参数有没有被显式传入」）
 * @returns 找到的所有借用点
 */
function findPrismaUsages(
  method: ts.MethodDeclaration,
  analyzer: Analyzer,
  chain: string[],
  visited: Set<MethodKey>,
  depth: number,
  argCount: number,
): PrismaUsage[] {
  const owner = analyzer.ownerOf.get(method);
  if (!owner || depth > MAX_DEPTH) {
    return [];
  }

  const key = keyOf(owner, method);
  if (visited.has(key)) {
    return [];
  }
  visited.add(key);

  const body = method.body;
  if (!body) {
    return [];
  }

  const usages: PrismaUsage[] = [];

  // ⚠️ **「client 参数没显式传」也是借用点**。
  //
  //    本阶段引入的模式是「方法接受可选客户端参数，默认值 `this.prisma`」。
  //    事务内调用时若**忘了显式传 `tx`**，方法体里的查询就会退回普通连接
  //    —— 借第二条连接，与直接写 `this.prisma` 是同一个失效模式。
  //
  //    只扫方法体完全看不到这一类：方法体里写的是 `client.foo`（不是
  //    `this.prisma`），扫不出来；漏传 client 却是真实的事故。
  //
  //    判定：**方法体用到 `client` 参数** 且 **调用点实参个数不足以覆盖它**
  //    → 该参数会取默认值 `this.prisma` → 借第二条连接。
  const clientParams = clientParamNames(method);
  for (const name of clientParams) {
    const paramIndex = method.parameters.findIndex(
      (p) => p.name.getText() === name,
    );
    if (paramIndex < 0) {
      continue;
    }
    // 方法体根本没用这个参数 → 用不用默认值都一样，不算借用点
    if (!bodyUsesIdentifier(method, name)) {
      continue;
    }
    // ⚠️ **实参个数不够**才会落到默认值。
    //    传了 undefined 也算「显式传了」—— 那是调用方自己的问题，
    //    但参数确实被覆盖了（默认值只在「没传」时生效）。
    if (argCount > paramIndex) {
      continue;
    }
    const sf = method.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(
      method.parameters[paramIndex].getStart(),
    );
    usages.push({
      file: sf.fileName.slice(analyzer.apiRoot.length + 1),
      line: line + 1,
      snippet: method.parameters[paramIndex].getText(),
      chain: [...chain],
      method: method.name?.getText() ?? '<anonymous>',
      expr: `参数 ${name} 未显式传入（将退回 this.prisma）`,
    });
  }

  const visit = (node: ts.Node): void => {
    // ① `this.prisma` 或 `this.prisma.xxx` —— 借第二条连接
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.name.text === 'prisma'
    ) {
      const sf = node.getSourceFile();
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      usages.push({
        file: sf.fileName.slice(analyzer.apiRoot.length + 1),
        line: line + 1,
        snippet: node.getText(),
        chain: [...chain],
        method: method.name?.getText() ?? '<anonymous>',
        expr: outermostPropertyAccess(node),
      });
      return;
    }

    // ② 方法调用 → 跟进被调方法
    if (ts.isCallExpression(node)) {
      const callee = resolveCallee(node, analyzer);
      if (callee) {
        usages.push(
          ...findPrismaUsages(
            callee.declaration,
            analyzer,
            [...chain, node.expression.getText()],
            visited,
            depth + 1,
            node.arguments.length,
          ),
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return usages;
}

/**
 * 找出「形如 `client: X = this.prisma`」的参数。
 *
 * @returns 参数名列表
 */
function clientParamNames(method: ts.MethodDeclaration): string[] {
  return method.parameters
    .filter((param) => {
      const init = param.initializer;
      return (
        !!init &&
        ts.isPropertyAccessExpression(init) &&
        init.expression.kind === ts.SyntaxKind.ThisKeyword &&
        init.name.text === 'prisma'
      );
    })
    .map((param) => param.name.getText());
}

/**
 * 方法体里是否用到了某个标识符（作为变量引用）。
 */
function bodyUsesIdentifier(
  method: ts.MethodDeclaration,
  name: string,
): boolean {
  let used = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !isPropertyNameOfAccess(node)
    ) {
      used = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (method.body) {
    visit(method.body);
  }
  return used;
}

/**
 * 这个标识符是不是「属性名」而非「变量引用」。
 *
 * `client.foo` 里的 `client` 是变量引用；
 * `obj.client` 里的 `client` 是属性名（不是变量）。
 */
function isPropertyNameOfAccess(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    !!parent && ts.isPropertyAccessExpression(parent) && parent.name === node
  );
}

/** 一个被调用方法的解析结果 */
interface Callee {
  declaration: ts.MethodDeclaration;
}

/**
 * 解析 `node` 这个调用表达式实际调到哪个方法声明。
 *
 * 覆盖三种形态：
 * - `this.method(...)` —— 本类方法；
 * - `this.svc.method(...)` —— 别的 service 的方法（靠类型解析）；
 * - `this.svc.method(...)` 里 `this.svc` 是 getter —— 同样靠类型解析。
 */
function resolveCallee(
  node: ts.CallExpression,
  analyzer: Analyzer,
): Callee | null {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) {
    return null;
  }

  const methodName = expression.name.text;
  const receiver = expression.expression;

  // 形态 A：`this.method(...)`
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
    const enclosing = findEnclosingClass(node);
    if (!enclosing) {
      return null;
    }
    const methods = analyzer.methodsOf.get(enclosing);
    const decl = methods?.get(methodName);
    return decl ? { declaration: decl } : null;
  }

  // 形态 B：`this.svc.method(...)` —— 解析 `this.svc` 的类型
  if (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const receiverType = analyzer.checker.getTypeAtLocation(receiver);
    const decl = findMethodInType(receiverType, methodName, analyzer);
    return decl ? { declaration: decl } : null;
  }

  return null;
}

/** 找包含某个节点的类声明 */
function findEnclosingClass(node: ts.Node): ts.ClassDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isClassDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** 在一个类型（含联合 / 交叉）里找方法声明 */
function findMethodInType(
  type: ts.Type,
  methodName: string,
  analyzer: Analyzer,
): ts.MethodDeclaration | null {
  const prop = type.getProperty(methodName);
  if (prop) {
    for (const d of prop.declarations ?? []) {
      if (ts.isMethodDeclaration(d)) {
        return d;
      }
      // getter 返回的对象：再往里找一层
      if (ts.isPropertyDeclaration(d) && d.initializer) {
        const inner = analyzer.checker.getTypeAtLocation(d.initializer);
        const nested = findMethodInType(inner, methodName, analyzer);
        if (nested) {
          return nested;
        }
      }
    }
  }

  if (type.isUnionOrIntersection()) {
    for (const part of type.types) {
      const found = findMethodInType(part, methodName, analyzer);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

/**
 * 一条已登记的豁免。
 *
 * ⚠️ **每条必须写 `why`**：将来有人想「顺手修掉」它时，
 *    会先看到理由 —— 而这正是它当初不能修的原因。
 *
 * ⚠️ **锚点用「文件 + 方法名 + 表达式」，不用行号**：
 *    行号会随任何改动漂移，豁免会莫名其妙失效（或误放行）。
 */
export interface TxBoundaryExemption {
  /** 相对 api 根的路径 */
  file: string;
  /** 借用点所在的方法名 */
  method: string;
  /** 借用点的属性访问表达式原文 */
  expr: string;
  /** 为什么可以豁免 */
  why: string;
}

/**
 * 剔除已登记的豁免点，返回**仍然违规**的项。
 */
export function findExemptViolations(
  findings: readonly TxBoundaryFinding[],
  exemptions: readonly TxBoundaryExemption[],
): TxBoundaryFinding[] {
  return findings.filter(
    (f) =>
      !exemptions.some(
        (e) => e.file === f.file && e.method === f.method && e.expr === f.expr,
      ),
  );
}

/**
 * 扫描整个程序，找出「事务回调内经非事务客户端取数」的可疑点。
 *
 * @param program 已加载类型信息的 ts.Program
 * @param apiRoot api 目录绝对路径（用于产出相对路径）
 */
export function scanProgram(
  program: ts.Program,
  apiRoot: string,
): TxBoundaryFinding[] {
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.fileName.includes('node_modules'));

  const { ownerOf, methodsOf } = buildIndex(sourceFiles);
  const analyzer: Analyzer = {
    checker: program.getTypeChecker(),
    ownerOf,
    methodsOf,
    apiRoot,
  };

  const findings: TxBoundaryFinding[] = [];

  for (const sf of sourceFiles) {
    if (!sf.fileName.includes('/src/')) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === '$transaction'
      ) {
        const callback = node.arguments[0];
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          const body = callback.body;
          // ⚠️ **两种体都要扫**：块体 `{ ... }` 与精简体 `async (tx) => this.f(tx)`。
          //    精简体很常见（`invoice.service.ts` 的 markInvoicePaid 就是），
          //    只扫块体会漏掉整条链。
          if (ts.isBlock(body)) {
            findings.push(...scanCallback(body, analyzer));
          } else {
            findings.push(...scanExpression(body, analyzer));
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  return findings;
}

/**
 * 扫描一个事务回调的**表达式体**（精简体箭头函数）。
 *
 * ⚠️ 与 `scanCallback` 的区别：这里没有块，表达式本身就是函数体。
 */
function scanExpression(
  expression: ts.Expression,
  analyzer: Analyzer,
): TxBoundaryFinding[] {
  const findings: TxBoundaryFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = resolveCallee(node, analyzer);
      if (callee) {
        const usages = findPrismaUsages(
          callee.declaration,
          analyzer,
          [node.expression.getText()],
          new Set<MethodKey>(),
          1,
          node.arguments.length,
        );
        for (const usage of usages) {
          findings.push({
            file: usage.file,
            line: usage.line,
            snippet: usage.snippet,
            reason: `事务回调内经调用链借了非事务连接（${node.expression.getText()}）`,
            chain: usage.chain,
            method: usage.method,
            expr: usage.expr,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(expression);
  return findings;
}

/** 扫描一个事务回调的函数体 */
function scanCallback(body: ts.Block, analyzer: Analyzer): TxBoundaryFinding[] {
  const findings: TxBoundaryFinding[] = [];

  const visit = (node: ts.Node): void => {
    // 情况 ⓪：裸的 `this.prisma` 出现在任何位置（**尤其是实参**）——
    //    `await this.prisma.databaseNow()` 里的 `this.prisma` 是实参，
    //    不是被调用表达式的 callee，漏了它就漏掉「事务回调内借连接」的主力形态。
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.name.text === 'prisma'
    ) {
      const sf = node.getSourceFile();
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      findings.push({
        file: sf.fileName.slice(analyzer.apiRoot.length + 1),
        line: line + 1,
        snippet: node.getText(),
        reason: '事务回调内直接用非事务客户端 this.prisma',
        chain: [node.getText()],
        method: enclosingMethodName(node),
        expr: outermostPropertyAccess(node),
      });
    }

    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const sf = node.getSourceFile();

      // 情况 ①：`this.prisma(...)` / `this.prisma.xxx(...)` —— 直接借第二条连接
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        expression.name.text === 'prisma'
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        findings.push({
          file: sf.fileName.slice(analyzer.apiRoot.length + 1),
          line: line + 1,
          snippet: expression.getText(),
          reason: '事务回调内直接用非事务客户端 this.prisma',
          chain: [expression.getText()],
          method: enclosingMethodName(node),
          expr: outermostPropertyAccess(expression),
        });
        ts.forEachChild(node, visit);
        return;
      }

      // 情况 ②：方法调用 → 跟进整条链
      const callee = resolveCallee(node, analyzer);
      if (callee) {
        const usages = findPrismaUsages(
          callee.declaration,
          analyzer,
          [node.expression.getText()],
          new Set<MethodKey>(),
          1,
          node.arguments.length,
        );
        for (const usage of usages) {
          findings.push({
            file: usage.file,
            line: usage.line,
            snippet: usage.snippet,
            reason: `事务回调内经调用链借了非事务连接（${node.expression.getText()}）`,
            chain: usage.chain,
            method: usage.method,
            expr: usage.expr,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(body);
  return findings;
}
