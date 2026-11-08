import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// ⚠️ 兜底：`process.loadEnvFile` 在 jest 多 worker 下**偶发不生效**
// （实测同一个仓库、同一次运行，两个 worker 一个加载成功、一个什么都没设，
// 表现为 tenant-prisma 的用例随机报「Environment variable not found:
// DATABASE_URL」——复现概率约 50%，CI 上因为显式注入环境变量而从不出现）。
// 不深究引擎内部原因了，直接逐行解析一遍，只填**缺失**的键，
// 语义与 loadEnvFile 的「已存在的变量不覆盖」一致。
if (existsSync(envPath) && !process.env.DATABASE_URL_TEST) {
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 与 Node 内建解析同款：剥掉成对引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// 单元测试也跑在测试库上，避免污染开发数据。
// setupFiles 在测试框架初始化前执行，早于 PrismaClient 被实例化，
// 所以这里的 DATABASE_URL 改写会生效。
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
