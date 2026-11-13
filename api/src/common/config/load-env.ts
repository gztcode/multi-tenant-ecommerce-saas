import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 加载 `.env`（Node 20.12+ 内建的 `process.loadEnvFile`）。
 *
 * ⚠️ **为什么要有这个共享入口**：`.env` 必须在**应用图被求值之前**加载。
 *    `api/scripts/` 下的运维脚本要 import 整个 Nest 应用图（`AppModule`），
 *    而应用图里有 `queue.module.ts` —— 它的 `BullModule.forRoot` 参数是
 *    **模块装饰器求值时**（import 的那一刻）定死的，那时 `REDIS_URL`
 *    还是 undefined → 落到不带密码的 fallback → 本机 Redis 开了
 *    `requirepass` → `NOAUTH HELLO ...`（报错说「认证失败」，
 *    真实原因却是「你的 `.env` 根本没被加载」）。
 *
 * ⚠️ **不能依赖 Prisma 的副作用**：Prisma 6 的 client 确实会在实例化时
 *    顺带加载 `.env` —— **前提是生成 client 时记录的 `schemaEnvPath`
 *    指向一个真实存在的文件**。那是「在哪生成 client」决定的副作用，
 *    换个目录重新 `prisma generate` 就会失效 → 脚本行为随环境漂移。
 *    → `.env` 必须由脚本**自己显式加载**，且**先于**应用图的 import。
 *
 * ⚠️ **`loadEnvFile` 不覆盖已存在的变量**：语义与 `dotenv` 一致，
 *    容器里注入的环境变量优先级更高，不会被 `.env` 里的旧值盖掉。
 *
 * ⚠️ **文件不存在就跳过**：容器里的环境变量是直接注入的，
 *    没有 `.env` 是正常状态，不该因此崩掉。
 *
 * ⚠️ **路径是模块内的相对路径**（`api/src/common/config/` → `api/.env`），
 *    与调用方的 cwd 无关 —— 脚本从任何目录跑都加载同一个文件。
 */
export function loadEnvFile(envPath?: string): void {
  const path = envPath ?? resolve(__dirname, '..', '..', '..', '.env');
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
