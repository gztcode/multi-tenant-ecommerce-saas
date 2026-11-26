import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// 兜底：逐行解析一遍 `.env`，只填**缺失**的键，语义与 `loadEnvFile` 的
// 「已存在的变量不覆盖」一致。
//
// ⚠️ 历史说明（2026-11-27 实测更正，见 docs/development.md「单测冷启动偶发变红」）：
//    这里原注释声称「`process.loadEnvFile` 在 jest 多 worker 下偶发不生效，
//    复现概率约 50%」——那是**推测，没有留下观测证据**。11 轮冷跑（每轮清库 +
//    清 jest 缓存 + 默认并行度）里一次都没出现 `Environment variable not
//    found: DATABASE_URL`，每轮日志都有 `Environment variables loaded from
//    .env`；当时那些「随机报环境变量缺失」的用例，根因是并行 worker 把机器压满
//    后 Prisma 查询超时（引擎空响应），不是环境变量没加载。
//    兜底代码保留：它很便宜，且 `.env` 缺失某个键时仍能救场；但**不要**再用
//    「loadEnvFile 偶发失效」解释测试随机变红 —— 先按上面那节的顺序查。
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
