import { join } from 'node:path';

import * as ts from 'typescript';

import {
  describeViolation,
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
    const program = ts.createProgram(
      [join(API_ROOT, 'scripts', 'check-ledger.ts')],
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
    );
    const findings = scanProgram(program, API_ROOT);
    expect(findings.map(describeViolation)).toEqual([]);
  });
});
