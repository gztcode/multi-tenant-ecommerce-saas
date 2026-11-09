/**
 * 扫描 `api/scripts/` 下的运维脚本，找出「在 `.env` 加载前就求值应用图」的地方。
 *
 * 用法（在 `api/` 目录下）：
 *   npm run scan:env-import-order
 *
 * ⚠️ **CI 门禁在 `src/common/config/env-import-order-scanner.spec.ts`** ——
 *    那个 spec 会扫全仓并在有违规时变红。这个脚本是给人看的：
 *    想看「到底哪些脚本的 import 顺序有问题」时直接跑它。
 */
import { join } from 'node:path';

import * as ts from 'typescript';

import {
  describeViolation,
  listScriptFiles,
  scanProgram,
} from '../src/common/config/env-import-order-scanner';

const API_ROOT = join(__dirname, '..');

const program = ts.createProgram(
  listScriptFiles(API_ROOT),
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
    setParentNodes: true,
  },
  undefined,
  // ⚠️ 只解析本仓的源文件，不去解析 node_modules（快很多）
  undefined,
);

const findings = scanProgram(program, API_ROOT);

for (const finding of findings) {
  console.log(describeViolation(finding));
}
console.log(`\n共发现 ${findings.length} 处「.env 加载前就求值应用图」的写法`);

// ⚠️ **有违规就退出码非零**：让这个脚本也能当门禁用。
process.exit(findings.length > 0 ? 1 : 0);
