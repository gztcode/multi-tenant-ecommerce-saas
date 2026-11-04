/**
 * 扫描 api 源码，列出「事务回调内经非事务客户端取数」的可疑点。
 *
 * 用法（在 api/ 目录下）：
 *   npm run scan:tx-boundary
 */
import { join } from 'node:path';

import * as ts from 'typescript';

import { scanProgram } from '../src/common/db/tx-boundary-scanner';

const API_ROOT = join(__dirname, '..');

const program = ts.createProgram(
  [join(API_ROOT, 'src', 'main.ts')],
  {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    // ⚠️ **必须开**：`createProgram` 默认不设 parent 指针，
    //    而检测器要靠 `node.parent` 找到「调用点属于哪个类」——
    //    关掉它会让同类方法解析静默失效（少报，不是多报）。
    setParentNodes: true,
  },
  undefined,
  // ⚠️ 只解析本仓的源文件，不去解析 node_modules（快很多）
  undefined,
);

const findings = scanProgram(program, API_ROOT);

for (const f of findings) {
  console.log(`${f.file}:${f.line}\t${f.reason}\t${f.snippet}`);
  console.log(`    链：${f.chain.join(' → ')}`);
}
console.log(`\n共 ${findings.length} 处可疑点`);
