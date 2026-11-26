# 阶段 5j「资金安全与账务闭环」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把收款账户与出款单快照改成密文存储，并让「结算单缺笔」在平台端与商家端都看得见。

**Architecture:** 三层改动。① 底层加一个通用的字段加密工具（`common/crypto/`）与一把独立密钥；② `merchant_payout_accounts.accountNo` 与 `payouts.snapshotAccountNo` 改名成 `...Cipher` 并存密文，另加掩码串列（展示不解密）与版本列（幂等判定）；③ 账务侧加「缺笔」检测：平台端列表/详情给出缺笔数与修账指引，商家端对账单给出中立提示。

**Tech Stack:** NestJS 11、Prisma 6、PostgreSQL 16、node:crypto（AES-256-GCM + HKDF-SHA256）、Vitest、Jest、Next.js 15（merchant-admin / platform-admin）。

---

## 零、动手前必须知道的事

### 0.1 本项目的铁律（违反会被 review 打回）

1. **`api/src/modules/billing/` 绝对不能 import `api/src/modules/payment/`** —— 会造成 `order → billing → payment → order` 的循环依赖。
   ⚠️ 注意 `api/src/modules/payment/payout.worker.ts` 在 payment 模块，但
   `api/src/modules/billing/payout-execution.service.ts` 在 billing 模块 —— 解密放**后者**。
2. **`tenantContext.run(...)` 的回调必须是 `async` 函数** —— Prisma 6 的 PrismaPromise 是
   thenable 而非原生 Promise，同步回调会让 AsyncLocalStorage 上下文在查询执行时丢失 →
   **租户隔离静默失效**（不抛错）。
3. **租户作用域白名单**（`api/src/common/tenant/tenant-models.ts`）：
   `CommissionEntry` / `SettlementStatement` / `MerchantReceipt` / `Payout` **在**白名单；
   `SettlementStatementEntry` / `PayoutEntry` **刻意不在**（没有 tenantId 字段）→
   查它们必须「先查该租户的父单，再用 id 列表关联」。
4. **eslint 有 `require-await` 规则** —— `async` 函数里没有 `await` 会报错；纯函数不要写 `async`。
5. **金额一律整数分**；界面用「元」，换算只在展示层做
   （前端用 `merchant-admin/src/lib/money.ts` 的 `centsToYuan`）。
6. **注释、测试名一律简体中文**；代码标识符、报错原文保持英文。
7. **外科手术式改动** —— 只碰本计划点名的文件与行，不顺手重构、不清理历史死代码。

### 0.2 本机环境

- 端口：postgres **15432**、redis **16380**、minio **19000**、api **3000**、
  storefront 3001、merchant-admin **3002**、platform-admin **3003**。
- 容器：`cd infra && docker compose up -d --build api merchant-admin`。
- ⚠️ **本机 GitHub 443 不可达** → 推送走 `tools/push-via-api.mjs`（见 Task 8）。
- ⚠️ **`prisma migrate dev` 当前不可用**（5e-5 遗留：四个历史迁移 checksum 不一致，
  要求 reset 会清库）→ **迁移 SQL 手写**，用 `prisma migrate diff` 核对。

### 0.3 设计与计划的对照

设计文档：`docs/superpowers/specs/2026-10-30-plan-05j-fund-security-ledger-closure-design.md`

⚠️ 设计文档 §七 记录了独立审查抓出的 8 处设计错误 —— **实施前先读那一节**，
不要按「直觉」实现（比如「解密失败返回 null」「靠能不能解密判幂等」都是错的）。

### 0.4 贯穿全程的一个纪律

**失败注入必须独占。** 注入期间源文件被改，与全量 e2e 并发跑会互相污染
（5i 实测：并发时全量 e2e 出现 16 条误报挂，害我差点把回归当成回归）。
→ 跑注入时**不要同时跑任何其他测试**。

---

### Task 1: 字段加密工具与账目密钥

**Files:**
- Create: `api/src/common/crypto/field-cipher.ts`
- Create: `api/src/common/crypto/field-cipher.spec.ts`
- Create: `api/src/common/config/assert-payout-encryption-key.ts`
- Create: `api/src/common/config/assert-payout-encryption-key.spec.ts`
- Modify: `api/src/main.ts`
- Modify: `api/.env.example`
- Modify: `infra/docker-compose.yml`

- [ ] **Step 1: 写字段加密工具的失败测试**

创建 `api/src/common/crypto/field-cipher.spec.ts`：

```ts
import {
  decryptField,
  deriveFieldKey,
  encryptField,
} from './field-cipher';

describe('字段加密工具', () => {
  const secret = 'a'.repeat(48);

  it('加密后能解回原文', () => {
    const key = deriveFieldKey(secret);
    const cipher = encryptField('6225880000001234', key);
    expect(decryptField(cipher, key)).toBe('6225880000001234');
  });

  it('⚠️ 同一明文两次加密的密文不同（随机 iv）', () => {
    const key = deriveFieldKey(secret);
    expect(encryptField('x', key)).not.toBe(encryptField('x', key));
  });

  it('⚠️ 密文被篡改 → 解密抛错（绝不返回 null）', () => {
    const key = deriveFieldKey(secret);
    const cipher = encryptField('hello', key);
    const raw = Buffer.from(cipher, 'base64url');
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptField(raw.toString('base64url'), key)).toThrow();
  });

  it('⚠️ 密钥不对 → 解密抛错', () => {
    const cipher = encryptField('hello', deriveFieldKey(secret));
    expect(() =>
      decryptField(cipher, deriveFieldKey('b'.repeat(48))),
    ).toThrow();
  });

  it('⚠️ 密文长度不足 → 抛错', () => {
    expect(() =>
      decryptField('AAAA', deriveFieldKey(secret)),
    ).toThrow();
  });

  it('⚠️ 不同用途派生出的密钥不同（info 隔离）', () => {
    const key = deriveFieldKey(secret);
    const cipher = encryptField('hello', key);
    // 用别的 secret 派生 → 必须解不开
    expect(() => decryptField(cipher, deriveFieldKey('c'.repeat(48)))).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd api && npx jest src/common/crypto/field-cipher.spec.ts
```
Expected: FAIL —— `Cannot find module './field-cipher'`

- [ ] **Step 3: 实现字段加密工具**

创建 `api/src/common/crypto/field-cipher.ts`：

```ts
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * 通用字段加密（阶段 5j）。
 *
 * ⚠️ **格式与 `modules/auth/token.util.ts` 的 `encryptToken` 同款**：
 *    `base64url( iv(12) || authTag(16) || ciphertext )`，AES-256-GCM。
 *    同款是为了让全仓只有一种密文形状，读起来不用切换心智模型。
 *
 * ⚠️ **但失败语义相反 —— 这是刻意的**：
 *    `decryptToken` 失败返回 `null`（令牌本来就可能失效，调用方走「重新登录」）；
 *    **账目密文解密失败是异常**（密文损坏 / 密钥配错 / 数据没迁移），
 *    必须响亮地失败 —— 静默返回空值会让打款带着空账号去渠道，
 *    **钱打不出去且没人知道为什么**。
 */

/** 派生密钥的长度（AES-256 要 32 字节） */
const FIELD_KEY_BYTES = 32;

/** 加密 iv 的长度（GCM 推荐 12 字节） */
const FIELD_IV_BYTES = 12;

/** GCM 认证标签的长度 */
const FIELD_TAG_BYTES = 16;

/** HKDF 的 salt：与 info 一起把密钥的用途区分开 */
const FIELD_HKDF_SALT = 'multi-tenant-ecommerce-saas';

/**
 * HKDF 的 info：标识这把密钥的用途，换用途就要换 info。
 *
 * ⚠️ **不能与 `token.util.ts` 的 `refresh-token-grace-v1` 相同**：
 *    相同的话两处密文可以互相冒充。
 */
const FIELD_HKDF_INFO = 'payout-account-encryption-v1';

/**
 * 从环境变量里的密钥派生 AES 密钥。
 *
 * ⚠️ **派生而不是直接用**：环境变量是任意长度的字符串，
 *    AES-256 要正好 32 字节。
 */
export function deriveFieldKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(FIELD_HKDF_SALT, 'utf8'),
      Buffer.from(FIELD_HKDF_INFO, 'utf8'),
      FIELD_KEY_BYTES,
    ),
  );
}

/**
 * 加密一个字段，返回可落库的密文。
 *
 * ⚠️ **每次用随机 iv** —— 同一个明文加密两次的密文必须不同，
 * 否则「密文相同 ⇒ 明文相同」就成了可用的判据。
 */
export function encryptField(plaintext: string, key: Buffer): string {
  const iv = randomBytes(FIELD_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    'base64url',
  );
}

/**
 * 解密一个字段。
 *
 * ⚠️ **失败一律抛错，绝不返回 null** —— 见文件头的说明。
 */
export function decryptField(ciphertext: string, key: Buffer): string {
  const raw = Buffer.from(ciphertext, 'base64url');
  if (raw.length < FIELD_IV_BYTES + FIELD_TAG_BYTES) {
    throw new Error('密文格式不对：长度不足');
  }
  const iv = raw.subarray(0, FIELD_IV_BYTES);
  const tag = raw.subarray(
    FIELD_IV_BYTES,
    FIELD_IV_BYTES + FIELD_TAG_BYTES,
  );
  const body = raw.subarray(FIELD_IV_BYTES + FIELD_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString(
    'utf8',
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd api && npx jest src/common/crypto/field-cipher.spec.ts
```
Expected: PASS —— 6 passed

- [ ] **Step 5: 写账目密钥校验的失败测试**

创建 `api/src/common/config/assert-payout-encryption-key.spec.ts`：

```ts
import { assertPayoutEncryptionKey } from './assert-payout-encryption-key';

describe('账目加密密钥的启动校验', () => {
  const original = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = original;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('⚠️ 缺失 → 抛错', () => {
    delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    expect(() => assertPayoutEncryptionKey()).toThrow(
      /PAYOUT_ACCOUNT_ENCRYPTION_KEY/,
    );
  });

  it('⚠️ 长度不足 32 → 抛错（任何环境）', () => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = 'short';
    process.env.NODE_ENV = 'development';
    expect(() => assertPayoutEncryptionKey()).toThrow(/32/);
  });

  it('⚠️ 生产环境用占位符 → 抛错', () => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY =
      'change-me-in-production-at-least-32-chars-long';
    process.env.NODE_ENV = 'production';
    expect(() => assertPayoutEncryptionKey()).toThrow(/占位符/);
  });

  it('⚠️ 开发环境用占位符 → 放行（与 JWT_SECRET 同款）', () => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY =
      'change-me-in-production-at-least-32-chars-long';
    process.env.NODE_ENV = 'development';
    expect(() => assertPayoutEncryptionKey()).not.toThrow();
  });

  it('长度够且不是占位符 → 放行', () => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = 'k'.repeat(48);
    expect(() => assertPayoutEncryptionKey()).not.toThrow();
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
cd api && npx jest src/common/config/assert-payout-encryption-key.spec.ts
```
Expected: FAIL —— `Cannot find module './assert-payout-encryption-key'`

- [ ] **Step 7: 实现账目密钥校验**

创建 `api/src/common/config/assert-payout-encryption-key.ts`：

```ts
/**
 * 账目加密密钥的启动校验（阶段 5j）。
 *
 * ⚠️ **独立成一个函数，不塞进 `assertSecureConfig()`** ——
 *    那个是 5h-2 已验收的启动校验，牵连它不划算；
 *    而且「账目密钥」与「令牌密钥」的失败理由、排查方式都不同。
 *
 * ⚠️ **规则逐条照抄 `JWT_SECRET`**：
 *    长度不足任何环境都失败；占位符只在 production 失败。
 */
const PLACEHOLDER_KEY = 'change-me-in-production-payout-key-at-least-32-chars-long';

export function assertPayoutEncryptionKey(): void {
  const secret = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY ?? '';

  if (secret.length < 32) {
    throw new Error(
      `PAYOUT_ACCOUNT_ENCRYPTION_KEY 至少需要 32 个字符，当前只有 ${secret.length} 个。` +
        '请设置一个足够随机的密钥（可用 `openssl rand -base64 48` 生成）。' +
        '⚠️ 这个密钥轮换后，已打款的出款单快照将永久解不开。',
    );
  }

  if (process.env.NODE_ENV === 'production' && secret === PLACEHOLDER_KEY) {
    throw new Error(
      '生产环境禁止使用 .env.example 里的 PAYOUT_ACCOUNT_ENCRYPTION_KEY 占位符，' +
        '请换成真实密钥。',
    );
  }
}
```

- [ ] **Step 8: 接进启动流程与两处配置**

修改 `api/src/main.ts`（在 `assertSecureConfig()` 调用之后）：

```ts
import { assertPayoutEncryptionKey } from './common/config/assert-payout-encryption-key';
```

```ts
  // 在创建 Nest 应用之前校验 JWT_SECRET：
  // 配置不安全时进程必须立刻退出，不能先监听端口再失败。
  assertSecureConfig();
  // ⚠️ **账目加密密钥同样要在建应用前校验**：
  //    缺了它，出款执行时会解不开快照 → 钱打不出去。
  assertPayoutEncryptionKey();
```

修改 `api/.env.example`（在 `JWT_SECRET` 那行下面加）：

```
# 收款账户与出款单快照的字段加密密钥（≥ 32 字符）。
# ⚠️ 生产环境禁止用这个占位符；轮换后已打款的快照将永久解不开。
# ⚠️ 必须与 JWT_SECRET 的占位符**不同值**：两个校验都是等值比较，
#    相同的话将来把 JWT_SECRET 换成真实值时，账目密钥的占位符检查就失去意义。
PAYOUT_ACCOUNT_ENCRYPTION_KEY="change-me-in-production-payout-key-at-least-32-chars-long"
```

⚠️ `assert-payout-encryption-key.ts` 里的 `PLACEHOLDER_KEY` 常量
**必须与上面这个值逐字一致** —— 实施时把两处一起改，别只改一处。

修改 `infra/docker-compose.yml`（api 服务的 environment 段，`JWT_SECRET` 附近）：

```yaml
      # 收款账户与出款单快照的字段加密密钥。
      # ⚠️ 必须是**固定值**：每次 up 都换密钥的话，
      # 之前签发的出款单快照就全解不开了（与 JWT_SECRET 同款理由）。
      PAYOUT_ACCOUNT_ENCRYPTION_KEY: local-dev-only-payout-encryption-key-at-least-32-chars
```

- [ ] **Step 9: 跑验证**

```bash
cd api && npx jest src/common/crypto src/common/config
cd api && npx tsc --noEmit
cd api && npm run lint
```
Expected: 全部通过，无告警

- [ ] **Step 10: 提交**

```bash
git add api/src/common/crypto api/src/common/config/assert-payout-encryption-key.ts \
        api/src/common/config/assert-payout-encryption-key.spec.ts api/src/main.ts \
        api/.env.example infra/docker-compose.yml
git commit -m "feat(crypto): 字段加密工具与账目密钥——收款账号不再明文落库的起点"
```

---

### Task 2: schema 改动与两张表的加密改造

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/20261030120000_encrypt_payout_accounts/migration.sql`
- Create: `api/src/modules/billing/payout-cipher.service.ts`
- Modify: `api/src/modules/billing/payout-account.service.ts`
- Modify: `api/src/modules/billing/payout-account.service.spec.ts`
- Modify: `api/src/modules/billing/payout.service.ts`
- Modify: `api/src/modules/billing/payout-execution.service.ts`
- Modify: `api/src/modules/billing/payout.service.spec.ts`
- Modify: `api/src/modules/billing/payout-execution.service.spec.ts`
- Modify: `api/src/modules/billing/billing.module.ts`

⚠️ **这一整个 Task 必须一次做完**：schema 改名后所有引用旧列名的代码都编译不过，
拆开会产生「一半密文一半明文」的中间状态。

- [ ] **Step 1: 改 schema**

修改 `api/prisma/schema.prisma` 的 `MerchantPayoutAccount` 模型：

```prisma
model MerchantPayoutAccount {
  id     String @id @default(uuid())
  tenantId String @unique
  accountName String
  bankName String
  /// 银行账号的**密文**（AES-256-GCM，base64url）。
  /// ⚠️ 列名带 Cipher 后缀是为了自解释 —— 保留 `accountNo` 却让它存密文，
  ///    只靠注释说明，下一个读代码的人容易误解。
  /// ⚠️ 展示用的掩码串在 `maskedAccountNo`；展示路径**不解密**。
  accountNoCipher String
  /// 脱敏后的账号（只留尾 4 位）。
  /// ⚠️ 必须单独存：密文长度 ≠ 明文长度，而掩码要按明文长度打星
  ///    → 不解密就还原不出掩码。
  /// ⚠️ 会泄露账号长度，但**现状 API 返回的就是掩码串**，不是新增泄露面。
  maskedAccountNo String
  /// 加密版本：0 = 尚未加密，1 = 已加密。
  /// ⚠️ 这是「这行加密过没有」的**权威依据** —— 不能靠「能不能解密」猜：
  ///    密钥配错时「解不开」会被误判成「没加密」，
  ///    迁移脚本就会用错密钥把原文覆盖掉，且不可恢复。
  encryptionVersion Int @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("merchant_payout_accounts")
}
```

修改 `Payout` 模型的三个快照列：

```prisma
  /// 审批那一刻的收款账户快照。
  /// ⚠️ **账号是密文**（`...Cipher`）；户名与开户行**有意保持明文** ——
  ///    账号是唯一能直接用于资金转移的字段，户名与开户行是卡面上就印着的公开信息。
  ///    理由见 5j 设计 §2.7。
  snapshotAccountName String?
  snapshotBankName String?
  /// 银行账号的**密文**（打款时由 worker 解密）。
  snapshotAccountNoCipher String?
  /// 脱敏后的账号（展示用，不解密）。
  snapshotMaskedAccountNo String?
  /// 快照的加密版本（0 = 尚未加密，1 = 已加密）。
  snapshotEncryptionVersion Int @default(0)
```

⚠️ **户名 / 开户行「有意保持明文」这句话必须留在 schema 注释里**（设计 §2.7）——
否则下一个读代码的人会以为漏做了，进而「顺手补上」把设计改乱。

- [ ] **Step 2: 写迁移 SQL 并核对**

创建 `api/prisma/migrations/20261030120000_encrypt_payout_accounts/migration.sql`：

```sql
-- 阶段 5j：收款账户与出款单快照的字段加密。
--
-- ⚠️ **本迁移不做数据加密** —— 密文要用应用层的密钥算，
--    SQL 层做不了 AES-GCM（需要随机 iv 与认证标签）。
--    数据加密由 `npm run migrate:payout-encryption` 负责（Task 3）。
--
-- ⚠️ **改名而不是删列**：老代码读旧列名会立刻报「列不存在」，
--    不会静默读错 —— 停机窗口内不会出现「新旧代码同时跑」的危险状态。

ALTER TABLE "merchant_payout_accounts"
  RENAME COLUMN "accountNo" TO "accountNoCipher";

ALTER TABLE "merchant_payout_accounts"
  ADD COLUMN "maskedAccountNo" TEXT NOT NULL DEFAULT '';

ALTER TABLE "merchant_payout_accounts"
  ADD COLUMN "encryptionVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "payouts"
  RENAME COLUMN "snapshotAccountNo" TO "snapshotAccountNoCipher";

ALTER TABLE "payouts"
  ADD COLUMN "snapshotMaskedAccountNo" TEXT;

ALTER TABLE "payouts"
  ADD COLUMN "snapshotEncryptionVersion" INTEGER NOT NULL DEFAULT 0;
```

核对 schema 与迁移一致：

```bash
cd api && npx prisma migrate diff \
  --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://ecommerce:ecommerce@localhost:15432/ecommerce_shadow?schema=public" \
  --exit-code
```
Expected: 退出码 0（无差异）。若报差异，按差异调整 SQL。
⚠️ **shadow 库要先建**：
```bash
docker exec ecommerce-postgres psql -U ecommerce -d postgres -c "CREATE DATABASE ecommerce_shadow;"
```

- [ ] **Step 3: 建账目加密服务（唯一持有明文的入口）**

创建 `api/src/modules/billing/payout-cipher.service.ts`：

```ts
import { Injectable } from '@nestjs/common';

import {
  decryptField,
  deriveFieldKey,
  encryptField,
} from '../../common/crypto/field-cipher';

/**
 * 收款账户的字段加密（阶段 5j）。
 *
 * ⚠️ **这是全仓唯一能拿到「完整明文账号」的服务** ——
 *    展示路径一律用预存的掩码串（不解密），打款路径才解密。
 *    「唯一」靠纪律与 review 保证，不是靠类型系统（TS 拦不住调用方）。
 *
 * ⚠️ **密钥只在进程内存里**，不落盘、不进日志、不进 API 响应。
 */
@Injectable()
export class PayoutCipherService {
  private readonly key: Buffer;

  constructor() {
    const secret = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY ?? '';
    // ⚠️ **启动时已经校验过**（`assertPayoutEncryptionKey`），
    //    这里再兜一层：万一这个服务被别的上下文单独 new 出来，
    //    不能拿着空密钥继续跑。
    if (secret.length < 32) {
      throw new Error('PAYOUT_ACCOUNT_ENCRYPTION_KEY 未配置或长度不足 32 个字符');
    }
    this.key = deriveFieldKey(secret);
  }

  /** 明文 → 密文 */
  encrypt(plaintext: string): string {
    return encryptField(plaintext, this.key);
  }

  /**
   * 密文 → 明文。
   *
   * ⚠️ **失败一律抛错**（底层 `decryptField` 的语义），绝不返回空串。
   */
  decrypt(ciphertext: string): string {
    return decryptField(ciphertext, this.key);
  }

  /**
   * 读一行密文 → 明文，**并检查版本号**。
   *
   * ⚠️ **版本号不对就抛错，绝不按明文兜底** ——
   *    「忘了迁移」若被静默当成「就是明文」，就等于把加密悄悄关掉了。
   *
   * @param version 该行的加密版本（0 = 尚未加密）
   * @param what    出错文案里指明是哪张表的哪一列
   */
  decryptVersioned(ciphertext: string, version: number, what: string): string {
    if (version !== 1) {
      throw new Error(
        `${what} 尚未加密（版本 ${version}），` +
          '请先执行 `npm run migrate:payout-encryption` 再重试。',
      );
    }
    return this.decrypt(ciphertext);
  }
}
```

- [ ] **Step 4: 写账户表加密的失败测试**

修改 `api/src/modules/billing/payout-account.service.spec.ts`：
把 mock 的 Prisma 与期望改成密文形态。**先看现有文件**再改，要点：

- mock 的 `merchantPayoutAccount.create` 收到的 `data` 里，`accountNoCipher` 必须是密文、
  `accountNo` 字段**不存在**、`maskedAccountNo` 是掩码串、`encryptionVersion` 是 1。
- 新增一条：「⚠️ 库里的账号是密文，但 API 只返回掩码串」——
  断言返回值的 `maskedAccountNo` 等于 `maskAccountNo(明文)`。

- [ ] **Step 5: 跑测试确认失败**

```bash
cd api && npx jest src/modules/billing/payout-account.service.spec.ts
```
Expected: FAIL（期望的 `accountNoCipher` 字段不存在）

- [ ] **Step 6: 改造 `payout-account.service.ts`**

改 `PayoutAccountService`：

```ts
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';

import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { PayoutCipherService } from './payout-cipher.service';
```

构造函数加依赖：

```ts
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly cipher: PayoutCipherService,
  ) {}
```

`set()` 方法里，把 `data` 改成加密形态：

```ts
    if (existing) {
      const updated = await this.prisma.merchantPayoutAccount.updateMany({
        where: { id: existing.id },
        data: {
          accountName: input.accountName,
          bankName: input.bankName,
          // ⚠️ **`accountNo` 为空时不带这个键**：
          //    Prisma 的 `undefined` = 不更新该字段 → 保留原账号。
          //    写成空串会把账号**清掉** —— 钱就不知道打给谁了。
          ...(accountNo
            ? {
                accountNoCipher: this.cipher.encrypt(accountNo),
                maskedAccountNo: maskAccountNo(accountNo),
                encryptionVersion: 1,
              }
            : {}),
        },
      });
```

`create` 处：

```ts
    const created = await this.prisma.merchantPayoutAccount.create({
      data: {
        tenantId,
        accountName: input.accountName,
        bankName: input.bankName,
        // ⚠️ **账号落库即密文** —— 库里不该再有完整账号的明文副本。
        accountNoCipher: this.cipher.encrypt(accountNo),
        // ⚠️ **掩码串单独存**：密文长度 ≠ 明文长度，
        //    而掩码要按明文长度打星 → 不解密就还原不出掩码。
        maskedAccountNo: maskAccountNo(accountNo),
        encryptionVersion: 1,
      },
    });
```

`toView()` 改成读掩码列（**不解密**）：

```ts
  private toView(account: {
    accountName: string;
    bankName: string;
    maskedAccountNo: string;
    updatedAt: Date;
  }): PayoutAccountView {
    return {
      accountName: account.accountName,
      bankName: account.bankName,
      // ⚠️ **直接用库里存的掩码串，不解密** ——
      //    展示路径一旦解密，X14（响应永不含完整账号）就有洞了。
      maskedAccountNo: account.maskedAccountNo,
      updatedAt: account.updatedAt.toISOString(),
    };
  }
```

- [ ] **Step 7: 改 `payout.service.ts` 的快照写入与视图**

apply 处（约 314 行）：

```ts
              // ⚠️ **申请时也抄一份账户**（审批时会覆盖成审批那一刻的值）
              snapshotAccountName: account.accountName,
              snapshotBankName: account.bankName,
              // ⚠️ **复制的是账户行里那份密文本身，不是重新加密**：
              //    重新加密会得到不同的密文（随机 iv），
              //    而「快照 = 审批那一刻的那一份」要求复制同一份密文。
              snapshotAccountNoCipher: account.accountNoCipher,
              snapshotMaskedAccountNo: account.maskedAccountNo,
              // ⚠️ **版本号必须跟着密文一起复制** ——
              //    否则会出现「密文是新的、版本号是 0」的错配。
              snapshotEncryptionVersion: account.encryptionVersion,
```

approve 处（约 504 行）：同样三行，照抄 apply 的写法。

`toView()` 里（约 1220 行）：

```ts
      // ⚠️ **脱敏** —— 快照里的账号是完整账号，是打款的依据，
      //    但**绝不能**出现在 API 响应里（护栏 X14）。
      //    这里读的是**预存的掩码串**，不解密。
      maskedSnapshotAccountNo: payout.snapshotMaskedAccountNo ?? null,
```

- [ ] **Step 8: 改 `payout-execution.service.ts` 的解密**

`claimForExecution` 的 select 与组装：

```ts
          select: {
            attemptCount: true,
            netAmount: true,
            payoutNo: true,
            snapshotAccountName: true,
            snapshotBankName: true,
            snapshotAccountNoCipher: true,
            snapshotMaskedAccountNo: true,
            snapshotEncryptionVersion: true,
          },
```

组装处：

```ts
        return {
          attemptCount: payout.attemptCount,
          netAmount: payout.netAmount,
          payoutNo: payout.payoutNo,
          // ⚠️ **这里是全仓唯一给渠道明文账号的地方**。
          //    快照的版本号不对（没迁移）→ 直接抛错，
          //    不能拿明文兜底（那等于把加密悄悄关掉）。
          account: payout.snapshotAccountNoCipher
            ? {
                accountName: payout.snapshotAccountName ?? '',
                bankName: payout.snapshotBankName ?? '',
                accountNo: this.cipher.decryptVersioned(
                  payout.snapshotAccountNoCipher,
                  payout.snapshotEncryptionVersion,
                  '出款单的收款账号快照',
                ),
              }
            : null,
        };
```

构造函数注入 `PayoutCipherService`。

- [ ] **Step 9: 注册 provider**

修改 `api/src/modules/billing/billing.module.ts` 的 `providers` 数组，加
`PayoutCipherService`（**并加进 `exports`**，若该模块的服务需要被别的模块用；
本阶段只有本模块用，但 worker 在 payment 模块是通过 `PayoutExecutionService` 间接拿到的，
所以 `PayoutCipherService` **不需要**导出 —— 保持最小面）。

- [ ] **Step 10: 跑验证**

```bash
cd api && npx jest src/modules/billing
cd api && npx tsc --noEmit
cd api && npm run lint
```
Expected: 全部通过

⚠️ `payout.service.spec.ts` 与 `payout-execution.service.spec.ts` 里断言**明文**
的地方要改（如 `expect(data.snapshotAccountNo).toBe('6222000000000000')`
→ 改成断言 `snapshotAccountNoCipher` 是密文、`snapshotMaskedAccountNo` 是掩码串）。
⚠️ **断言明文的地方不能直接删** —— 要改成「解出来的明文 == 原文」这种**更有力的断言**。

- [ ] **Step 11: 提交**

```bash
git add api/prisma api/src/modules/billing
git commit -m "feat(billing): 收款账户与出款单快照改密文存储——库泄露不再等于账号泄露"
```

---

### Task 3: 存量迁移脚本与未迁移拦截

**Files:**
- Create: `api/scripts/migrate-payout-encryption.ts`
- Modify: `api/package.json`

- [ ] **Step 1: 写迁移脚本**

创建 `api/scripts/migrate-payout-encryption.ts`：

```ts
#!/usr/bin/env ts-node
/**
 * 阶段 5j 的存量数据迁移：把收款账户与出款单快照的明文账号换成密文。
 *
 * 用法：
 *   npm run migrate:payout-encryption            # 干跑，只报告
 *   npm run migrate:payout-encryption -- --force # 真写
 *
 * ⚠️ **幂等判定靠版本列（`encryptionVersion = 0`），不靠「能不能解密」** ——
 *    「解不开」有两种完全不同的原因：还没加密、密钥配错。
 *    用启发式判断的话，密钥配错时会把所有行当成「明文」，
 *    **用错密钥加密并覆盖原文，而原文被覆盖后不可恢复**。
 *    版本号是写在数据里的事实，不依赖密钥。
 *
 * ⚠️ **首次迁移时密钥配错仍无解** —— 库里没有可参照的密文。
 *    所以脚本做三件事降低后果：① 自动建备份表 ② 打印密钥指纹供人工核对
 *    ③ 要求显式 `--force` 才写库。
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

import { deriveFieldKey, decryptField, encryptField } from '../src/common/crypto/field-cipher';
import { maskAccountNo } from '../src/modules/billing/payout-account.service';

const prisma = new PrismaClient();
const force = process.argv.includes('--force');

async function main(): Promise<void> {
  const secret = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY ?? '';
  if (secret.length < 32) {
    throw new Error(
      'PAYOUT_ACCOUNT_ENCRYPTION_KEY 未配置或长度不足 32 个字符 —— ' +
        '请先确认密钥再跑迁移。',
    );
  }
  const key = deriveFieldKey(secret);
  // ⚠️ **打印指纹供人工核对**：核对不上就别加 --force。
  console.log(
    `密钥指纹：${createHash('sha256').update(key).digest('hex').slice(0, 8)}`,
  );

  const accounts = await prisma.merchantPayoutAccount.findMany({
    where: { encryptionVersion: 0 },
  });
  const payouts = await prisma.payout.findMany({
    where: { snapshotEncryptionVersion: 0, snapshotAccountNoCipher: { not: null } },
  });

  console.log(`待迁移：账户 ${accounts.length} 行，出款单快照 ${payouts.length} 行`);
  if (accounts.length === 0 && payouts.length === 0) {
    console.log('无需迁移。');
    return;
  }

  if (!force) {
    console.log('干跑模式。加 --force 才真正写库。');
    console.log('建议：先备份数据库，再执行 `npm run migrate:payout-encryption -- --force`。');
    return;
  }

  // ⚠️ **自动建备份表** —— 迁移出问题可从备份恢复。
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "merchant_payout_accounts_backup_${stamp}" AS SELECT * FROM "merchant_payout_accounts"`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "payouts_backup_${stamp}" AS SELECT * FROM "payouts"`,
  );
  console.log(`已建备份表：*_backup_${stamp}`);

  await prisma.$transaction(async (tx) => {
    for (const account of accounts) {
      // ⚠️ **此刻 `accountNoCipher` 列里装的是明文** ——
      //    schema 改名后数据还在原处，只是列名变了。
      const plain = account.accountNoCipher;
      // ⚠️ **往返自检**：加密 → 解密 → 比对原文。
      //    自检不过就抛错 → 整个事务回滚 → 一行都不会被改坏。
      const cipher = encryptField(plain, key);
      if (decryptField(cipher, key) !== plain) {
        throw new Error('加密往返自检失败，已中止迁移');
      }
      await tx.merchantPayoutAccount.update({
        where: { id: account.id },
        data: {
          accountNoCipher: cipher,
          maskedAccountNo: maskAccountNo(plain),
          encryptionVersion: 1,
        },
      });
    }
    for (const payout of payouts) {
      if (!payout.snapshotAccountNoCipher) continue;
      const plain = payout.snapshotAccountNoCipher;
      const cipher = encryptField(plain, key);
      if (decryptField(cipher, key) !== plain) {
        throw new Error('加密往返自检失败，已中止迁移');
      }
      await tx.payout.update({
        where: { id: payout.id },
        data: {
          snapshotAccountNoCipher: cipher,
          snapshotMaskedAccountNo: maskAccountNo(plain),
          snapshotEncryptionVersion: 1,
        },
      });
    }
  });

  console.log(`迁移完成：账户 ${accounts.length} 行，出款单快照 ${payouts.length} 行`);
}

main()
  .catch((error: unknown) => {
    console.error('迁移失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: 加 npm 脚本**

修改 `api/package.json` 的 `scripts`：

```json
    "migrate:payout-encryption": "ts-node scripts/migrate-payout-encryption.ts",
```

⚠️ **`prisma migrate dev` 不可用**，但 `ts-node` 是现成的（`prisma/seed.ts` 用的是
`ts-node --compiler-options {"module":"CommonJS"}`）→ 照抄那个写法：

```json
    "migrate:payout-encryption": "ts-node --compiler-options {\"module\":\"CommonJS\"} scripts/migrate-payout-encryption.ts",
```

- [ ] **Step 3: 在开发库上试跑**

```bash
cd api && npm run migrate:payout-encryption
```
Expected: 打印密钥指纹 + 待迁移行数 + 「干跑模式」提示，**不改任何数据**

```bash
cd api && npm run migrate:payout-encryption -- --force
```
Expected: 建备份表 → 迁移完成

核对：
```bash
docker exec ecommerce-postgres psql -U ecommerce -d ecommerce -t -c \
  "SELECT count(*) FILTER (WHERE \"encryptionVersion\"=0) AS 未迁账户,
          count(*) FILTER (WHERE \"encryptionVersion\"=1) AS 已迁账户
   FROM merchant_payout_accounts;"
```
Expected: 未迁账户 0

```bash
docker exec ecommerce-postgres psql -U ecommerce -d ecommerce -t -c \
  "SELECT \"snapshotAccountNoCipher\" FROM payouts WHERE \"snapshotAccountNoCipher\" IS NOT NULL LIMIT 1;"
```
Expected: 密文（不是 `6225...` 这样的明文）

- [ ] **Step 4: 跑验证**

```bash
cd api && npx tsc --noEmit && npm run lint
```

- [ ] **Step 5: 提交**

```bash
git add api/scripts/migrate-payout-encryption.ts api/package.json
git commit -m "feat(billing): 存量收款账号的加密迁移脚本——带备份与密钥指纹"
```

---

### Task 4: 后端缺笔检测

**Files:**
- Modify: `api/src/modules/billing/settlement.service.ts`
- Modify: `api/src/modules/billing/ledger.service.ts`
- Modify: `api/src/modules/billing/merchant-statement.service.ts`
- Modify: `api/src/modules/billing/settlement.service.spec.ts`

- [ ] **Step 1: 写缺笔检测的失败测试**

修改 `api/src/modules/billing/settlement.service.spec.ts`，新增一条：

```ts
    it('⚠️ 当期又进了新流水 → 该期缺笔，missingEntryCount > 0', async () => {
      // 造一个已生成的结算单，随后往同一期补一笔抽佣流水
      // → 结算单的 entryCount 与当期真实笔数对不上
      const result = await service.generate(tenantId, period);
      expect(result.missingEntryCount).toBe(0);

      await prisma.commissionEntry.create({
        data: { tenantId, orderNo: 'LATE-1', type: 'COMMISSION', amount: 100, baseAmount: 1000, rateBps: 500, occurredAt: inside(period, 20) },
      });

      const view = await service.detail(result.id);
      expect(view.missingEntryCount).toBe(1);
    });
```

⚠️ **实施时先读现有 spec 的造数方式**，照抄它的风格（`prisma` mock 的形状、
`period` / `inside` 这类 helper 的名字与位置），不要另起炉灶。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd api && npx jest src/modules/billing/settlement.service.spec.ts
```
Expected: FAIL —— `missingEntryCount` 不存在

- [ ] **Step 3: 给 `SettlementView` 加字段并实现检测**

修改 `api/src/modules/billing/settlement.service.ts`：

1. `SettlementView` 接口加：
```ts
  /**
   * 这一期「缺笔」的数量：当期真实流水笔数 − 结算单纳入的笔数。
   *
   * ⚠️ **0 = 不缺笔**。
   * ⚠️ **只比笔数** —— 抽佣流水是 append-only（`commission_entries` 全仓没有
   *    update / upsert），笔数没变 ⇒ 纳入的集合没变 ⇒ 金额也没变。
   *    ⚠️ 若将来流水变得可变（可改金额 / 可改归期），这里必须改成比金额之和。
   */
  missingEntryCount: number;
```

2. 新增私有方法：
```ts
  /**
   * 某一期当期真实的抽佣流水笔数。
   *
   * ⚠️ **按流水自己的 `occurredAt` 归期** —— 不能用账单的 `periodStart` 去筛流水：
   *    流水的归期是 `occurredAt`，账单的周期是 `periodStart`，
   *    两者不是一回事（跨期回填的流水归期在退款期，不在原期）。
   */
  private async actualEntryCount(
    tenantId: string,
    period: MonthlyPeriod,
  ): Promise<number> {
    return this.prisma.commissionEntry.count({
      where: { tenantId, occurredAt: { gte: period.from, lt: period.to } },
    });
  }
```

3. `detail()` 里算 `missingEntryCount` 并塞进视图。
4. `list()` 里**批量**算（见下）。
5. **`SettlementDetailView` 加 `canRecalculate: boolean`**：

```ts
  /**
   * 本期能不能通过「取消确认 → 重算」修正。
   *
   * ⚠️ **取决于有没有出款单引用**（P6 闸）：
   *    有出款单引用时 `unconfirm` 会被 409 拦下 → 只能走调账流程。
   */
  canRecalculate: boolean;
```

   判定条件**必须与 `unconfirm` 里的 P6 闸完全一致** ——
   把那段判定抽成一个私有方法 `hasActivePayoutReference(statementId)`
   （存在 `payouts.statementId = 本单` 且
   `status NOT IN (REJECTED, CANCELLED, FAILED)` 的出款单），
   `unconfirm` 与 `detail` **两处共用**，避免口径漂移。

- [ ] **Step 4: `list()` 的批量查询**

⚠️ **不能用「每行查一次」** —— 那是 N+1（列表最多 200 行 → 多 200 次查询）。
⚠️ **也不能用账单的 `periodStart` 去筛流水** —— 流水的归期是 `occurredAt`。

做法：把本页所有结算单的 `(tenantId, periodStart)` 收集起来 → 取
`min(periodStart)` 到 `max(periodEnd)` 的**区间** → **一次**查出该区间内
所有相关租户的流水 → 在内存里按 `(tenantId, formatPeriodLabel(occurredAt))` 分组计数
→ 与账单的 `(tenantId, periodLabel)` 对应。

⚠️ **区间只是取数的粗筛**（平台端列表可跨多期，周期筛选是可选的），
**归期口径仍然是逐条按 `occurredAt` 算** —— 两者不矛盾。

- [ ] **Step 5: 商家端的缺笔字段**

修改 `api/src/modules/billing/ledger.service.ts`：

1. `PeriodAmounts` 加：
```ts
  /**
   * 当期**真实**的抽佣流水笔数（全部流水，不是结算单纳入的那些）。
   *
   * ⚠️ 与 `commissionEntryCount`（结算单纳入的笔数）的差值 = 缺笔数。
   */
  actualCommissionEntryCount: number;
```

2. `aggregatePeriods` 加**第 ⑧ 步**查询（现有 ①–⑥ 之后）：
```ts
    // ---- ⑧ 当期全部抽佣流水（用于算缺笔）----
    // ⚠️ **按流水自己的 `occurredAt` 取，再按期分组** ——
    //    不能用账单的 periodStart 筛流水（跨期回填的流水归期在退款期）。
    // ⚠️ 第 ④ 步查的是「已被结算单纳入的那些」，这里查的是「当期全部」，
    //    两者相减才是缺笔数。
    const allCommissionEntries = await this.prisma.commissionEntry.findMany({
      where: { tenantId, occurredAt: { gte: from, lt: to } },
      select: { id: true, occurredAt: true },
    });
    const actualCountByPeriod = new Map<string, number>();
    for (const entry of allCommissionEntries) {
      const label = formatPeriodLabel(entry.occurredAt);
      actualCountByPeriod.set(label, (actualCountByPeriod.get(label) ?? 0) + 1);
    }
```
   然后在每期的 `amounts` 里：
```ts
      amounts.actualCommissionEntryCount = actualCountByPeriod.get(label) ?? 0;
```

⚠️ 查询次数从 **6 → 7**，仍固定不随期数增长。

3. 修改 `api/src/modules/billing/merchant-statement.service.ts`：
   - `StatementPeriodView` 加 `missingEntryCount: number;`
   - `toView()` 里算：
```ts
    // ⚠️ **「还没生成结算单」不是「缺笔」** ——
    //    没有结算单时 commissionEntryCount 恒为 0，
    //    直接相减会把「这一期还没结算」误标成「结算单缺笔」。
    //    （与 5i 的口径一致：没有结算单 → commissionAmount 恒为 null，不是 0。）
    const missingEntryCount = amounts.statementId
      ? Math.max(
          0,
          amounts.actualCommissionEntryCount - amounts.commissionEntryCount,
        )
      : 0;
```

- [ ] **Step 6: 跑验证**

```bash
cd api && npx jest src/modules/billing
cd api && npx tsc --noEmit
cd api && npm run lint
```
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add api/src/modules/billing
git commit -m "feat(billing): 缺笔检测——结算单漏纳入的流水在平台端与商家端都看得见"
```

---

### Task 5: 平台端 UI

**Files:**
- Modify: `platform-admin/src/lib/billing.ts`
- Modify: `platform-admin/src/app/(dashboard)/settlements/page.tsx`
- Modify: `platform-admin/src/app/(dashboard)/settlements/[id]/page.tsx`
- Modify: `platform-admin/test/app/settlements-page.test.tsx`（若存在）
- Modify/Create: `platform-admin/test/lib/billing.test.ts`（若不存在）

- [ ] **Step 1: 写失败测试**

在 platform-admin 的测试里加：
- `SettlementStatement` 类型加 `missingEntryCount: number`
- 一条用例：「⚠️ 缺笔的期在列表里标出来」
- 一条用例：「⚠️ 缺笔时详情页给出修账指引」

⚠️ **实施时先看 platform-admin 现有的测试文件与风格**（组件测试基建情况与
merchant-admin 不同），照抄它的写法。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd platform-admin && npx vitest run
```
Expected: FAIL（字段与提示不存在）

- [ ] **Step 3: 改类型与列表页**

`platform-admin/src/lib/billing.ts` 的 `SettlementStatement` 加：
```ts
  /** 缺笔数：当期真实流水笔数 − 结算单纳入的笔数（0 = 不缺笔） */
  missingEntryCount: number;
```

`SettlementDetail` 加（Task 4 的后端已给出这两个字段）：
```ts
  /** 缺笔数（0 = 不缺笔） */
  missingEntryCount: number;
  /** 本期能不能通过「取消确认 → 重算」修正（取决于有没有出款单引用） */
  canRecalculate: boolean;
```

列表页：在「笔数」列后加一列「缺笔」：

```tsx
              <th>缺笔</th>
```
```tsx
                <td>
                  {row.missingEntryCount > 0 ? (
                    <span className="text-destructive">
                      缺 {row.missingEntryCount} 笔
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
```

⚠️ **表头列数要同步改 `colSpan`**（若表里有空态行）。

- [ ] **Step 4: 详情页的修账指引**

`platform-admin/src/app/(dashboard)/settlements/[id]/page.tsx`：
在金额区下方加一条提示：

```tsx
      {detail.missingEntryCount > 0 && (
        <p className="text-sm text-destructive">
          ⚠️ 本期结算单缺 {detail.missingEntryCount} 笔抽佣流水，
          结算单的佣金与当期真实流水对不上。
        </p>
      )}
```

⚠️ **修账指引要分两种情形**（设计 §3.5）：

```tsx
      {detail.missingEntryCount > 0 && (
        <div className="text-sm">
          <p className="text-destructive">
            本期结算单缺 {detail.missingEntryCount} 笔抽佣流水，佣金与当期真实流水对不上。
          </p>
          {/* ⚠️ **能不能修取决于这期有没有出款单引用**：
              有出款单引用时 P6 闸禁止取消确认 → 只能走调账流程。 */}
          {detail.canRecalculate ? (
            <p className="text-muted-foreground">
              本期尚无出款单引用，可先「取消确认」再「重算」，重算会把当期的流水重新纳入。
            </p>
          ) : (
            <p className="text-muted-foreground">
              本期已被出款单引用，不能取消确认；缺笔部分需走调账流程。
            </p>
          )}
        </div>
      )}
```

⚠️ **`canRecalculate` 由 Task 4 的后端给出**（`SettlementDetailView.canRecalculate`），
判定条件与 `unconfirm` 的 P6 闸**共用同一个私有方法** → 口径不会漂移。

- [ ] **Step 5: 跑验证**

```bash
cd platform-admin && npx vitest run
cd platform-admin && npx tsc --noEmit
cd platform-admin && npm run lint
```

- [ ] **Step 6: 提交**

```bash
git add platform-admin
git commit -m "feat(platform-admin): 结算单缺笔可见——列表标出并给出修账指引"
```

---

### Task 6: 商家端 UI

**Files:**
- Modify: `merchant-admin/src/lib/statement.ts`
- Modify: `merchant-admin/src/app/(dashboard)/statements/page.tsx`
- Modify: `merchant-admin/src/app/(dashboard)/statements/[period]/page.tsx`
- Modify: `merchant-admin/test/lib/statement.test.ts`
- Modify: `merchant-admin/test/app/statements-page.test.tsx`
- Modify: `merchant-admin/test/app/statement-detail-page.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `merchant-admin/test/lib/statement.test.ts` 加：

```ts
  it('⚠️ 缺笔 → 给出提示文案', () => {
    expect(describeMissingEntries(2)).toContain('缺 2 笔');
  });

  it('⚠️ 不缺笔 → 不给提示', () => {
    expect(describeMissingEntries(0)).toBeNull();
  });
```

⚠️ **文案要中立、只陈述事实**（设计 §3.4）：
「本期结算单缺 N 笔抽佣流水，佣金以结算单为准」。
**不要**写「平台少扣了您 N 笔佣金」或「佣金待补记」。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd merchant-admin && npx vitest run test/lib/statement.test.ts
```
Expected: FAIL —— `describeMissingEntries` 不存在

- [ ] **Step 3: 实现文案函数与类型**

`merchant-admin/src/lib/statement.ts`：

```ts
/**
 * 缺笔提示的文案。
 *
 * ⚠️ **只陈述事实，不替平台判断谁该补钱** ——
 *    缺 `COMMISSION` 是平台少收，缺 `REVERSAL` 是商家少拿，
 *    方向取决于缺失流水的类型与正负，平台自己也要判断。
 *    所以商家端只说「缺 N 笔，佣金以结算单为准」。
 *
 * @returns 有缺笔时返回提示文案；不缺笔时返回 `null`（不显示）
 */
export function describeMissingEntries(count: number): string | null {
  if (count <= 0) return null;
  return `本期结算单缺 ${count} 笔抽佣流水，佣金以结算单为准`;
}
```

`StatementPeriod` 与 `StatementPeriodDetail` 加 `missingEntryCount: number;`。

- [ ] **Step 4: 列表页与详情页**

列表页：在「结算单状态」单元格下方加提示（小字）。
详情页：在佣金那一行附近加一行提示。

⚠️ **详情页的断言要小心**：页面顶部有「已出款」字样，
`expect(texts).toContain('已出款')` 是**整节点相等**的判定 —— 别用宽泛的
「整页文本包含」写法，那会假通过（5i 踩过）。

- [ ] **Step 5: 跑验证**

```bash
cd merchant-admin && npx vitest run
cd merchant-admin && npx tsc --noEmit
cd merchant-admin && npm run lint
```

- [ ] **Step 6: 提交**

```bash
git add merchant-admin
git commit -m "feat(merchant-admin): 对账单提示结算单缺笔——佣金笔数与流水对不上时看得见"
```

---

### Task 7: e2e 补齐

**Files:**
- Modify: `api/test/payout-execution.e2e-spec.ts`
- Modify: `api/test/ledger-reconciliation.e2e-spec.ts`
- Create: `api/test/payout-encryption.e2e-spec.ts`

- [ ] **Step 1: 现有的账号断言要跟着改**

`api/test/payout-execution.e2e-spec.ts` 约 518 行：
```ts
    expect(received!.account.accountNo).toBe('6225880000000000');
```
⚠️ **这条断言继续成立** —— 假网关收到的仍是**完整明文账号**（worker 解密后传的），
**不要改它**。它恰恰是「解密链路通了」的证据。

要**新增**的断言：
- 库里 `merchant_payout_accounts.accountNoCipher` 是密文（不是 `6225...`）
- 库里 `payouts.snapshotAccountNoCipher` 是密文
- X14 继续守（响应不含完整账号）—— 现有用例继续跑

- [ ] **Step 2: 新建加密 e2e**

创建 `api/test/payout-encryption.e2e-spec.ts`：

```ts
/**
 * 阶段 5j：收款账户与出款单快照的字段加密（e2e）。
 *
 * ⚠️ **这些用例不验证「密文长什么样」** —— 密文格式是实现细节。
 *    它们验证的是**对外可观察的行为**：
 *    ① 库里的账号不是明文 ② API 只给掩码 ③ 打款渠道收到的是完整明文。
 */
```

用例清单：
1. 商家设账户 → 库里 `accountNoCipher` 不是明文、掩码串正确、版本号 1
2. 商家读账户 → 只返回掩码串，响应里不含完整账号
3. 申请出款 → 库里 `snapshotAccountNoCipher` 是密文
4. 平台端读出款单 → `maskedSnapshotAccountNo` 正确，响应里不含完整账号
5. 审批并打款 → 假网关收到的 `accountNo` 是**完整明文**
6. 未迁移的行 → 读路径抛错（**这一条要直接改库把版本号改回 0**）

- [ ] **Step 3: 新建缺笔 e2e**

在 `api/test/ledger-reconciliation.e2e-spec.ts` 加：

```ts
  it('⚠️ 当期又进了新流水 → 结算单缺笔，平台端与商家端都看得见', async () => {
    const period = month('2023-06');
    const merchant = await setupMerchantWithPeriod(period, {
      receiptAmount: 10000,
      commissionAmount: 500,
    });

    // ---- 再补一笔抽佣流水到同一期 ----
    await seedCommissionEntry(merchant.tenantId, {
      orderNo: 'LATE-COMM-1',
      amount: 300,
      occurredAt: inside(period, 20),
    });

    // ---- 平台端：缺笔数 = 1 ----
    const statements = await fetchPlatformStatements(platformAdminToken);
    const statement = statements.items.find(
      (item) => item.tenantId === merchant.tenantId && item.periodLabel === period.label,
    );
    expect(statement!.missingEntryCount).toBe(1);

    // ---- 商家端：对账单也提示 ----
    const detail = await fetchStatementDetail(merchant.token, period.label);
    expect(detail.missingEntryCount).toBe(1);
  });
```

⚠️ **实施时先读该文件里已有的 helper**（`setupMerchantWithPeriod` / `seedCommissionEntry` /
`month` / `inside` / `fetchStatementDetail`），照抄签名，**不要自己造**。
⚠️ **`2023-06` 是本文件已用过的月份** —— 先把文件里所有 `month('...')` 列出来，
挑一个**全库未被任何 e2e 用过**的（5i 选的是 `2023-04`）。

- [ ] **Step 4: 跑验证**

```bash
cd api && npm run test:e2e -- test/payout-encryption.e2e-spec.ts
cd api && npm run test:e2e -- test/ledger-reconciliation.e2e-spec.ts
cd api && npm run test:e2e -- test/payout-execution.e2e-spec.ts
cd api && npm run test:e2e -- test/payout.e2e-spec.ts
```
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add api/test
git commit -m "test(api): 收款账户加密与缺笔可见性的 e2e"
```

---

### Task 8: 失败注入、浏览器手测、验收记录与 PR

**Files:**
- Create: `docs/superpowers/plans/2026-10-30-plan-05j-fund-security-ledger-closure-acceptance.md`
- Modify: `docs/superpowers/specs/2026-10-30-plan-05j-fund-security-ledger-closure-design.md`（§7.1 实施期修正）

- [ ] **Step 1: 失败注入 F1–F11**

用**脚本化注入**（改一处 → 跑定向测试 → 确认目标用例挂 → 还原 → **校验还原**）。

⚠️ **注入必须独占** —— 不要与全量测试并发（0.4 节的纪律）。
⚠️ **干跑校验锚点唯一命中** —— 替换静默失败会被误判成「护栏没牙齿」。

注入清单（与设计文档 §4.3 逐条对应）：

| # | 注入点 | 目标断言 |
|---|--------|---------|
| F1 | 写入时不加密（存明文） | 库里存的是密文 |
| F2 | 写入时把**明文**存进 `...Cipher` 列 | 解密抛错 / 库里检查发现不是密文 |
| F3 | 展示路径改成返回解密后的明文 | X14 断言挂（响应含完整账号） |
| F4 | 打款路径不解密 | 假网关收到的账号是密文串 |
| F5 | 缺笔判定的不等号改成 `<=`（笔数相等也算缺笔） | 不缺笔的期被误标 → 平台端缺笔用例挂 |
| F6 | 缺笔检测漏掉「当期新增未被纳入」的流水（改查 `settlement_statement_entries`） | 缺笔用例挂 |
| F7 | 缺笔检测改用账单的 `periodStart` 筛流水（而不是逐条按 `occurredAt` 归期） | 跨月场景的缺笔判定挂 |
| F8 | 商家端不返回缺笔字段 | 商家端提示用例挂 |
| F9 | 平台端缺笔标识恒为 0 | 平台端缺笔用例挂 |
| F10 | 读路径遇到版本号为 0 的行时**按明文兜底**（不抛错） | 未迁移行的读取用例挂 |
| F11 | 迁移脚本靠「能不能解密」判幂等（不用版本列） | 密钥配错时脚本**拒绝写库**（用例挂） |

⚠️ **F3 要特别注意**：把展示路径改成返回解密后的明文 → X14 的断言
（`JSON.stringify(detail)` 不含完整账号）必须挂。若不挂，说明 X14 的断言本身不够强。

- [ ] **Step 2: 浏览器手测**

准备环境（**手测完必须还原**）：

```bash
cd infra && docker compose up -d --build api merchant-admin platform-admin
```
⚠️ **必须 rebuild** —— 源码在镜像里。

手测步骤：

| # | 手测项 | 预期 |
|---|--------|------|
| 1 | 商家设置收款账户 | 页面显示掩码账号（尾 4 位）；**开发者工具里看响应无完整账号** |
| 2 | 直接查数据库 | `accountNoCipher` 是密文；`encryptionVersion = 1` |
| 3 | 商家申请出款 | 平台端出款单显示掩码账号；响应无完整账号 |
| 4 | 平台审批并打款 | 假网关日志里收到**完整明文账号**（用假网关的 `received` 端点查） |
| 5 | 补一笔抽佣流水到已结算的期 | 平台端结算单列表显示「缺 1 笔」；详情给修账指引 |
| 6 | 商家端对账单 | 该期出现缺笔提示；金额与之前一致（**提示不改金额**） |

⚠️ **账号**：商家 `owner@demo.platform.test / Demo12345!`、平台超管 `admin@platform.test / Admin12345!`。
⚠️ **浏览器用本机 `ego lite`**，全程不得抢前台；任务结束关闭标签页。

- [ ] **Step 3: 清理手测数据并还原环境**

```bash
# 还原 compose 的临时改动
cd /Users/tom/orca/workspaces/电商项目/电商项目 && git checkout -- infra/docker-compose.yml
cd infra && docker compose up -d api
```
⚠️ **手测期间若临时改过 `infra/docker-compose.yml`（如加 `PAYOUT_ACCOUNT_ENCRYPTION_KEY`），
必须还原**（compose 里的本地固定值已经加在 Task 1 了，不需要临时改）。

清理手测造的数据（按外键依赖顺序）：
```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce <<'SQL'
DELETE FROM payout_entries WHERE "payoutId" IN (SELECT id FROM payouts WHERE "payoutNo" LIKE 'MANUAL5J%');
DELETE FROM payouts WHERE "payoutNo" LIKE 'MANUAL5J%';
DELETE FROM merchant_payout_accounts WHERE "accountName" = '手测账户';
SQL
```
⚠️ **`docker exec` 必须带 `-i`** —— 缺了 stdin 传不进去，psql 读到空输入、
**退出码 0、但一行都没删**（5j 实测踩过）。

- [ ] **Step 4: 全量验证**

```bash
cd api && npm test
cd api && npm run test:e2e
cd merchant-admin && npx vitest run
cd platform-admin && npx vitest run
cd api && npm run lint && npx tsc --noEmit
cd merchant-admin && npm run lint && npx tsc --noEmit
cd platform-admin && npm run lint && npx tsc --noEmit
```
Expected: 全部通过

⚠️ **e2e 全量若出现零星挂**，先怀疑 5h-1 遗留的两条概率性 flaky
（`payment-compensation`「扫描 A…」/ `payout`「P7…」）——
它们与本阶段无关，但要在验收记录里如实写。

- [ ] **Step 5: 写验收记录**

创建 `docs/superpowers/plans/2026-10-30-plan-05j-fund-security-ledger-closure-acceptance.md`，
内容参照 5i 的验收记录结构：

- 一、概览（做了什么 / 结论）
- 二、关键设计决策（加密格式、密钥来源、版本列、缺笔判定口径）
- 三、失败注入 F1–F10 的逐条结果
- 四、浏览器手测 6 步的实测结果
- 五、已知差异与遗留
- 六、测试统计
- 七、审查记录

⚠️ **如实记录**：注入「挂 0 条」的、flaky 的、手测时发现的额外问题，
都要写进去 —— 不要只写通过的。

- [ ] **Step 6: 提交**

```bash
git add docs api merchant-admin platform-admin infra
git commit -m "docs: 阶段 5j 验收记录——加密改造、缺笔可见性与失败注入"
```

- [ ] **Step 7: 推送并开 PR**

⚠️ **本机 GitHub 443 不可达** → 走 API 推送：
```bash
export GH_TOKEN=$(gh auth token)
export COMMIT_MESSAGE="阶段 5j：资金安全与账务闭环（账户加密 + 缺笔可见性）"
node tools/push-via-api.mjs "gzt/电商项目" "gzt/电商项目"
```

```bash
gh pr create --base main --head "gzt/电商项目" \
  --title "阶段 5j：资金安全与账务闭环（账户加密 + 缺笔可见性）" \
  --body "$(cat <<'EOF'
## 背景

5g→5h→5i 把账务的**正向**链路做完了，但**反向**与**存量**有两处缺口：
收款账户明文存、出款单每张再存一份完整账号快照；结算单缺笔时佣金少算却没人知道。

## 做了什么

| 能力 | 落点 |
|------|------|
| 字段加密工具（AES-256-GCM + HKDF） | `api/src/common/crypto/field-cipher.ts` |
| 收款账户与出款单快照改密文存储 | `merchant_payout_accounts` / `payouts` |
| 独立账目密钥 + 启动校验 | `PAYOUT_ACCOUNT_ENCRYPTION_KEY` |
| 存量迁移脚本（备份 + 指纹 + 幂等） | `npm run migrate:payout-encryption` |
| 缺笔检测（平台端 + 商家端） | `settlement.service.ts` / `ledger.service.ts` |

## 关键决策

- **改名而不是保留列名存密文** —— `...Cipher` 后缀自解释，与 `payment_methods.token` 的做法不同是有意为之
- **版本列做幂等判定**，不靠「能不能解密」—— 密钥配错时后者会用错密钥覆盖原文且不可恢复
- **展示路径全程不解密** —— 解密点只有 worker 打款与迁移脚本两处
- **缺笔只比笔数** —— 抽佣流水 append-only；将来流水可变时必须改成比金额

## 验证

- 浏览器手测 6 步全部实测通过
- 失败注入 F1–F10 逐条跑完
- 两轮独立审查（规格符合性 → 代码质量）

EOF
)"
```

- [ ] **Step 8: 合并并快进本地 main**

```bash
gh pr merge <PR 号> --squash --delete-branch
git -C /Users/tom/orca/projects/电商项目 merge --ff-only "gzt/电商项目"
```
⚠️ **`main` 被另一个 worktree 占用** —— 必须在主工作区里快进，
在本地工作区 `git branch -f main` 会报
`cannot force update the branch 'main' used by worktree at ...`。
