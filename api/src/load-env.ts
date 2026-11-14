import { loadEnvFile } from './common/config/load-env';

/**
 * 副作用模块：加载 `.env`。
 *
 * ⚠️ **为什么必须是一个独立文件**：`.env` 要在**应用图被求值之前**加载。
 *    `queue.module.ts` 的 `BullModule.forRoot` 参数是在**模块装饰器求值时**
 *    （即 import 的那一刻）读 `process.env.REDIS_URL` 的 —— 那时 `.env` 若还没
 *    加载，`REDIS_URL` 就是 undefined → 落到不带密码的 fallback →
 *    本机 Redis 开了 `requirepass` → `NOAUTH HELLO ...`。
 *
 * ⚠️ **不能把调用写进 `bootstrap()`**：TypeScript 编译成 CommonJS 后，
 *    `require` 的顺序 = **`import` 语句的文本顺序**。`bootstrap()` 是函数体，
 *    它跑在**所有 import 之后**，那时 `AppModule` 早就求值完了 →
 *    `BullModule.forRoot` 早就把 fallback 值定死了 → 补救来不及。
 *    唯一能保证顺序的做法是**一个副作用 import 排在 `main.ts` 的第一条**。
 *
 * ⚠️ **本文件与 `common/config/load-env.ts` 的分工**：后者是**库**
 *    （导出函数，调用方才决定何时加载）；本文件是**副作用入口**
 *    （import 即执行）。两者刻意不合并 —— 合并会让「库」在被 import 的
 *    那一刻就执行副作用，反而更难推理调用顺序。
 *
 * ⚠️ **不覆盖已存在的环境变量**：`process.loadEnvFile` 的语义与 dotenv 一致，
 *    容器里注入的变量优先级更高，不会被 `.env` 里的旧值盖掉。
 */
loadEnvFile();
