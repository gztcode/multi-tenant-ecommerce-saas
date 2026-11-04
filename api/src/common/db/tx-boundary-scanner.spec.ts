import { join } from 'node:path';

import * as ts from 'typescript';

import {
  findExemptViolations,
  scanProgram,
  type TxBoundaryFinding,
} from './tx-boundary-scanner';
import { TX_BOUNDARY_EXEMPTIONS } from './tx-boundary-exemptions';

const API_ROOT = join(__dirname, '..', '..', '..');

/**
 * 用一段内联源码建一个最小 Program 并扫描。
 *
 * ⚠️ **为什么要造假宿主**：真实扫描要加载整个 `src/main.ts`（连带所有模块），
 *    慢且脆（某个模块的类型错误会让护栏自己先炸）。这里只喂一段自包含的
 *    源码，护栏的判定逻辑（回调 → 方法转调 → `this.prisma`）照样被完整验证。
 */
function scanSource(source: string): TxBoundaryFinding[] {
  const file = join(API_ROOT, 'src', '__tx_boundary_fixture__.ts');
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
      // ⚠️ **必须开**：检测器靠 `node.parent` 找「调用点属于哪个方法」
      //    与「属性访问链的最外层表达式」。
      setParentNodes: true,
    },
    host,
  );

  return scanProgram(program, API_ROOT);
}

describe('事务边界扫描器', () => {
  it('事务回调内直接用 this.prisma → 报出', () => {
    const src = `
      class A {
        async run(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            await this.prisma.foo.findMany();
          });
        }
      }
    `;
    const findings = scanSource(src);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].expr).toBe('this.prisma.foo.findMany');
    expect(findings[0].method).toBe('run');
  });

  it('事务回调内只用量 tx → 不报', () => {
    const src = `
      class A {
        async run(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            await tx.foo.findMany();
          });
        }
      }
    `;
    expect(scanSource(src)).toHaveLength(0);
  });

  it('事务外用 this.prisma → 不报', () => {
    const src = `
      class A {
        async run(prisma: any) {
          await this.prisma.foo.findMany();
          return prisma.$transaction(async (tx: any) => {
            await tx.bar.findMany();
          });
        }
      }
    `;
    expect(scanSource(src)).toHaveLength(0);
  });

  it('事务回调内经方法转调用 this.prisma → 报出，并给出调用链', () => {
    const src = `
      class A {
        async run(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            await this.helper();
          });
        }
        private async helper() {
          return this.prisma.foo.findMany();
        }
      }
    `;
    const findings = scanSource(src);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].method).toBe('helper');
    expect(findings[0].chain.join(' → ')).toContain('this.helper');
  });

  it('事务回调的精简体函数体（async (tx) => this.f(tx)）也要扫', () => {
    const src = `
      class A {
        async run(prisma: any) {
          return prisma.$transaction(async (tx: any) => this.helper(tx));
        }
        private async helper(tx: any) {
          return this.prisma.foo.findMany();
        }
      }
    `;
    expect(scanSource(src).length).toBeGreaterThan(0);
  });

  it('参数的默认值兜底（client = this.prisma）也要报', () => {
    // ⚠️ **这是护栏的关键盲区**：本阶段引入的「方法接受可选客户端参数」
    //    模式，默认值就是 `this.prisma`。事务内调用时若忘了显式传 `tx`，
    //    就会退回普通连接借第二条 —— 只扫方法体的话完全检测不到。
    const src = `
      class A {
        async run(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            await this.helper(prisma);
          });
        }
        private async helper(prisma: any, client: any = this.prisma) {
          return client.foo.findMany();
        }
      }
    `;
    const findings = scanSource(src);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].expr).toContain('client');
  });

  it('显式传了 client → 不报', () => {
    const src = `
      class A {
        async run(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            await this.helper(prisma, tx);
          });
        }
        private async helper(prisma: any, client: any = this.prisma) {
          return client.foo.findMany();
        }
      }
    `;
    expect(scanSource(src)).toHaveLength(0);
  });

  it('方法体没用 client 参数 → 不报', () => {
    // 方法体压根不用这个参数，取不取默认值都一样 → 不是借用点
    const src = `
      class A {
        async run(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            await this.helper(prisma);
          });
        }
        private async helper(prisma: any, client: any = this.prisma) {
          return prisma.foo.findMany();
        }
      }
    `;
    expect(scanSource(src)).toHaveLength(0);
  });
});

describe('豁免机制', () => {
  it('豁免条目能剔除对应的借用点', () => {
    const findings: TxBoundaryFinding[] = [
      {
        file: 'src/a.ts',
        line: 10,
        snippet: 'this.prisma',
        reason: '',
        chain: [],
        method: 'foo',
        expr: 'this.prisma.bar.findMany',
      },
    ];
    const violations = findExemptViolations(findings, [
      {
        file: 'src/a.ts',
        method: 'foo',
        expr: 'this.prisma.bar.findMany',
        why: '测试用',
      },
    ]);
    expect(violations).toHaveLength(0);
  });

  it('方法名或表达式对不上 → 不豁免', () => {
    const findings: TxBoundaryFinding[] = [
      {
        file: 'src/a.ts',
        line: 10,
        snippet: 'this.prisma',
        reason: '',
        chain: [],
        method: 'foo',
        expr: 'this.prisma.bar.findMany',
      },
    ];
    const violations = findExemptViolations(findings, [
      {
        file: 'src/a.ts',
        method: 'other',
        expr: 'this.prisma.bar.findMany',
        why: '测试用',
      },
    ]);
    expect(violations).toHaveLength(1);
  });
});

describe('全仓事务边界护栏', () => {
  // ⚠️ **建 Program 很慢**（要加载整个 src/main.ts 及其依赖），
  //    给足超时时间，否则会因超时失败（而不是因为发现问题失败）。
  jest.setTimeout(300_000);

  it('除了已登记的豁免，不允许再有借用点', () => {
    const program = ts.createProgram([join(API_ROOT, 'src', 'main.ts')], {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      // ⚠️ **必须开**：检测器靠 `node.parent` 做方法解析与属性链上爬。
      setParentNodes: true,
    });
    const findings = scanProgram(program, API_ROOT);
    const violations = findExemptViolations(findings, TX_BOUNDARY_EXEMPTIONS);
    expect(violations.map((v) => `${v.file}:${v.method} → ${v.expr}`)).toEqual(
      [],
    );
  });
});
