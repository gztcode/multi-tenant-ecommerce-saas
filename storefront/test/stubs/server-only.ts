/**
 * `server-only` 的空替身。
 *
 * 真正的 server-only 是个只有 Next.js 编译器认识标记模块，
 * 在 node 环境（Vitest）里 import 会直接抛错。
 * 在 vitest.config.ts 里把它 alias 到这个空模块兜底。
 */
export {};
