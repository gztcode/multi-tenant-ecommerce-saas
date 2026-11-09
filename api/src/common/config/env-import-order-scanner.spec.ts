import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import * as ts from 'typescript';

import {
  describeViolation,
  listScriptFiles,
  scanProgram,
  type EnvImportOrderFinding,
} from './env-import-order-scanner';

const API_ROOT = join(__dirname, '..', '..', '..');

/**
 * 用一段内联源码建一个最小 Program 并扫描。
 *
 * ⚠️ **为什么要造假宿主**：真实扫描要加载整个 `src/main.ts`（连带所有模块），
 *    慢且脆（某个模块的类型错误会让护栏自己先炸）。这里只喂一段自包含的
 *    源码，护栏的判定逻辑照样被完整验证。
 */
function scanFixture(source: string): EnvImportOrderFinding[] {
  const file = join(API_ROOT, 'scripts', '__env_import_fixture__.ts');
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
      setParentNodes: true,
    },
    host,
  );

  return scanProgram(program, API_ROOT);
}

describe('「.env 加载顺序」扫描器', () => {
  it('静态 import 应用图 → 报出', () => {
    const src = `
      import { AppModule } from '../src/app.module';
      async function main() {
        loadEnv();
        const app = await create(AppModule);
      }
    `;
    const findings = scanFixture(src);
    expect(findings.length).toBe(1);
    expect(findings[0].file).toBe('scripts/__env_import_fixture__.ts');
    expect(findings[0].snippet).toBe('../src/app.module');
  });

  it('动态 import（await import）→ 不报', () => {
    const src = `
      async function main() {
        loadEnv();
        const { AppModule } = await import('../src/app.module');
        const app = await create(AppModule);
      }
    `;
    expect(scanFixture(src)).toHaveLength(0);
  });

  it('import 别的模块 → 不报', () => {
    const src = `
      import { NestFactory } from '@nestjs/core';
      import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
    `;
    expect(scanFixture(src)).toHaveLength(0);
  });

  it('只 import 类型（import type）→ 不报', () => {
    // ⚠️ `import type` 在编译期被擦除，**不产生运行期求值** →
    //    不构成「模块提前求值」的问题。
    const src = `
      import type { AppModule } from '../src/app.module';
    `;
    expect(scanFixture(src)).toHaveLength(0);
  });

  it('副作用 import（只写模块说明符）→ 报出', () => {
    const src = `
      import '../src/app.module';
    `;
    expect(scanFixture(src)).toHaveLength(1);
  });

  it('顶层 require() 应用图 → 报出', () => {
    // ⚠️ `require()` 没有延迟语义：在顶层调用就立即求值。
    const src = `
      const { AppModule } = require('../src/app.module');
    `;
    const findings = scanFixture(src);
    expect(findings.length).toBe(1);
    expect(findings[0].snippet).toBe('../src/app.module');
  });

  it('函数体内的 require() → 不报', () => {
    // ⚠️ 函数体里的 `require()` 在**调用时**才求值 → 脚本可以先加载
    //    `.env` 再调用它 → 不构成「提前求值」的问题。
    const src = `
      function main() {
        const { AppModule } = require('../src/app.module');
        return AppModule;
      }
    `;
    expect(scanFixture(src)).toHaveLength(0);
  });
});

describe('全仓「.env 加载顺序」护栏', () => {
  // ⚠️ **建 Program 很慢**（要加载整个 scripts/ 下的文件及其依赖），
  //    给足超时时间，否则会因超时失败（而不是因为发现问题失败）。
  jest.setTimeout(300_000);

  it('运维脚本不允许静态 import 应用图', () => {
    const program = ts.createProgram(listScriptFiles(API_ROOT), {
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
    });
    const findings = scanProgram(program, API_ROOT);
    expect(findings.map(describeViolation)).toEqual([]);
  });

  it('扫描范围覆盖 scripts/ 下的全部脚本（护栏不能只看一个文件）', () => {
    // ⚠️ **回归测试（2026-11-10 实测发现的缺陷）**：
    //    原实现只把 `check-ledger.ts` 当 program 入口 →
    //    `program.getSourceFiles()` 里 `scripts/` 下的文件**只有那一个** →
    //    另外两个同样 import 应用图的脚本（`backfill-commission-entries.ts`、
    //    `retry-pre-payout-failures.ts`）**完全不在扫描范围里** →
    //    把它们改回「静态 import 应用图」，护栏仍报 0 处 → **假全仓**。
    //
    //    这条断言锁死「入口必须是全部脚本」，防止将来又退回单文件。
    const files = listScriptFiles(API_ROOT);
    const names = files.map((f) => f.split('/').pop());

    // 三个会 import 应用图的运维脚本都必须在扫描范围里
    expect(names).toEqual(
      expect.arrayContaining([
        'check-ledger.ts',
        'backfill-commission-entries.ts',
        'retry-pre-payout-failures.ts',
      ]),
    );

    // ⚠️ **不能只有一个**：护栏若只扫一个文件，其余脚本就形同没护栏。
    const scriptDir = join(API_ROOT, 'scripts');
    const allScripts = readdirSync(scriptDir).filter((n) => n.endsWith('.ts'));
    // 扫描器 CLI 自身不需要被扫（它 import 的是扫描器，不是应用图）
    expect(files.length).toBe(allScripts.length - 1);
  });
});
