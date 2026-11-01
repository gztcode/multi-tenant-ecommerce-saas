# `common/payment/` —— 出款渠道与核实的下沉区

⚠️ **这是 `api/src/common/` 下唯一持有 `@Module` 的目录** —— 其余 `common/` 目录
（`tenant/`、`queue/`、`crypto/` 等）都只是纯工具 / 常量 / 装饰器。
**这不是疏忽，是一次有意识的取舍。** 下面写清楚「为什么」，
免得下一个人把它「整理」回 `modules/payment/` → 启动直接报错。

---

## 一、这个目录为什么存在

### 1.1 要解决的问题

`billing` 模块的 `PayoutService.unstick`（商家申请解卡重打）需要做一道
**「渠道核实闸」**：钱到底打出去没有？只有渠道**明确说没打**，才允许解卡重打。

核实需要两样东西：

- **出款渠道表**（`Map<渠道名, provider>`）—— 用来实时问渠道
- **核实服务**（三层核实）—— 复用同一套结论，不各写一遍

这两样东西的自然住所是 `modules/payment/`。

### 1.2 为什么不能直接放在 `modules/payment/`

**因为 `billing` 绝对不能 import `payment`。**

```
order → billing → payment → order
```

`payment` 模块已经 import 了 `order` 相关的东西，`billing` 又 import 了 `order`；
若 `billing` 再 import `payment`，就成环 —— **NestJS 启动时直接报错**
（见 `api/src/modules/billing/billing.module.ts` 顶部的模块注释）。

### 1.3 下沉到 `common/` 怎么解决

把**契约与实现一起**下沉到 `common/payment/`，放进一个 `@Global()` 模块
（`payout-providers.module.ts`）：

```
common/payment/payout-providers.module.ts（@Global）
  ├─ FakePayoutProvider（本地假网关）
  ├─ PAYOUT_PROVIDERS（出款渠道表）
  ├─ PayoutVerificationService（三层核实实现）
  └─ PAYOUT_VERIFICATION（契约 token → 指向上面的实现）
       ↓ 全局可见，任何模块都能注入
  billing/PayoutService、payment/PayoutWorker
```

**关键点：`@Global()` 模块不产生模块依赖边。**
`billing` 只是 `@Inject(PAYOUT_VERIFICATION)` 拿到一个 token，
**既没有 import `payment`，也没有 import `common/payment`** ——
依赖图上多了一条边（`app → PayoutProvidersModule`），
而 `billing ⇄ payment` 之间仍然没有边 → 环被绕开了。

### 1.4 为什么契约与实现要一起下沉（而不是只下沉契约）

只下沉契约的话，**实现**（`PayoutVerificationService`）还得住在 `modules/payment/` ——
而 `@Global()` 模块必须**自己 `providers` 里注册**实现
（`useExisting: PayoutVerificationService`），否则全局模块导出的是一个没实现的 token。

要注册实现，实现就必须在 `common/payment/` 里。

**所以：契约（`payout-verification.ts`）+ 实现（`payout-verification.service.ts`）
+ 渠道表（`payout.constants.ts`）+ 渠道抽象（`payout-provider.interface.ts`）
必须同处一室。** 这不是「顺手把实现也搬来了」，而是**没得选**。

---

## 二、这个目录里各文件分别是什么

| 文件 | 是什么 | 谁在用 |
| --- | --- | --- |
| `payout-provider.interface.ts` | **出款渠道的抽象**：`PayoutProvider`（`execute` / `queryPayout` / `listPayouts`）、`PayoutExecuteInput`、`PayoutExecuteResult`、`ChannelPayoutRecord` | `modules/payment`（打款）、`modules/payment`（对账引擎）、本目录内的实现 |
| `payout.constants.ts` | **出款渠道表的注入令牌** `PAYOUT_PROVIDERS` 与类型 `PayoutProviderMap` | `payout-providers.module.ts`（注册）、`modules/payment/payout.worker.ts`（打款）、本目录的核实服务 |
| `payout-verification.ts` | **核实的纯契约**：`PayoutVerificationTarget` / `PayoutVerificationVerdict` / `PayoutVerification` 接口 + 注入令牌 `PAYOUT_VERIFICATION` | `billing`（按 token 注入）、`payout-providers.module.ts`（绑定实现） |
| `payout-verification.service.ts` | **三层核实的实现**（阶段 5m 设计 §六·6.3） | `payout-providers.module.ts`（注册） |
| `payout-providers.module.ts` | **全局模块**：`@Global()`，把渠道表与核实服务注册并导出 | `modules/payment/payment.module.ts` 导入一次 |
| `fake-payout.provider.ts` | **本地假出款网关**（阶段 5h-2）：进程内计数器模拟失败，如实记录每次尝试 | `payout-providers.module.ts` |
| `fake-payout.provider.spec.ts` | 假网关的单元测试 | — |
| `payout-verification.service.spec.ts` | 核实服务的单元测试（三档结论各一条 + 白名单 + 排序键） | — |

---

## 三、⚠️ 改动这个目录时的注意事项

1. **别把它搬回 `modules/payment/`** —— 会成模块环，NestJS 启动报错。
2. **别在 `billing` 里 import `modules/payment`** —— 同上。
3. **核实闸与打款 worker 必须查同一个渠道** ——
   核实服务的 `pickProvider`（取第一个）与
   `modules/payment/payout.worker.ts` 的 `firstProvider`（取第一个）
   **必须一起改**。两者若一个改了另一个没改 →
   「钱打到 A 渠道、核实查 B 渠道」→ 核实问出「没打」→ **重复打款**。
4. **`PAYOUT_PROVIDERS` 只从 `common/payment/payout.constants` 导出** ——
   `modules/payment/payment.constants.ts` 里**不做 re-export**
   （同一个 token 从两处导出会让人分不清「它到底住在哪」）。
