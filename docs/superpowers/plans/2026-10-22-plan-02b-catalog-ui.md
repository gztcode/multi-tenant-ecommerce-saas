# 计划 2b：商品中心前端与主题 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在计划 2a 的商品中心后端之上，补齐面向消费者的店铺前台浏览（首页商品流、品类页、搜索、详情页与规格选择器）、面向商家的后台商品管理（CRUD、规格矩阵编辑器、批量操作、CSV 导入导出、库存台账），以及全量 CSS token 主题的商家配置与前台渲染。

**Architecture:** 主题 token 的**定义与校验放在后端**（`theme` 模块），因为 storefront 与 merchant-admin 是两个独立项目、不共享代码，各自维护一份 token 白名单必然漂移。后端按白名单过滤后下发结构化 token，storefront 在 Server Component 里拼成 CSS 变量注入 `:root`，merchant-admin 拿同一份 schema 渲染配置表单。storefront 的商品页走 Server Component 直读后端（匿名请求靠 `X-Tenant-Subdomain` 头定位租户），交互态用客户端组件。merchant-admin 沿用阶段 1 的同源 BFF 代理模式——后端没开 CORS，浏览器直连会被预检拦掉。

**Tech Stack:** Next.js 15 (App Router) + React 19 + NextAuth.js v5 + Tailwind CSS 4 + shadcn/ui + tanstack-query | NestJS 11 + Prisma 6

**对应设计文档:** `docs/superpowers/specs/2026-10-22-plan-02-product-center-design.md` §七、§八、§九、§十

**前置计划:** `docs/superpowers/plans/2026-10-22-plan-02a-catalog-backend.md` 必须先完成并通过验收。

**本计划的交付边界：** 完成后整个阶段 2 闭环——商家能上架带规格的商品并配置主题，
消费者能浏览、搜索、选规格。计划 3（交易链路）从这套商品与库存数据之上继续。

---

## 零、全局约定

### 0.1 路径与命名

沿用阶段 2a 的约定：路径相对于仓库根目录 `/Users/tom/orca/workspaces/电商项目/电商项目`；
提交信息格式 `<type>: <中文描述>`。

### 0.2 前端的两个关键约束

**① 后端没开 CORS，浏览器不能直连。**

阶段 1 的设计决策（见设计文档 §十四 已知遗留项 #1）：前端与 API 同源，
由 Nginx 反代。因此：

- **Server Component 里直读后端**——服务端调用不受 CORS 限制，可以。
- **客户端组件里 fetch 后端**——浏览器直连会被预检拦掉，表现为 `Failed to fetch`。
  必须走各自的同源中转路由 `/api/**`（storefront 与 merchant-admin 各有自己的）。

**② 匿名请求必须带 `X-Tenant-Subdomain`。**

公开商品接口靠子域名定位租户。容器内 storefront 直连 `api:3000`，
Host 是服务名，解析不出子域名。所以**每一条发往 api 的请求都要显式带这个头**。

storefront 的 `apiFetch` 已经支持 `subdomain` 选项（`storefront/src/lib/api-client.ts`），
直接用它，不要另写一套。

### 0.3 主题 token 的单一事实源

token 的**定义、白名单、默认值、校验**全部在后端 `theme` 模块。
理由见 §Architecture：两个前端项目不共享代码。

| 接口 | 用途 | 守卫 |
|------|------|------|
| `GET /api/v1/theme/schema` | token 的定义（名称、标签、类型、默认值） | `@Public()` |
| `GET /api/v1/public/theme` | 当前店铺生效的 token 值 | `@Public()` |

---

## Task 9：主题 token——后端定义、商家表单、前台注入

**Files:**
- Create: `api/src/modules/theme/theme.module.ts`
- Create: `api/src/modules/theme/theme-tokens.ts`
- Create: `api/src/modules/theme/theme.service.ts`
- Create: `api/src/modules/theme/theme.controller.ts`
- Modify: `api/src/app.module.ts`
- Create: `api/test/theme.e2e-spec.ts`
- Create: `storefront/src/lib/theme.ts`
- Modify: `storefront/src/app/(shop)/layout.tsx`
- Modify: `merchant-admin/src/app/(dashboard)/settings/settings-form.tsx`
- Modify: `merchant-admin/src/app/api/stores/me/route.ts`

### 9.1 先写失败测试

创建 `api/test/theme.e2e-spec.ts`：

```typescript
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

describe('主题 token (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('schema 返回全部 token 的定义与默认值', async () => {
    const response = await http(app).get('/api/v1/theme/schema').expect(200);

    expect(response.body.colors.map((c: { key: string }) => c.key)).toContain(
      'primary',
    );
    expect(response.body.radius.key).toBe('radius');
    expect(response.body.textScale).toHaveLength(5);
  });

  it('公开主题接口返回当前店铺的 token，未配置时返回默认值', async () => {
    const merchant = await createMerchant(app, app.get(TenantPrismaService));

    const response = await http(app)
      .get('/api/v1/public/theme')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(response.body.tokens.colors.primary).toBeTruthy();
  });

  it('未知的 token 名被丢弃，不会出现在响应里', async () => {
    const merchant = await createMerchant(app, app.get(TenantPrismaService));

    await http(app)
      .patch('/api/v1/stores/me')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        themeTokens: {
          colors: { primary: 'oklch(0.55 0.22 264)', evil: 'boom' },
          radius: '0.5rem',
          未知分组: { x: 'y' },
        },
      })
      .expect(200);

    const response = await http(app)
      .get('/api/v1/public/theme')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(response.body.tokens.colors.primary).toBe('oklch(0.55 0.22 264)');
    expect(response.body.tokens.colors.evil).toBeUndefined();
    expect(response.body.tokens['未知分组']).toBeUndefined();
  });
```

> **`app.get(TenantPrismaService)`** 需要先 import：
> `import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';`

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/theme.e2e-spec.ts
```

预期：FAIL，404。

- [ ] **Step 2: 写 token 定义**

创建 `api/src/modules/theme/theme-tokens.ts`：

```typescript
/**
 * 主题 token 的定义——**单一事实来源**。
 *
 * 为什么放后端：storefront 与 merchant-admin 是两个独立项目、不共享代码，
 * 各自维护一份 token 白名单必然漂移（加了一个新 token 只改了一边，
 * 结果就是前台渲染不出来、后台也配不了）。
 *
 * ⚠️ 颜色格式是 **oklch**，不是 HSL 三元组。仓库的 globals.css 用的是
 * Tailwind CSS 4 + shadcn/ui 新版，默认值就是 `oklch(0.205 0 0)`。
 */

export interface ColorTokenDefinition {
  key: string;
  label: string;
  /** CSS 变量名（shadcn 约定用裸名，Tailwind 侧由 @theme inline 映射） */
  cssVar: string;
  defaultValue: string;
}

export interface ScalarTokenDefinition {
  key: string;
  label: string;
  cssVar: string;
  defaultValue: string;
}

export const COLOR_TOKENS: ColorTokenDefinition[] = [
  { key: 'background', label: '背景色', cssVar: '--background', defaultValue: 'oklch(1 0 0)' },
  { key: 'foreground', label: '文字色', cssVar: '--foreground', defaultValue: 'oklch(0.145 0 0)' },
  { key: 'card', label: '卡片背景', cssVar: '--card', defaultValue: 'oklch(1 0 0)' },
  { key: 'cardForeground', label: '卡片文字', cssVar: '--card-foreground', defaultValue: 'oklch(0.145 0 0)' },
  { key: 'primary', label: '主色', cssVar: '--primary', defaultValue: 'oklch(0.205 0 0)' },
  { key: 'primaryForeground', label: '主色上的文字', cssVar: '--primary-foreground', defaultValue: 'oklch(0.985 0 0)' },
  { key: 'secondary', label: '次要色', cssVar: '--secondary', defaultValue: 'oklch(0.97 0 0)' },
  { key: 'secondaryForeground', label: '次要色上的文字', cssVar: '--secondary-foreground', defaultValue: 'oklch(0.205 0 0)' },
  { key: 'muted', label: '弱化色', cssVar: '--muted', defaultValue: 'oklch(0.97 0 0)' },
  { key: 'mutedForeground', label: '弱化色上的文字', cssVar: '--muted-foreground', defaultValue: 'oklch(0.556 0 0)' },
  { key: 'accent', label: '强调色', cssVar: '--accent', defaultValue: 'oklch(0.97 0 0)' },
  { key: 'accentForeground', label: '强调色上的文字', cssVar: '--accent-foreground', defaultValue: 'oklch(0.205 0 0)' },
  { key: 'destructive', label: '危险色', cssVar: '--destructive', defaultValue: 'oklch(0.577 0.245 27.325)' },
  { key: 'destructiveForeground', label: '危险色上的文字', cssVar: '--destructive-foreground', defaultValue: 'oklch(0.985 0 0)' },
  { key: 'border', label: '边框色', cssVar: '--border', defaultValue: 'oklch(0.922 0 0)' },
  { key: 'ring', label: '聚焦环', cssVar: '--ring', defaultValue: 'oklch(0.708 0 0)' },
];

export const RADIUS_TOKEN: ScalarTokenDefinition = {
  key: 'radius',
  label: '圆角',
  cssVar: '--radius',
  defaultValue: '0.625rem',
};

export const FONT_TOKENS: ScalarTokenDefinition[] = [
  { key: 'fontSans', label: '正文字体', cssVar: '--font-sans', defaultValue: 'var(--font-geist-sans)' },
  { key: 'fontMono', label: '等宽字体', cssVar: '--font-mono', defaultValue: 'var(--font-geist-mono)' },
];

export const TEXT_SCALE_TOKENS: ScalarTokenDefinition[] = [
  { key: 'xs', label: '最小', cssVar: '--text-xs', defaultValue: '0.75rem' },
  { key: 'sm', label: '小', cssVar: '--text-sm', defaultValue: '0.875rem' },
  { key: 'base', label: '正文', cssVar: '--text-base', defaultValue: '1rem' },
  { key: 'lg', label: '大', cssVar: '--text-lg', defaultValue: '1.125rem' },
  { key: 'xl', label: '特大', cssVar: '--text-xl', defaultValue: '1.25rem' },
];

export const WEIGHT_TOKENS: ScalarTokenDefinition[] = [
  { key: 'normal', label: '常规', cssVar: '--font-weight-normal', defaultValue: '400' },
  { key: 'medium', label: '中等', cssVar: '--font-weight-medium', defaultValue: '500' },
  { key: 'semibold', label: '半粗', cssVar: '--font-weight-semibold', defaultValue: '600' },
  { key: 'bold', label: '加粗', cssVar: '--font-weight-bold', defaultValue: '700' },
];

export const SPACING_TOKENS: ScalarTokenDefinition[] = [
  { key: 'xs', label: '最小', cssVar: '--spacing-xs', defaultValue: '0.25rem' },
  { key: 'sm', label: '小', cssVar: '--spacing-sm', defaultValue: '0.5rem' },
  { key: 'base', label: '标准', cssVar: '--spacing-base', defaultValue: '1rem' },
  { key: 'lg', label: '大', cssVar: '--spacing-lg', defaultValue: '1.5rem' },
  { key: 'xl', label: '特大', cssVar: '--spacing-xl', defaultValue: '2rem' },
];

export const SHADOW_TOKENS: ScalarTokenDefinition[] = [
  { key: 'sm', label: '轻', cssVar: '--shadow-sm', defaultValue: '0 1px 2px 0 rgb(0 0 0 / 0.05)' },
  { key: 'base', label: '标准', cssVar: '--shadow-base', defaultValue: '0 4px 6px -1px rgb(0 0 0 / 0.1)' },
  { key: 'lg', label: '重', cssVar: '--shadow-lg', defaultValue: '0 10px 15px -3px rgb(0 0 0 / 0.1)' },
];

/**
 * token 值的形状校验。
 *
 * `stores.themeTokens` 是 Json 字段，客户端可以塞任何东西。
 * 不校验就直接拼进 CSS，一个 `{ "background": "url(javascript:...)" }`
 * 就能把任意 CSS 注入页面——这是实打实的 XSS 矢量。
 *
 * 规则：
 * - 颜色必须是 oklch(...) 形式：只允许字母、数字、空格、点、%、括号、逗号、斜杠
 * - 其余标量只允许字母、数字、点、%、rem、px、em、vh、vw、逗号、空格、斜杠、括号
 * - 长度上限 200 字符
 */
const COLOR_VALUE = /^oklch\([0-9a-zA-Z.%\-/ ]{1,180}\)$/;
const SCALAR_VALUE = /^[0-9a-zA-Z.%\-/,_() ]{1,180}$/;

export function isValidColorValue(value: unknown): value is string {
  return typeof value === 'string' && COLOR_VALUE.test(value);
}

export function isValidScalarValue(value: unknown): value is string {
  return typeof value === 'string' && SCALAR_VALUE.test(value);
}

/** 已知的 token 分组名 */
export const TOKEN_GROUPS = [
  'colors',
  'textScale',
  'weights',
  'spacing',
  'shadows',
] as const;

export type TokenGroup = (typeof TOKEN_GROUPS)[number];
```

- [ ] **Step 3: 写 ThemeService**

创建 `api/src/modules/theme/theme.service.ts`：

```typescript
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import {
  COLOR_TOKENS,
  FONT_TOKENS,
  RADIUS_TOKEN,
  SHADOW_TOKENS,
  SPACING_TOKENS,
  TEXT_SCALE_TOKENS,
  WEIGHT_TOKENS,
  isValidColorValue,
  isValidScalarValue,
} from './theme-tokens';

/** token 的分组结构 */
export interface ThemeTokens {
  colors: Record<string, string>;
  radius: string;
  fontSans: string;
  fontMono: string;
  textScale: Record<string, string>;
  weights: Record<string, string>;
  spacing: Record<string, string>;
  shadows: Record<string, string>;
}

@Injectable()
export class ThemeService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** token 的定义（供商家后台渲染表单） */
  schema() {
    return {
      colors: COLOR_TOKENS,
      radius: RADIUS_TOKEN,
      fonts: FONT_TOKENS,
      textScale: TEXT_SCALE_TOKENS,
      weights: WEIGHT_TOKENS,
      spacing: SPACING_TOKENS,
      shadows: SHADOW_TOKENS,
    };
  }

  /** 全部 token 的默认值 */
  private defaults(): ThemeTokens {
    return {
      colors: Object.fromEntries(
        COLOR_TOKENS.map((t) => [t.key, t.defaultValue]),
      ),
      radius: RADIUS_TOKEN.defaultValue,
      fontSans: FONT_TOKENS[0].defaultValue,
      fontMono: FONT_TOKENS[1].defaultValue,
      textScale: Object.fromEntries(
        TEXT_SCALE_TOKENS.map((t) => [t.key, t.defaultValue]),
      ),
      weights: Object.fromEntries(
        WEIGHT_TOKENS.map((t) => [t.key, t.defaultValue]),
      ),
      spacing: Object.fromEntries(
        SPACING_TOKENS.map((t) => [t.key, t.defaultValue]),
      ),
      shadows: Object.fromEntries(
        SHADOW_TOKENS.map((t) => [t.key, t.defaultValue]),
      ),
    };
  }

  /**
   * 过滤成白名单内的、合法的 token。
   *
   * 未知分组直接丢弃；已知分组里未知的键也丢弃；
   * 值不合法的键回落到默认值。
   *
   * 这一层是安全边界：`stores.themeTokens` 是 Json 字段，客户端可控。
   */
  sanitize(raw: unknown): ThemeTokens {
    const result = this.defaults();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return result;
    }
    const source = raw as Record<string, unknown>;

    // 颜色
    const colors = source.colors;
    if (typeof colors === 'object' && colors !== null && !Array.isArray(colors)) {
      for (const token of COLOR_TOKENS) {
        const value = (colors as Record<string, unknown>)[token.key];
        if (isValidColorValue(value)) {
          result.colors[token.key] = value;
        }
      }
    }

    // 标量 token
    const radius = source.radius;
    if (isValidScalarValue(radius)) {
      result.radius = radius;
    }
    const fontSans = source.fontSans;
    if (isValidScalarValue(fontSans)) {
      result.fontSans = fontSans;
    }
    const fontMono = source.fontMono;
    if (isValidScalarValue(fontMono)) {
      result.fontMono = fontMono;
    }

    // 分组标量
    const groups: Array<[string, typeof TEXT_SCALE_TOKENS]> = [
      ['textScale', TEXT_SCALE_TOKENS],
      ['weights', WEIGHT_TOKENS],
      ['spacing', SPACING_TOKENS],
      ['shadows', SHADOW_TOKENS],
    ];
    for (const [groupName, definitions] of groups) {
      const group = source[groupName];
      if (typeof group !== 'object' || group === null || Array.isArray(group)) {
        continue;
      }
      const target = result[groupName as 'textScale'] as Record<string, string>;
      for (const token of definitions) {
        const value = (group as Record<string, unknown>)[token.key];
        if (isValidScalarValue(value)) {
          target[token.key] = value;
        }
      }
    }

    return result;
  }

  /** 当前店铺生效的 token */
  async current(): Promise<ThemeTokens> {
    const context = getTenantContext();
    if (!context.tenantId) {
      return this.defaults();
    }
    const store = await this.prisma.store.findFirst({
      where: { tenantId: context.tenantId },
      select: { themeTokens: true },
    });
    return this.sanitize(store?.themeTokens);
  }
}
```

- [ ] **Step 4: 写 ThemeController 与 Module**

创建 `api/src/modules/theme/theme.controller.ts`：

```typescript
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ThemeService } from './theme.service';

@ApiTags('theme')
@Controller('theme')
export class ThemeController {
  constructor(private readonly themeService: ThemeService) {}

  @Get('schema')
  @Public()
  @ApiOperation({ summary: '主题 token 的定义与默认值' })
  schema() {
    return this.themeService.schema();
  }
}
```

创建 `api/src/modules/theme/public-theme.controller.ts`：

```typescript
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ThemeService } from './theme.service';

@ApiTags('public-theme')
@Controller('public/theme')
export class PublicThemeController {
  constructor(private readonly themeService: ThemeService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: '当前店铺生效的主题 token' })
  async current() {
    return { tokens: await this.themeService.current() };
  }
}
```

创建 `api/src/modules/theme/theme.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { ThemeController } from './theme.controller';
import { PublicThemeController } from './public-theme.controller';
import { ThemeService } from './theme.service';

@Module({
  controllers: [ThemeController, PublicThemeController],
  providers: [ThemeService],
  exports: [ThemeService],
})
export class ThemeModule {}
```

改 `api/src/app.module.ts` 加 `ThemeModule`。

- [ ] **Step 5: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/theme.e2e-spec.ts
```

预期：全部 PASS。

- [ ] **Step 6: 写 storefront 的 token 拼装**

创建 `storefront/src/lib/theme.ts`：

```typescript
/**
 * 把主题 token 拼成 CSS 变量声明。
 *
 * 变量名沿用 shadcn 的约定：`:root` 里是 `--primary` / `--background` 这类裸名，
 * Tailwind 侧由 globals.css 的 `@theme inline` 映射成 `--color-primary`。
 * 覆盖的是**裸名**那一层。
 *
 * ⚠️ 值已经由后端 ThemeService.sanitize 按白名单过滤过，
 * 这里不再重复校验——但拼装时仍然只接受后端 schema 里出现过的变量名，
 * 避免「后端漏了一个字段，前端就把任意内容拼进 style 标签」。
 */

export interface ThemeTokenValues {
  colors: Record<string, string>;
  radius: string;
  fontSans: string;
  fontMono: string;
  textScale: Record<string, string>;
  weights: Record<string, string>;
  spacing: Record<string, string>;
  shadows: Record<string, string>;
}

/** 与后端 theme-tokens.ts 一一对应的 CSS 变量名 */
const CSS_VARS: Record<string, string[]> = {
  // colors
  background: ['--background'],
  foreground: ['--foreground'],
  card: ['--card'],
  cardForeground: ['--card-foreground'],
  primary: ['--primary'],
  primaryForeground: ['--primary-foreground'],
  secondary: ['--secondary'],
  secondaryForeground: ['--secondary-foreground'],
  muted: ['--muted'],
  mutedForeground: ['--muted-foreground'],
  accent: ['--accent'],
  accentForeground: ['--accent-foreground'],
  destructive: ['--destructive'],
  destructiveForeground: ['--destructive-foreground'],
  border: ['--border'],
  ring: ['--ring'],
  // 标量
  radius: ['--radius'],
  fontSans: ['--font-sans'],
  fontMono: ['--font-mono'],
};

/** 分组标量：键 → CSS 变量名 */
const GROUP_CSS_VARS: Record<string, string> = {
  textScale: '--text-',
  weights: '--font-weight-',
  spacing: '--spacing-',
  shadows: '--shadow-',
};

/** 生成 :root 规则的内容 */
export function buildThemeCss(tokens: ThemeTokenValues): string {
  const declarations: string[] = [];

  for (const [key, value] of Object.entries(tokens.colors ?? {})) {
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    declarations.push(`  ${vars[0]}: ${value};`);
  }

  for (const key of ['radius', 'fontSans', 'fontMono'] as const) {
    const value = tokens[key];
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    declarations.push(`  ${vars[0]}: ${value};`);
  }

  for (const [group, prefix] of Object.entries(GROUP_CSS_VARS)) {
    const values = tokens[group as keyof ThemeTokenValues] as
      | Record<string, string>
      | undefined;
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue;
      declarations.push(`  ${prefix}${key}: ${value};`);
    }
  }

  return declarations.join('\n');
}
```

- [ ] **Step 7: 在 storefront 注入主题**

**先验证 Next.js 的 layout 是否按子域名分别渲染**（设计文档 §7.2 标出的风险点）：

```bash
cd storefront && npm run dev
```

另开一个终端，用两个不同的子域名各请求一次首页，看响应里的主题是否不同。
若两个子域名返回了同一个主题（说明 layout 被缓存了），**必须改成在 page 层注入**
（下面两种写法都要能工作）。

创建 `storefront/src/app/(shop)/layout.tsx`：

```tsx
import { headers } from 'next/headers';
import { apiFetch } from '@/lib/api-client';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { buildThemeCss, ThemeTokenValues } from '@/lib/theme';

interface ThemeResponse {
  tokens: ThemeTokenValues;
}

/**
 * 店铺主题注入。
 *
 * 在 Server Component 里做，而不是客户端组件：
 * 1. 匿名请求要靠子域名解析租户，而主题是租户级的——服务端才有这个上下文；
 * 2. 服务端注入顺带避免了 FOUC（首屏闪烁默认配色）。
 */
export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  let tokens: ThemeTokenValues | null = null;
  try {
    const response = await apiFetch<ThemeResponse>('/public/theme', {
      subdomain,
    });
    tokens = response.tokens;
  } catch {
    // 主题拉不到时用默认主题渲染，不要让整个店铺白屏
    tokens = null;
  }

  const css = tokens ? buildThemeCss(tokens) : '';

  return (
    <>
      {css ? (
        <style
          // 主题内容由后端按白名单过滤过，不含用户可控的任意文本
          dangerouslySetInnerHTML={{ __html: `:root {\n${css}\n}` }}
        />
      ) : null}
      {children}
    </>
  );
}
```

> **`dangerouslySetInnerHTML` 的安全性**：内容来自后端 `ThemeService.sanitize`，
> 它按白名单过滤了 token 名并用正则校验了值的形状（颜色只允许 oklch(...)，
> 标量只允许有限的字符集）。所以拼出来的 CSS 里不含用户可控的任意文本。
>
> **`(shop)` 路由组的 layout 必须是服务端组件**：文件里不能有 `'use client'`。
>
> **`export const dynamic = 'force-dynamic'`**：如果实测发现 layout 被缓存导致
> 主题串店，加上这一行强制按请求渲染。

- [ ] **Step 8: 写商家后台的主题表单**

先看现有的 `merchant-admin/src/app/(dashboard)/settings/settings-form.tsx`，
在它的基础上增加「主题」分区。

新建 `merchant-admin/src/components/theme/theme-form.tsx`：

```tsx
'use client';

import { useState } from 'react';

interface ColorToken {
  key: string;
  label: string;
  cssVar: string;
  defaultValue: string;
}

interface ScalarToken {
  key: string;
  label: string;
  cssVar: string;
  defaultValue: string;
}

interface ThemeSchema {
  colors: ColorToken[];
  radius: ScalarToken;
  fonts: ScalarToken[];
  textScale: ScalarToken[];
  weights: ScalarToken[];
  spacing: ScalarToken[];
  shadows: ScalarToken[];
}

export function ThemeForm({
  schema,
  initial,
  onSave,
}: {
  schema: ThemeSchema;
  initial: Record<string, unknown>;
  onSave: (tokens: Record<string, unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /**
   * 更新某个分组里的某个 token。
   *
   * 整个表单只有**一个** state（draft），不为 30 多个 token 各开一个 useState。
   * 分组结构是 `Record<groupName, Record<tokenKey, string>>`，
   * 顶层标量（radius / fontSans / fontMono）单独处理。
   */
  function setGroupToken(
    group: string,
    key: string,
    value: string,
  ) {
    setDraft((prev) => ({
      ...prev,
      [group]: {
        ...((prev[group] as Record<string, string> | undefined) ?? {}),
        [key]: value,
      },
    }));
  }

  function setTopLevel(key: string, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function valueOf(group: string, key: string, fallback: string): string {
    const bucket = draft[group] as Record<string, string> | undefined;
    return bucket?.[key] ?? fallback;
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      await onSave(draft);
      setMessage('已保存');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  /** 渲染一组标量 token 的输入框 */
  function renderScalars(
    group: string,
    definitions: Array<{ key: string; label: string; defaultValue: string }>,
  ) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {definitions.map((token) => (
          <label key={token.key} className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{token.label}</span>
            <input
              type="text"
              className="rounded-md border px-2 py-1"
              value={valueOf(group, token.key, token.defaultValue)}
              onChange={(e) =>
                setGroupToken(group, token.key, e.target.value)
              }
            />
          </label>
        ))}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <h3 className="text-lg font-semibold">店铺主题</h3>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">颜色</h4>
        {renderScalars('colors', schema.colors)}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">圆角与字体</h4>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{schema.radius.label}</span>
            <input
              type="text"
              className="rounded-md border px-2 py-1"
              value={String(draft.radius ?? schema.radius.defaultValue)}
              onChange={(e) => setTopLevel('radius', e.target.value)}
            />
          </label>
          {schema.fonts.map((token) => (
            <label key={token.key} className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{token.label}</span>
              <input
                type="text"
                className="rounded-md border px-2 py-1"
                value={String(draft[token.key] ?? token.defaultValue)}
                onChange={(e) => setTopLevel(token.key, e.target.value)}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">字阶</h4>
        {renderScalars('textScale', schema.textScale)}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">字重</h4>
        {renderScalars('weights', schema.weights)}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">间距</h4>
        {renderScalars('spacing', schema.spacing)}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">阴影</h4>
        {renderScalars('shadows', schema.shadows)}
      </div>

      <button
        type="button"
        className="w-fit rounded-md bg-primary px-4 py-2 text-primary-foreground"
        disabled={saving}
        onClick={handleSave}
      >
        {saving ? '保存中…' : '保存主题'}
      </button>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </section>
  );
}
```

> **为什么用文本框而不是取色器**：oklch 字符串用原生 `<input type="color">`
> 表达不了（它只出 hex）。要做取色器就得引入色彩库并自己写 hex→oklch 转换，
> 那是计划外的复杂度。本阶段用文本框，商家可以粘贴设计稿给的 oklch 值。
>
> **颜色的输入框是普通文本框**——schema 里 `colors` 与其它分组结构一致
> （都是 `Record<key, string>`），所以 `renderScalars` 一个函数渲染全部六组。

在 `merchant-admin/src/app/(dashboard)/settings/settings-form.tsx` 里引入主题分区：

```tsx
import { ThemeForm } from '@/components/theme/theme-form';

// 在已有的店铺设置表单下方加：
{schema && (
  <ThemeForm
    schema={schema}
    initial={(initialStore.themeTokens ?? {}) as Record<string, unknown>}
    onSave={async (tokens) => {
      const response = await fetch('/api/stores/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ themeTokens: tokens }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          (payload as { message?: string }).message ?? '保存失败',
        );
      }
    }}
  />
)}
```

`schema` 从服务端页面取（`merchant-admin/src/app/(dashboard)/settings/page.tsx`）：

```tsx
  // 在 page 里加：
  let schema: ThemeSchema | null = null;
  try {
    schema = await apiFetchAuthed<ThemeSchema>('/theme/schema');
  } catch {
    schema = null;
  }
```

> **`/theme/schema` 挂在 `@Public()` 上**，但用 `apiFetchAuthed` 带 token 调用也
> 没问题——`@Public()` 只是放行，不是禁止。

- [ ] **Step 9: 三个前端的类型检查与构建**

```bash
cd storefront && npx tsc --noEmit && npm run lint && npm run build
cd merchant-admin && npx tsc --noEmit && npm run lint && npm run build
```

预期：全部通过。

- [ ] **Step 10: 提交**

```bash
git add api/src api/test storefront/src merchant-admin/src
git commit -m "feat: 全量主题 token（后端定义与校验、商家表单、storefront 注入）"
```

---

## Task 10：storefront 商品浏览页

**Files:**
- Modify: `storefront/src/app/(shop)/page.tsx`
- Create: `storefront/src/app/(shop)/c/[slug]/page.tsx`
- Create: `storefront/src/app/(shop)/search/page.tsx`
- Create: `storefront/src/app/(shop)/p/[slug]/page.tsx`
- Create: `storefront/src/components/product/product-card.tsx`
- Create: `storefront/src/components/product/spec-selector.tsx`
- Create: `storefront/src/lib/catalog.ts`
- Create: `storefront/src/lib/format.ts`

### 10.1 先写后端契约测试

前台页面依赖后端接口，先确认接口返回的形状够用。在
`api/test/catalog-public.e2e-spec.ts` 里补一条断言详情接口的媒体与规格结构：

```typescript
  it('详情接口返回媒体列表，按 sort 升序', async () => {
    const merchant = await createMerchant(app, prisma);
    const product = await publishProduct(merchant.token, '带图商品');

    const response = await http(app)
      .get(`/api/v1/public/products/${product.slug}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    // 没有媒体时是空数组，不是 undefined
    expect(Array.isArray(response.body.media)).toBe(true);
    expect(response.body.media).toHaveLength(0);
  });
```

- [ ] **Step 1.2: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog-public.e2e-spec.ts
```

预期：PASS（这条断言的是现有行为，是给前端开发定契约的锚点）。

- [ ] **Step 2: 写前端的类型与数据层**

创建 `storefront/src/lib/format.ts`：

```typescript
/** 金额：分 → 「¥59.00」 */
export function formatPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `¥${(cents / 100).toFixed(2)}`;
}

/** 金额区间：只有一个价时只显示一个 */
export function formatPriceRange(
  min: number | null | undefined,
  max?: number | null,
): string {
  if (min === null || min === undefined) return '—';
  if (max === null || max === undefined || max === min) {
    return formatPrice(min);
  }
  return `${formatPrice(min)} - ${formatPrice(max)}`;
}
```

创建 `storefront/src/lib/catalog.ts`：

```typescript
import { apiFetch } from './api-client';

/** 公开商品列表的响应形状 */
export interface PublicProductList {
  items: PublicProductCard[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublicProductCard {
  id: string;
  name: string;
  slug: string;
  subtitle: string | null;
  minPrice: number;
  publishedAt: string | null;
  category: { id: string; name: string; slug: string } | null;
  media: Array<{
    sort: number;
    media: { id: string; url: string; mime: string };
  }>;
}

export interface PublicProductDetail {
  id: string;
  name: string;
  slug: string;
  subtitle: string | null;
  description: string | null;
  attributes: Record<string, string>;
  minPrice: number;
  publishedAt: string | null;
  category: { id: string; name: string; slug: string } | null;
  media: PublicProductCard['media'];
  specs: Array<{
    id: string;
    name: string;
    sort: number;
    values: Array<{ id: string; value: string; sort: number }>;
  }>;
  skus: Array<{
    id: string;
    price: number;
    comparePrice: number | null;
    stock: number;
    specValues: Array<{ valueId: string }>;
  }>;
}

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  children: PublicCategory[];
}

/**
 * 公开商品接口的调用封装。
 *
 * ⚠️ 每个请求都必须带 subdomain——匿名请求靠子域名定位租户，
 * 而容器内直连 api 的 Host 是服务名，解析不出子域名。
 */
export async function fetchPublicProducts(
  subdomain: string,
  query: Record<string, string | number | undefined> = {},
): Promise<PublicProductList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString();
  return apiFetch<PublicProductList>(
    `/public/products${suffix ? `?${suffix}` : ''}`,
    { subdomain },
  );
}

export async function fetchPublicProduct(
  subdomain: string,
  slug: string,
): Promise<PublicProductDetail> {
  return apiFetch<PublicProductDetail>(`/public/products/${slug}`, {
    subdomain,
  });
}

export async function fetchPublicCategories(
  subdomain: string,
): Promise<PublicCategory[]> {
  return apiFetch<PublicCategory[]>('/public/categories', { subdomain });
}
```

- [ ] **Step 3: 写商品卡片组件**

创建 `storefront/src/components/product/product-card.tsx`：

```tsx
import Link from 'next/link';
import { formatPrice } from '@/lib/format';
import type { PublicProductCard } from '@/lib/catalog';

export function ProductCard({ product }: { product: PublicProductCard }) {
  // 封面就是媒体列表里 sort 最小的那张——商品表不单独存封面字段，
  // 避免两个地方抢着决定谁是封面。
  const cover = product.media[0]?.media;

  return (
    <Link
      href={`/p/${product.slug}`}
      className="flex flex-col overflow-hidden rounded-lg border transition hover:shadow-md"
    >
      <div className="aspect-square bg-muted">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover.url}
            alt={product.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            暂无图片
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 p-3">
        <h3 className="line-clamp-2 font-medium">{product.name}</h3>
        {product.subtitle && (
          <p className="line-clamp-1 text-sm text-muted-foreground">
            {product.subtitle}
          </p>
        )}
        <p className="font-semibold text-primary">
          {formatPrice(product.minPrice)}
        </p>
      </div>
    </Link>
  );
}
```

> **用 `<img>` 而不是 `next/image`**：图片在 MinIO 上，域名不是 Next.js
> 配置过的远端域名，用 `next/image` 需要在 `next.config.ts` 里配
> `images.remotePatterns`。本阶段直接用 `<img>` 并加 eslint 禁用注释。
> 将来要上 CDN 时再换 `next/image`。

- [ ] **Step 4: 写规格选择器**

创建 `storefront/src/components/product/spec-selector.tsx`：

```tsx
'use client';

import { useMemo, useState } from 'react';
import { formatPrice } from '@/lib/format';
import type { PublicProductDetail } from '@/lib/catalog';

/**
 * 规格选择器。
 *
 * 「某个组合是否存在」在前端基于已下发的 SKU 列表判断，不需要额外请求——
 * 所以详情接口必须返回完整的 SKU 与规格值对应关系。
 *
 * 切换某一维度的值时，若与其他维度的当前选择组合不存在，会自动调整为可用组合。
 */
export function SpecSelector({ product }: { product: PublicProductDetail }) {
  const [selected, setSelected] = useState<Record<string, string>>({});

  // 每个规格值 id → 它属于哪些 SKU
  const skusByValue = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const sku of product.skus) {
      for (const sv of sku.specValues) {
        const list = map.get(sv.valueId) ?? [];
        list.push(sku.id);
        map.set(sv.valueId, list);
      }
    }
    return map;
  }, [product.skus]);

  // 当前选择下命中的 SKU
  const currentSku = useMemo(() => {
    if (product.skus.length === 0) return null;
    const chosen = new Set(Object.values(selected));
    if (chosen.size !== product.specs.length) return null;
    return (
      product.skus.find((sku) => {
        const ids = sku.specValues.map((sv) => sv.valueId);
        return (
          ids.length === chosen.size &&
          ids.every((id) => chosen.has(id))
        );
      }) ?? null
    );
  }, [product.skus, product.specs.length, selected]);

  /**
   * 某个值能否选中：选它之后，其余维度是否还能凑出存在的组合。
   */
  function isSelectable(specId: string, valueId: string): boolean {
    const candidate = { ...selected, [specId]: valueId };
    const chosen = new Set(Object.values(candidate));
    if (chosen.size === product.specs.length) {
      return product.skus.some((sku) => {
        const ids = sku.specValues.map((sv) => sv.valueId);
        return ids.length === chosen.size && ids.every((id) => chosen.has(id));
      });
    }
    // 还有维度没选：只要这个值属于至少一个 SKU 就可选
    return (skusByValue.get(valueId) ?? []).length > 0;
  }

  function select(specId: string, valueId: string) {
    const candidate = { ...selected, [specId]: valueId };
    // 调整其余维度，使组合存在
    for (const spec of product.specs) {
      if (candidate[spec.id]) continue;
      const usable = spec.values.find((v) =>
        isSelectableWith(spec.id, v.id, candidate),
      );
      if (usable) candidate[spec.id] = usable.id;
    }
    setSelected(candidate);
  }

  function isSelectableWith(
    specId: string,
    valueId: string,
    candidate: Record<string, string>,
  ): boolean {
    const probe = { ...candidate, [specId]: valueId };
    const chosen = new Set(Object.values(probe));
    if (chosen.size !== product.specs.length) {
      return (skusByValue.get(valueId) ?? []).length > 0;
    }
    return product.skus.some((sku) => {
      const ids = sku.specValues.map((sv) => sv.valueId);
      return ids.length === chosen.size && ids.every((id) => chosen.has(id));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {product.specs.map((spec) => (
        <div key={spec.id} className="flex flex-col gap-2">
          <span className="text-sm font-medium">{spec.name}</span>
          <div className="flex flex-wrap gap-2">
            {spec.values.map((value) => {
              const enabled = isSelectable(spec.id, value.id);
              const active = selected[spec.id] === value.id;
              return (
                <button
                  key={value.id}
                  type="button"
                  disabled={!enabled}
                  onClick={() => select(spec.id, value.id)}
                  className={[
                    'rounded-md border px-3 py-1 text-sm',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'hover:border-primary',
                    !enabled ? 'cursor-not-allowed opacity-40' : '',
                  ].join(' ')}
                >
                  {value.value}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-primary">
          {currentSku ? formatPrice(currentSku.price) : formatPrice(product.minPrice)}
        </span>
        {currentSku?.comparePrice && currentSku.comparePrice > currentSku.price && (
          <span className="text-sm text-muted-foreground line-through">
            {formatPrice(currentSku.comparePrice)}
          </span>
        )}
      </div>

      {currentSku && (
        <p className="text-sm text-muted-foreground">
          {currentSku.stock > 0 ? `库存 ${currentSku.stock} 件` : '暂时缺货'}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 写首页**

改 `storefront/src/app/(shop)/page.tsx`：

```tsx
import { headers } from 'next/headers';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { fetchPublicCategories, fetchPublicProducts } from '@/lib/catalog';
import { ProductCard } from '@/components/product/product-card';

export default async function StorefrontHome() {
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  let products: Awaited<ReturnType<typeof fetchPublicProducts>> | null = null;
  let categories: Awaited<ReturnType<typeof fetchPublicCategories>> = [];
  let error: string | null = null;

  try {
    const [productResult, categoryResult] = await Promise.all([
      fetchPublicProducts(subdomain, { page: 1, pageSize: 24 }),
      fetchPublicCategories(subdomain),
    ]);
    products = productResult;
    categories = categoryResult;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : '商品加载失败';
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <nav className="flex flex-wrap gap-3 text-sm">
        {categories.map((category) => (
          <a key={category.id} href={`/c/${category.slug}`} className="underline">
            {category.name}
          </a>
        ))}
      </nav>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {products && products.items.length === 0 && (
        <p className="text-muted-foreground">这家店还没有上架商品。</p>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {products?.items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 6: 写品类页、搜索页、详情页**

创建 `storefront/src/app/(shop)/c/[slug]/page.tsx`：

```tsx
import { headers } from 'next/headers';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { fetchPublicProducts } from '@/lib/catalog';
import { ProductCard } from '@/components/product/product-card';

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  // Next.js 15 起 params 是异步的，必须 await
  const { slug } = await params;
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  // 品类页按 slug 查商品：公开接口目前只支持按 categoryId 过滤，
  // 这里先用公开的品类树把 slug 解析成 id，再按 id 查。
  const categories = await fetchPublicCategories(subdomain).catch(() => []);
  const flat: Array<{ id: string; slug: string; name: string; parentId: string | null }> = [];
  const walk = (nodes: typeof categories) => {
    for (const node of nodes) {
      flat.push(node);
      walk(node.children);
    }
  };
  walk(categories);
  const category = flat.find((c) => c.slug === slug);

  const products = category
    ? await fetchPublicProducts(subdomain, {
        categoryId: category.id,
        pageSize: 48,
      }).catch(() => null)
    : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{category?.name ?? '品类不存在'}</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {products?.items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </main>
  );
}
```

创建 `storefront/src/app/(shop)/search/page.tsx`：

```tsx
import { headers } from 'next/headers';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { fetchPublicProducts } from '@/lib/catalog';
import { ProductCard } from '@/components/product/product-card';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  const products = q
    ? await fetchPublicProducts(subdomain, { keyword: q, pageSize: 48 }).catch(
        () => null,
      )
    : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">
        {q ? `搜索「${q}」` : '搜索'}
      </h1>
      <form action="/search" className="flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder="搜索商品"
          className="flex-1 rounded-md border px-3 py-2"
        />
        <button type="submit" className="rounded-md bg-primary px-4 text-primary-foreground">
          搜索
        </button>
      </form>
      {products && products.items.length === 0 && (
        <p className="text-muted-foreground">没有找到相关商品。</p>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {products?.items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </main>
  );
}
```

创建 `storefront/src/app/(shop)/p/[slug]/page.tsx`：

```tsx
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { fetchPublicProduct } from '@/lib/catalog';
import { SpecSelector } from '@/components/product/spec-selector';

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  let product: Awaited<ReturnType<typeof fetchPublicProduct>> | null = null;
  try {
    product = await fetchPublicProduct(subdomain, slug);
  } catch {
    // 商品不存在或已下架：渲染 404 页面而不是错误页
    notFound();
  }

  const gallery = product.media.map((m) => m.media);
  const attributes = Object.entries(product.attributes ?? {});

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 p-6">
      <div className="grid gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          {gallery.length === 0 ? (
            <div className="aspect-square flex items-center justify-center rounded-lg bg-muted text-muted-foreground">
              暂无图片
            </div>
          ) : (
            gallery.map((media) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={media.id}
                src={media.url}
                alt={product.name}
                className="w-full rounded-lg border"
              />
            ))
          )}
        </div>

        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold">{product.name}</h1>
          {product.subtitle && (
            <p className="text-muted-foreground">{product.subtitle}</p>
          )}
          <SpecSelector product={product} />
          {product.description && (
            <p className="whitespace-pre-wrap text-sm">{product.description}</p>
          )}
          {attributes.length > 0 && (
            <table className="text-sm">
              <tbody>
                {attributes.map(([key, value]) => (
                  <tr key={key}>
                    <td className="w-24 pr-4 text-muted-foreground">{key}</td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 7: 类型检查与构建**

```bash
cd storefront && npx tsc --noEmit && npm run lint && npm run build
```

预期：全部通过。

- [ ] **Step 8: 浏览器手测**

起后端与 storefront：

```bash
cd infra && docker compose up -d postgres api
cd api && npm run start:dev
cd storefront && npm run dev
```

用浏览器打开 `http://demo.platform.test:3001`（或 `/etc/hosts` 里的本地域名），
确认：首页显示商品卡片、点进详情页能选规格、选完显示对应价格与库存、
搜索能命中。

- [ ] **Step 9: 提交**

```bash
git add storefront/src api/test
git commit -m "feat(storefront): 商品浏览页（首页、品类页、搜索、详情与规格选择器）"
```

---

## Task 11：商家后台商品管理

**Files:**
- Create: `merchant-admin/src/app/(dashboard)/products/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/products/new/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/products/[id]/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/products/import/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/categories/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/inventory/page.tsx`
- Create: `merchant-admin/src/app/api/products/route.ts`
- Create: `merchant-admin/src/app/api/products/[id]/route.ts`
- Create: `merchant-admin/src/app/api/products/[id]/specs/route.ts`
- Create: `merchant-admin/src/app/api/products/[id]/skus/[skuId]/route.ts`
- Create: `merchant-admin/src/app/api/products/batch/route.ts`
- Create: `merchant-admin/src/app/api/products/import/route.ts`
- Create: `merchant-admin/src/app/api/products/export/route.ts`
- Create: `merchant-admin/src/app/api/categories/route.ts`
- Create: `merchant-admin/src/app/api/inventory/adjustments/route.ts`
- Create: `merchant-admin/src/app/api/inventory/movements/route.ts`
- Create: `merchant-admin/src/app/api/media/upload-url/route.ts`
- Create: `merchant-admin/src/app/api/media/[id]/confirm/route.ts`
- Create: `merchant-admin/src/app/api/products/[id]/media/route.ts`
- Create: `merchant-admin/src/app/api/categories/[id]/route.ts`
- Create: `merchant-admin/src/lib/route-helpers.ts`
- Create: `merchant-admin/src/components/product/spec-matrix-editor.tsx`
- Create: `merchant-admin/src/components/product/sku-price-table.tsx`
- Create: `merchant-admin/src/components/product/product-edit-form.tsx`
- Create: `merchant-admin/src/components/product/product-list.tsx`
- Create: `merchant-admin/src/components/product/category-manager.tsx`
- Create: `merchant-admin/src/components/product/inventory-panel.tsx`
- Create: `merchant-admin/src/components/product/import-panel.tsx`
- Create: `merchant-admin/src/components/product/media-uploader.tsx`
- Create: `merchant-admin/src/components/product/format.ts`
- Modify: `merchant-admin/src/lib/api-client.ts`

### 11.1 先写后端契约测试

后台的批量操作与 CSV 导入导出在计划 2a 里只做了接口，本 Task 要做界面。
先在 `api/test/catalog.e2e-spec.ts` 里补两条契约锚点：

```typescript
  it('批量操作返回实际影响条数', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '批量契约商品', slug: `bc-${unique()}` })
      .expect(201);

    const response = await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ ids: [product.body.id], action: 'PUBLISH' })
      .expect(200);

    expect(response.body.updated).toBe(1);
  });

  it('批量改价缺少 mode 时返回 400', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ ids: ['whatever'], action: 'ADJUST_PRICE' })
      .expect(400);
  });
```

- [ ] **Step 1.2: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog.e2e-spec.ts
```

预期：PASS。

- [ ] **Step 2: 写同源中转路由**

后台的所有写操作都要走同源中转。模式与阶段 1 的 `api/stores/me/route.ts` 完全一致：
从 `auth()` 拿 token，在服务端调后端，绝不把 accessToken 暴露给浏览器。

创建 `merchant-admin/src/app/api/products/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ApiError, apiFetch } from '@/lib/api-client';

/**
 * 商品列表的中转接口（GET）与创建（POST）。
 *
 * 为什么不直接调后端：后端没开 CORS，浏览器直连会被预检拦掉；
 * 而且 accessToken 不应该出现在客户端代码里。
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.toString();

  try {
    const result = await apiFetch(`/catalog/products${query ? `?${query}` : ''}`, {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }

  const body = await readJson(request);

  try {
    const result = await apiFetch('/catalog/products', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

把两个公共辅助抽到 `merchant-admin/src/lib/route-helpers.ts`：

```typescript
import { NextResponse } from 'next/server';
import { ApiError } from './api-client';

/** 读请求体；非法 JSON 返回 null */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 把后端错误转成同源响应。内部细节不泄给浏览器。 */
export function toErrorResponse(cause: unknown): NextResponse {
  if (cause instanceof ApiError) {
    return NextResponse.json(
      { message: cause.message, code: cause.code },
      { status: cause.status },
    );
  }
  return NextResponse.json({ message: '后端服务不可用' }, { status: 502 });
}
```

其余中转路由。**每个文件都是完整的，不复用上一个**——实施者可能只读其中一个。

创建 `merchant-admin/src/app/api/products/[id]/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse } from '@/lib/route-helpers';

/** 商品详情 / 更新 / 删除的中转 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const { id } = await params;

  try {
    const result = await apiFetch(`/catalog/products/${id}`, {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const { id } = await params;
  const body = await readJson(request);

  try {
    const result = await apiFetch(`/catalog/products/${id}`, {
      method: 'PATCH',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const { id } = await params;

  try {
    await apiFetch(`/catalog/products/${id}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

创建 `merchant-admin/src/app/api/products/[id]/specs/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse } from '@/lib/route-helpers';

/** 规格矩阵整体替换的中转 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const { id } = await params;
  const body = await readJson(request);

  try {
    const result = await apiFetch(`/catalog/products/${id}/specs`, {
      method: 'PUT',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

创建 `merchant-admin/src/app/api/products/[id]/skus/[skuId]/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse } from '@/lib/route-helpers';

/** 单个 SKU 的价格 / 编码 / 启用状态更新 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; skuId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const { id, skuId } = await params;
  const body = await readJson(request);

  try {
    const result = await apiFetch(
      `/catalog/products/${id}/skus/${skuId}`,
      { method: 'PATCH', body, token: session.accessToken },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

创建 `merchant-admin/src/app/api/products/batch/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse } from '@/lib/route-helpers';

/** 批量操作的中转 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const body = await readJson(request);

  try {
    const result = await apiFetch('/catalog/products/batch', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

创建 `merchant-admin/src/app/api/categories/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse } from '@/lib/route-helpers';

/** 品类树查询与创建 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }

  try {
    const result = await apiFetch('/catalog/categories', {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const body = await readJson(request);

  try {
    const result = await apiFetch('/catalog/categories', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

创建 `merchant-admin/src/app/api/inventory/adjustments/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse } from '@/lib/route-helpers';

/** 库存调整的中转 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const body = await readJson(request);

  try {
    const result = await apiFetch('/inventory/adjustments', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

创建 `merchant-admin/src/app/api/media/upload-url/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse } from '@/lib/route-helpers';

/** 签发上传凭证的中转 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const body = await readJson(request);

  try {
    const result = await apiFetch('/media/upload-url', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

创建 `merchant-admin/src/app/api/media/[id]/confirm/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse } from '@/lib/route-helpers';

/** 确认上传完成的中转 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const { id } = await params;

  try {
    const result = await apiFetch(`/media/${id}/confirm`, {
      method: 'POST',
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

创建 `merchant-admin/src/app/api/products/[id]/media/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse } from '@/lib/route-helpers';

/** 设置商品媒体列表的中转 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const { id } = await params;
  const body = await readJson(request);

  try {
    const result = await apiFetch(`/catalog/products/${id}/media`, {
      method: 'PUT',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

创建 `merchant-admin/src/app/api/inventory/movements/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse } from '@/lib/route-helpers';

/** 库存流水查询的中转 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }

  const query = new URL(request.url).searchParams.toString();

  try {
    const result = await apiFetch(
      `/inventory/movements${query ? `?${query}` : ''}`,
      { token: session.accessToken },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

> **`[id]` 与 `batch` 的路由冲突**：`api/products/batch/route.ts` 与
> `api/products/[id]/route.ts` 是不同的路径，Next.js 会优先匹配静态段
> `batch`，不冲突。
>
> **`[id]` 会匹配 `import` 与 `export`**：`api/products/import/route.ts` 与
> `api/products/export/route.ts` 是静态段，同样优先于 `[id]`。不冲突。

- [ ] **Step 3: 写 CSV 导入导出**

创建 `merchant-admin/src/app/api/products/export/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ApiError, apiFetch } from '@/lib/api-client';

interface ExportProduct {
  id: string;
  name: string;
  slug: string;
  status: string;
  attributes: Record<string, string>;
  minPrice: number;
}

/**
 * 导出商品 CSV。
 *
 * 只导出基础信息——规格矩阵与媒体用扁平表格表达会立刻变得不可读，
 * 那部分走 JSON 或留到后面。
 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }

  try {
    const result = await apiFetch<{ items: ExportProduct[] }>(
      '/catalog/products?pageSize=100',
      { token: session.accessToken },
    );

    const header = ['名称', 'slug', '状态', '最低价(分)', '描述性属性(JSON)'];
    const rows = result.items.map((p) => [
      p.name,
      p.slug,
      p.status,
      String(p.minPrice),
      JSON.stringify(p.attributes ?? {}),
    ]);

    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((cell) => {
            // 含逗号、引号、换行的单元格要用双引号包起来，内部引号翻倍
            const text = String(cell);
            return /[",\n]/.test(text)
              ? `"${text.replace(/"/g, '""')}"`
              : text;
          })
          .join(','),
      )
      .join('\n');

    // BOM 头：Excel 打开中文 CSV 不加 BOM 会乱码
    return new NextResponse(`﻿${csv}`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="products.csv"`,
      },
    });
  } catch (cause) {
    if (cause instanceof ApiError) {
      return NextResponse.json(
        { message: cause.message },
        { status: cause.status },
      );
    }
    return NextResponse.json({ message: '后端服务不可用' }, { status: 502 });
  }
}
```

创建 `merchant-admin/src/app/api/products/import/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ApiError, apiFetch } from '@/lib/api-client';
import { readJson } from '@/lib/route-helpers';

interface ImportResult {
  row: number;
  ok: boolean;
  name?: string;
  error?: string;
}

/**
 * CSV 导入商品基础信息。
 *
 * 逐行独立：某一行失败不影响其他行，响应返回每行的结果。
 * 只支持基础信息（名称、slug、品类、描述性属性）——
 * 规格矩阵的导入用扁平表格表达会立刻不可读，那部分不做。
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }

  const body = await readJson(request);
  const csv = (body as { csv?: unknown } | null)?.csv;
  if (typeof csv !== 'string' || csv.trim() === '') {
    return NextResponse.json({ message: '缺少 csv 字段' }, { status: 400 });
  }

  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return NextResponse.json(
      { message: 'CSV 至少要有表头和一行数据' },
      { status: 400 },
    );
  }

  const results: ImportResult[] = [];

  for (const [index, line] of lines.slice(1).entries()) {
    const row = index + 2; // 表头占第 1 行
    const cells = splitCsvLine(line);

    const [name, slug, categoryId, attributesJson] = cells;

    if (!name || !slug) {
      results.push({ row, ok: false, error: '名称与 slug 不能为空' });
      continue;
    }

    let attributes: Record<string, string> = {};
    if (attributesJson) {
      try {
        const parsed = JSON.parse(attributesJson);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          attributes = parsed as Record<string, string>;
        }
      } catch {
        results.push({ row, ok: false, name, error: '描述性属性不是合法 JSON' });
        continue;
      }
    }

    try {
      await apiFetch('/catalog/products', {
        method: 'POST',
        body: {
          name,
          slug,
          ...(categoryId ? { categoryId } : {}),
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        },
        token: session.accessToken,
      });
      results.push({ row, ok: true, name });
    } catch (cause) {
      results.push({
        row,
        ok: false,
        name,
        error:
          cause instanceof ApiError ? cause.message : '创建失败，请稍后重试',
      });
    }
  }

  return NextResponse.json({
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}

/** 解析一行 CSV：支持双引号包裹与内部引号翻倍 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}
```

- [ ] **Step 4: 写商品列表页**

创建 `merchant-admin/src/app/(dashboard)/products/page.tsx`：

```tsx
import { apiFetchAuthed } from '@/lib/api-client';
import { ProductList } from '@/components/product/product-list';

interface ProductListResponse {
  items: Array<{
    id: string;
    name: string;
    slug: string;
    status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
    minPrice: number;
    category: { id: string; name: string } | null;
    createdAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; status?: string }>;
}) {
  const { keyword, status } = await searchParams;

  let data: ProductListResponse | null = null;
  let error: string | null = null;

  try {
    const params = new URLSearchParams();
    if (keyword) params.set('keyword', keyword);
    if (status) params.set('status', status);
    const suffix = params.toString();
    data = await apiFetchAuthed<ProductListResponse>(
      `/catalog/products${suffix ? `?${suffix}` : ''}`,
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : '商品加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">商品</h2>
        <div className="flex gap-2">
          <a href="/products/import" className="rounded-md border px-3 py-1.5 text-sm">
            CSV 导入
          </a>
          <a href="/products/new" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
            新建商品
          </a>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && <ProductList initial={data} />}
    </div>
  );
}
```

创建 `merchant-admin/src/components/product/product-list.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatPrice } from './format';

interface Row {
  id: string;
  name: string;
  slug: string;
  status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
  minPrice: number;
  category: { id: string; name: string } | null;
}

const STATUS_LABEL: Record<Row['status'], string> = {
  DRAFT: '草稿',
  PUBLISHED: '已上架',
  UNPUBLISHED: '已下架',
};

/**
 * 商品列表与批量操作。
 *
 * 所有写操作走同源中转路由 /api/products/*——浏览器不能直连后端（没有 CORS）。
 */
export function ProductList({
  initial,
}: {
  initial: { items: Row[]; total: number };
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function runBatch(action: string) {
    if (selected.size === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/products/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], action }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? '批量操作失败');
      }
      setSelected(new Set());
      setMessage(`已处理 ${payload.updated} 个商品`);
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '批量操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">
          已选 {selected.size} 个
        </span>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => runBatch('PUBLISH')}
          className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          批量上架
        </button>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => runBatch('UNPUBLISH')}
          className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          批量下架
        </button>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => runBatch('DELETE')}
          className="rounded-md border px-3 py-1.5 text-sm text-destructive disabled:opacity-40"
        >
          批量删除
        </button>
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="w-10" />
            <th>名称</th>
            <th>品类</th>
            <th>最低价</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {initial.items.map((row) => (
            <tr key={row.id} className="border-b">
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => toggle(row.id)}
                />
              </td>
              <td>
                <a href={`/products/${row.id}`} className="underline">
                  {row.name}
                </a>
              </td>
              <td>{row.category?.name ?? '—'}</td>
              <td>{formatPrice(row.minPrice)}</td>
              <td>{STATUS_LABEL[row.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

创建 `merchant-admin/src/components/product/format.ts`：

```typescript
/** 金额：分 → 「¥59.00」 */
export function formatPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `¥${(cents / 100).toFixed(2)}`;
}
```

> **两个前端项目不共享代码**（设计文档 §4.1），所以 `formatPrice` 在
> storefront 与 merchant-admin 各有一份。

- [ ] **Step 5: 写规格矩阵编辑器**

这是后台最复杂的一块。创建
`merchant-admin/src/components/product/spec-matrix-editor.tsx`：

```tsx
'use client';

import { useMemo, useState } from 'react';

interface SpecValue {
  id: string;
  value: string;
  sort: number;
}

interface Spec {
  id: string;
  name: string;
  sort: number;
  values: SpecValue[];
}

interface Sku {
  id: string;
  price: number;
  comparePrice: number | null;
  code: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  specValues: Array<{ valueId: string }>;
}

export interface SpecDraft {
  name: string;
  values: string[];
}

/**
 * 规格矩阵编辑器。
 *
 * 前端算笛卡尔积只是**预览**——真正生成 SKU 是后端的事
 * （PUT /catalog/products/:id/specs）。前端不提交 SKU 列表，
 * 只提交规格结构，价格与编码在 SKU 表格里单独改。
 */
export function SpecMatrixEditor({
  specs,
  skus,
  onSubmit,
}: {
  specs: Spec[];
  skus: Sku[];
  onSubmit: (draft: SpecDraft[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SpecDraft[]>(
    specs.map((s) => ({ name: s.name, values: s.values.map((v) => v.value) })),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /** 笛卡尔积预览 */
  const comboCount = useMemo(() => {
    return draft.reduce((acc, dim) => {
      if (dim.values.length === 0) return 0;
      return acc * dim.values.length;
    }, 1);
  }, [draft]);

  function addSpec() {
    if (draft.length >= 2) return;
    setDraft((prev) => [...prev, { name: '', values: [] }]);
  }

  function updateSpec(index: number, patch: Partial<SpecDraft>) {
    setDraft((prev) =>
      prev.map((dim, i) => (i === index ? { ...dim, ...patch } : dim)),
    );
  }

  function addValue(index: number) {
    updateSpec(index, {
      values: [...draft[index].values, ''],
    });
  }

  function updateValue(specIndex: number, valueIndex: number, text: string) {
    updateSpec(specIndex, {
      values: draft[specIndex].values.map((v, i) =>
        i === valueIndex ? text : v,
      ),
    });
  }

  function removeSpec(index: number) {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  }

  function removeValue(specIndex: number, valueIndex: number) {
    updateSpec(specIndex, {
      values: draft[specIndex].values.filter((_, i) => i !== valueIndex),
    });
  }

  async function handleSubmit() {
    setBusy(true);
    setMessage(null);
    try {
      await onSubmit(
        draft
          .filter((dim) => dim.name.trim() && dim.values.length > 0)
          .map((dim) => ({
            name: dim.name.trim(),
            values: dim.values.map((v) => v.trim()).filter(Boolean),
          })),
      );
      setMessage('规格已保存');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold">规格</h3>

      {draft.map((dim, specIndex) => (
        <div key={specIndex} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <input
              value={dim.name}
              placeholder="规格名，如「颜色」"
              onChange={(e) => updateSpec(specIndex, { name: e.target.value })}
              className="flex-1 rounded-md border px-2 py-1"
            />
            <button
              type="button"
              onClick={() => removeSpec(specIndex)}
              className="text-sm text-destructive"
            >
              删除维度
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {dim.values.map((value, valueIndex) => (
              <div key={valueIndex} className="flex items-center gap-1">
                <input
                  value={value}
                  placeholder="值，如「红色」"
                  onChange={(e) => updateValue(specIndex, valueIndex, e.target.value)}
                  className="w-28 rounded-md border px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  onClick={() => removeValue(specIndex, valueIndex)}
                  className="text-xs text-muted-foreground"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => addValue(specIndex)}
              className="rounded-md border px-2 py-1 text-sm"
            >
              加值
            </button>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={addSpec}
          disabled={draft.length >= 2}
          className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          加规格维度
        </button>
        <span className="text-sm text-muted-foreground">
          将生成 {comboCount} 个 SKU
        </span>
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={busy}
        className="w-fit rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40"
      >
        {busy ? '保存中…' : '保存规格'}
      </button>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      {skus.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="font-medium">SKU（{skus.length}）</h4>
          <p className="text-xs text-muted-foreground">
            价格与库存分开维护：库存只能通过「库存」页调整（有流水审计）。
          </p>
        </div>
      )}
    </section>
  );
}
```

> **SKU 表格的价格编辑**放在商品编辑页的另一个组件里（`sku-price-table.tsx`），
> 逐行 PATCH `/catalog/products/:productId/skus/:skuId`。这里不重复实现，
> 避免一个组件干两件事。

- [ ] **Step 5.5: 写媒体上传组件**

创建 `merchant-admin/src/components/product/media-uploader.tsx`：

```tsx
'use client';

import { useRef, useState } from 'react';

interface MediaItem {
  id: string;
  url: string;
}

/**
 * 商品媒体上传。
 *
 * 流程是「后端签发凭证 → 浏览器直传 MinIO → 回调确认」：
 * 1. POST /api/media/upload-url 拿到 presigned PUT URL 与 mediaId；
 * 2. 用 XMLHttpRequest 把文件 PUT 上去（fetch 没有上传进度事件）；
 * 3. POST /api/media/:id/confirm 让后端 HEAD 对象确认存在与大小。
 *
 * 数组顺序即封面顺序——第一个是封面。
 */
export function MediaUploader({
  productId,
  initial,
}: {
  productId: string;
  initial: MediaItem[];
}) {
  const [items, setItems] = useState<MediaItem[]>(initial);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * 直传一个文件到 MinIO。
   *
   * 用 XMLHttpRequest 而不是 fetch：fetch 没有上传进度事件，
   * 商家看不到上传到哪儿了。失败可以重试——同一个 presigned URL
   * 在有效期内可以重复 PUT 同一个 key。
   */
  async function uploadOne(file: File): Promise<MediaItem> {
    const signed = await fetch('/api/media/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        mime: file.type,
        size: file.size,
      }),
    });
    const payload = await signed.json();
    if (!signed.ok) {
      throw new Error(payload.message ?? '获取上传凭证失败');
    }

    const uploadUrl = payload.uploadUrl as string;
    const mediaId = payload.media.id as string;

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('content-type', file.type);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          setProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`上传失败（HTTP ${xhr.status}）`));
        }
      };
      xhr.onerror = () => reject(new Error('上传失败：网络错误'));
      xhr.send(file);
    });

    const confirmed = await fetch(`/api/media/${mediaId}/confirm`, {
      method: 'POST',
    });
    const confirmedPayload = await confirmed.json();
    if (!confirmed.ok) {
      throw new Error(confirmedPayload.message ?? '确认上传失败');
    }

    return { id: mediaId, url: confirmedPayload.url as string };
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setMessage(null);
    setProgress(0);
    try {
      const uploaded: MediaItem[] = [];
      for (const file of Array.from(files)) {
        uploaded.push(await uploadOne(file));
      }
      const next = [...items, ...uploaded];
      setItems(next);
      await save(next);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '上传失败');
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  /** 把媒体顺序写回后端 */
  async function save(next: MediaItem[]) {
    const response = await fetch(`/api/products/${productId}/media`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaIds: next.map((m) => m.id) }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message ?? '保存媒体列表失败');
    }
    // 不刷新页面：本地状态已经是保存后的结果。
    // 也不能在 Server Component 里调 router.refresh()——那是客户端 hook。
  }

  async function move(index: number, delta: number) {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    await save(next).catch((cause: unknown) => {
      setMessage(cause instanceof Error ? cause.message : '排序失败');
    });
  }

  async function remove(index: number) {
    const next = items.filter((_, i) => i !== index);
    setItems(next);
    await save(next).catch((cause: unknown) => {
      setMessage(cause instanceof Error ? cause.message : '删除失败');
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold">商品图片</h3>
      <p className="text-xs text-muted-foreground">
        第一张是封面。只接受 jpeg / png / webp / gif，单张不超过 5MB。
      </p>

      <div className="grid grid-cols-4 gap-3">
        {items.map((item, index) => (
          <div key={item.id} className="flex flex-col gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.url}
              alt={`商品图 ${index + 1}`}
              className="aspect-square w-full rounded-md border object-cover"
            />
            <div className="flex gap-1 text-xs">
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                className="rounded border px-1.5 py-0.5 disabled:opacity-40"
              >
                前移
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === items.length - 1}
                className="rounded border px-1.5 py-0.5 disabled:opacity-40"
              >
                后移
              </button>
              <button
                type="button"
                onClick={() => remove(index)}
                className="rounded border px-1.5 py-0.5 text-destructive"
              >
                移除
              </button>
            </div>
            {index === 0 && (
              <span className="text-xs text-muted-foreground">封面</span>
            )}
          </div>
        ))}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        onChange={(e) => void handleFiles(e.target.files)}
        className="text-sm"
      />

      {progress !== null && (
        <p className="text-sm text-muted-foreground">上传中…{progress}%</p>
      )}
      {message && <p className="text-sm text-destructive">{message}</p>}
    </section>
  );
}
```

在商品编辑页里挂上（在 `ProductEditForm` 之后）：

```tsx
          <MediaUploader
            productId={product.id}
            initial={product.media.map((m) => ({
              id: m.media.id,
              url: m.media.url,
            }))}
          />
```

**商品详情的 media 结构要改成带 id 的形式**——`products.controller.ts` 的
`findOne` 里 `media: { orderBy: { sort: 'asc' } }` 返回的是 `ProductMedia` 数组，
每项有 `id`（ProductMedia 的 id）和 `media`（关联的 Media）。所以映射要用
`m.media.id` 与 `m.media.url`：

```tsx
initial={product.media.map((m) => ({
  id: m.media.id,
  url: m.media.url,
}))}
```

- [ ] **Step 6: 写商品编辑页**

创建 `merchant-admin/src/app/(dashboard)/products/[id]/page.tsx`：

```tsx
import { apiFetchAuthed } from '@/lib/api-client';
import { SpecMatrixEditor, type SpecDraft } from '@/components/product/spec-matrix-editor';
import { ProductEditForm } from '@/components/product/product-edit-form';

interface ProductDetail {
  id: string;
  name: string;
  slug: string;
  subtitle: string | null;
  description: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
  version: number;
  attributes: Record<string, string>;
  categoryId: string | null;
  media: Array<{
    id: string;
    sort: number;
    media: { id: string; url: string; mime: string };
  }>;
  specs: Array<{
    id: string;
    name: string;
    sort: number;
    values: Array<{ id: string; value: string; sort: number }>;
  }>;
  skus: Array<{
    id: string;
    price: number;
    comparePrice: number | null;
    code: string | null;
    status: 'ACTIVE' | 'INACTIVE';
    specValues: Array<{ valueId: string }>;
  }>;
}

export default async function ProductEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let product: ProductDetail | null = null;
  let categories: CategoryOption[] = [];
  let error: string | null = null;

  try {
    const [detail, categoryTree] = await Promise.all([
      apiFetchAuthed<ProductDetail>(`/catalog/products/${id}`),
      apiFetchAuthed<CategoryOption[]>('/catalog/categories'),
    ]);
    product = detail;
    categories = categoryTree;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : '商品加载失败';
  }

  async function replaceSpecs(draft: SpecDraft[]) {
    const response = await fetch(`/api/products/${id}/specs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: product?.version, specs: draft }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message ?? '保存规格失败');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">编辑商品</h2>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {product && (
        <>
          <ProductEditForm product={product} categories={categories} />
          <SpecMatrixEditor
            specs={product.specs}
            skus={product.skus}
            onSubmit={replaceSpecs}
          />
          <SkuPriceTable
            productId={product.id}
            skus={product.skus}
            values={product.specs.flatMap((spec) => spec.values)}
          />
        </>
      )}
    </div>
  );
}
```

**补上缺失的 import**（页面文件头部）：

```tsx
import { apiFetchAuthed } from '@/lib/api-client';
import { SpecMatrixEditor, type SpecDraft } from '@/components/product/spec-matrix-editor';
import { ProductEditForm, type CategoryOption } from '@/components/product/product-edit-form';
import { SkuPriceTable } from '@/components/product/sku-price-table';
```

> `CategoryOption` 类型要从 `product-edit-form.tsx` 导出——把它定义在那个文件里
> 并 `export`，页面从那里 import。

创建 `merchant-admin/src/components/product/product-edit-form.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface ProductDetail {
  id: string;
  name: string;
  slug: string;
  subtitle: string | null;
  description: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
  version: number;
  attributes: Record<string, string>;
  categoryId: string | null;
}

export interface CategoryOption {
  id: string;
  name: string;
  parentId: string | null;
  children: CategoryOption[];
}

/**
 * 商品基本信息表单。
 *
 * ⚠️ 保存时**必须带上 version**——否则并发编辑会静默覆盖后保存的人的内容。
 * 后端在 version 不匹配时返回 409，这里把它转成一句用户看得懂的话。
 */
export function ProductEditForm({
  product,
  categories,
}: {
  product: ProductDetail;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [name, setName] = useState(product.name);
  const [subtitle, setSubtitle] = useState(product.subtitle ?? '');
  const [description, setDescription] = useState(product.description ?? '');
  const [categoryId, setCategoryId] = useState(product.categoryId ?? '');
  const [status, setStatus] = useState(product.status);
  const [attributeText, setAttributeText] = useState(
    Object.entries(product.attributes ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /** 把「材质: 纯棉」这样的多行文本解析成对象 */
  function parseAttributes(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const separator = trimmed.indexOf(':');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key && value) result[key] = value;
    }
    return result;
  }

  async function handleSave() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          subtitle,
          description,
          categoryId: categoryId || null,
          status,
          attributes: parseAttributes(attributeText),
          version: product.version,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? '商品已被他人修改，请刷新页面后重试'
            : (payload.message ?? '保存失败'),
        );
      }
      setMessage('已保存');
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  // 品类树拍平成带缩进前缀的选项
  const flatCategories: Array<{ id: string; label: string }> = [];
  const walk = (nodes: CategoryOption[], depth: number) => {
    for (const node of nodes) {
      flatCategories.push({
        id: node.id,
        label: `${'　'.repeat(depth)}${node.name}`,
      });
      walk(node.children, depth + 1);
    }
  };
  walk(categories, 0);

  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold">基本信息</h3>

      <label className="flex flex-col gap-1 text-sm">
        <span>名称</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border px-3 py-2"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>副标题</span>
        <input
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          className="rounded-md border px-3 py-2"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>描述</span>
        <textarea
          value={description}
          rows={4}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border px-3 py-2"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>品类</span>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="rounded-md border px-3 py-2"
        >
          <option value="">未分类</option>
          {flatCategories.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>状态</span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as ProductDetail['status'])}
          className="rounded-md border px-3 py-2"
        >
          <option value="DRAFT">草稿</option>
          <option value="PUBLISHED">已上架</option>
          <option value="UNPUBLISHED">已下架</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>描述性属性（每行一条，格式「名称: 值」）</span>
        <textarea
          value={attributeText}
          rows={4}
          onChange={(e) => setAttributeText(e.target.value)}
          className="rounded-md border px-3 py-2"
          placeholder={'材质: 纯棉\n产地: 浙江'}
        />
      </label>

      <button
        type="button"
        onClick={handleSave}
        disabled={busy}
        className="w-fit rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40"
      >
        {busy ? '保存中…' : '保存'}
      </button>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </section>
  );
}
```

**SKU 价格表格**——单独一个组件，逐行 PATCH：

创建 `merchant-admin/src/components/product/sku-price-table.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatPrice } from './format';

interface Sku {
  id: string;
  price: number;
  comparePrice: number | null;
  code: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  specValues: Array<{ valueId: string }>;
}

interface SpecValue {
  id: string;
  value: string;
}

/**
 * SKU 的价格 / 划线价 / 编码 / 启用状态编辑。
 *
 * 与规格矩阵编辑器分开的原因：规格矩阵管的是「有哪些 SKU」，
 * 这里管的是「每个 SKU 值多少钱」。两件事的频率与风险都不同。
 *
 * 库存不在这里改——库存只能走库存调整接口（有流水审计）。
 */
export function SkuPriceTable({
  productId,
  skus,
  values,
}: {
  productId: string;
  skus: Sku[];
  values: SpecValue[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const valueName = new Map(values.map((v) => [v.id, v.value]));

  /** 把 SKU 的规格值 id 拼成「红色 / M」这样的可读标签 */
  function labelOf(sku: Sku): string {
    return sku.specValues
      .map((sv) => valueName.get(sv.valueId) ?? '?')
      .join(' / ');
  }

  async function patchSku(
    skuId: string,
    patch: Record<string, unknown>,
  ) {
    setBusyId(skuId);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/products/${productId}/skus/${skuId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? '保存失败');
      }
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h4 className="font-medium">SKU 价格（{skus.length}）</h4>
      <p className="text-xs text-muted-foreground">
        库存不在这里改——库存只能通过「库存」页调整，保留完整流水。
      </p>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th>规格</th>
            <th>售价（分）</th>
            <th>划线价（分）</th>
            <th>编码</th>
            <th>启用</th>
          </tr>
        </thead>
        <tbody>
          {skus.map((sku) => (
            <tr key={sku.id} className="border-b">
              <td>{labelOf(sku)}</td>
              <td>
                <input
                  type="number"
                  defaultValue={sku.price}
                  onBlur={(e) =>
                    patchSku(sku.id, { price: Number(e.target.value) })
                  }
                  className="w-24 rounded-md border px-2 py-1"
                />
                <span className="ml-2 text-muted-foreground">
                  {formatPrice(sku.price)}
                </span>
              </td>
              <td>
                <input
                  type="number"
                  defaultValue={sku.comparePrice ?? 0}
                  onBlur={(e) =>
                    patchSku(sku.id, {
                      comparePrice: Number(e.target.value),
                    })
                  }
                  className="w-24 rounded-md border px-2 py-1"
                />
              </td>
              <td>
                <input
                  type="text"
                  defaultValue={sku.code ?? ''}
                  onBlur={(e) =>
                    patchSku(sku.id, { code: e.target.value || undefined })
                  }
                  className="w-28 rounded-md border px-2 py-1"
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={sku.status === 'ACTIVE'}
                  onChange={(e) =>
                    patchSku(sku.id, {
                      status: e.target.checked ? 'ACTIVE' : 'INACTIVE',
                    })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </section>
  );
}
```

在商品编辑页里把 `SkuPriceTable` 挂上（`ProductEditForm` 之后）：

```tsx
          <SkuPriceTable
            productId={product.id}
            skus={product.skus}
            values={product.specs.flatMap((spec) => spec.values)}
          />
```

- [ ] **Step 7: 写品类页**

创建 `merchant-admin/src/app/(dashboard)/categories/page.tsx`：

```tsx
import { apiFetchAuthed } from '@/lib/api-client';
import { CategoryManager } from '@/components/product/category-manager';

interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  sort: number;
  children: CategoryNode[];
}

export default async function CategoriesPage() {
  let tree: CategoryNode[] = [];
  let error: string | null = null;

  try {
    tree = await apiFetchAuthed<CategoryNode[]>('/catalog/categories');
  } catch (cause) {
    error = cause instanceof Error ? cause.message : '品类加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">品类</h2>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <CategoryManager initial={tree} />
    </div>
  );
}
```

创建 `merchant-admin/src/components/product/category-manager.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  sort: number;
  children: CategoryNode[];
}

/** 品类树管理：新增、删除、改名。层级最多 3 层由后端校验。 */
export function CategoryManager({ initial }: { initial: CategoryNode[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState<{ parentId: string | null } | null>(
    null,
  );
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim() || !slug.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          ...(adding?.parentId ? { parentId: adding.parentId } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? '创建失败');
      }
      setAdding(null);
      setName('');
      setSlug('');
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('确定删除这个品类？有子品类或商品的品类删不掉。')) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? '删除失败');
      }
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '删除失败');
    }
  }

  function renderNode(node: CategoryNode, depth: number) {
    return (
      <li key={node.id} className="flex flex-col gap-1">
        <div
          className="flex items-center gap-2"
          style={{ paddingLeft: `${depth * 20}px` }}
        >
          <span>{node.name}</span>
          <span className="text-xs text-muted-foreground">/{node.slug}</span>
          <button
            type="button"
            onClick={() => {
              setAdding({ parentId: node.id });
              setName('');
              setSlug('');
            }}
            className="text-xs underline"
          >
            加子品类
          </button>
          <button
            type="button"
            onClick={() => remove(node.id)}
            className="text-xs text-destructive underline"
          >
            删除
          </button>
        </div>
        {node.children.length > 0 && (
          <ul className="flex flex-col gap-1">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1">
        {initial.map((node) => renderNode(node, 0))}
      </ul>

      {adding === null ? (
        <button
          type="button"
          onClick={() => setAdding({ parentId: null })}
          className="w-fit rounded-md border px-3 py-1.5 text-sm"
        >
          新增一级品类
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex gap-2">
            <input
              value={name}
              placeholder="品类名"
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border px-2 py-1"
            />
            <input
              value={slug}
              placeholder="slug（小写字母、数字、连字符）"
              onChange={(e) => setSlug(e.target.value)}
              className="rounded-md border px-2 py-1"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => setAdding(null)}
              className="rounded-md border px-3 py-1.5 text-sm"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
```

> **品类删除走 `DELETE /api/categories/:id`**，这个中转路由也要建。
> 前面 Step 2 只列了 `api/categories/route.ts`（列表与创建），
> **删除与改名要另建** `api/categories/[id]/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse } from '@/lib/route-helpers';

/** 品类改名与删除的中转 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const { id } = await params;
  const body = await readJson(request);

  try {
    const result = await apiFetch(`/catalog/categories/${id}`, {
      method: 'PATCH',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
  }
  const { id } = await params;

  try {
    await apiFetch(`/catalog/categories/${id}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

- [ ] **Step 7.2: 写库存页**

创建 `merchant-admin/src/app/(dashboard)/inventory/page.tsx`：

```tsx
import { apiFetchAuthed } from '@/lib/api-client';
import { InventoryPanel } from '@/components/product/inventory-panel';

interface SkuRow {
  skuId: string;
  code: string | null;
  stock: number;
  status: string;
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ productId?: string }>;
}) {
  const { productId } = await searchParams;

  let skus: SkuRow[] = [];
  let error: string | null = null;

  if (productId) {
    try {
      skus = await apiFetchAuthed<SkuRow[]>(
        `/inventory/summary?productId=${productId}`,
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '库存加载失败';
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">库存</h2>
      <p className="text-sm text-muted-foreground">
        从商品编辑页进入可带上商品参数；没有商品参数时下方只能看流水。
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <InventoryPanel skus={skus} productId={productId ?? ''} />
    </div>
  );
}
```

创建 `merchant-admin/src/components/product/inventory-panel.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface SkuRow {
  skuId: string;
  code: string | null;
  stock: number;
  status: string;
}

interface Movement {
  id: string;
  skuId: string;
  type: string;
  quantity: number;
  stockBefore: number;
  stockAfter: number;
  reason: string | null;
  createdAt: string;
}

/**
 * 库存调整与流水台账。
 *
 * 库存**只能**从这里改——每一次改动都会留下一条流水（append-only）。
 * 流水没有修改与删除接口，这是审计要求。
 */
export function InventoryPanel({
  skus,
  productId,
}: {
  skus: SkuRow[];
  productId: string;
}) {
  const router = useRouter();
  const [skuId, setSkuId] = useState(skus[0]?.skuId ?? '');
  const [type, setType] = useState<'ADJUST_IN' | 'ADJUST_OUT' | 'CHECK'>(
    'ADJUST_IN',
  );
  const [quantity, setQuantity] = useState(0);
  const [reason, setReason] = useState('');
  const [movements, setMovements] = useState<Movement[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function loadMovements(targetSkuId: string) {
    if (!targetSkuId) return;
    try {
      const response = await fetch(
        `/api/inventory/movements?skuId=${targetSkuId}`,
      );
      const payload = await response.json();
      if (response.ok) {
        setMovements(payload.items ?? []);
      }
    } catch {
      // 流水拉不到不阻塞调整操作
    }
  }

  async function adjust() {
    if (!skuId) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/inventory/adjustments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          skuId,
          type,
          quantity,
          ...(reason ? { reason } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? '调整失败');
      }
      setMessage('已调整');
      await loadMovements(skuId);
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '调整失败');
    } finally {
      setBusy(false);
    }
  }

  const TYPE_LABEL: Record<string, string> = {
    ADJUST_IN: '入库',
    ADJUST_OUT: '出库',
    CHECK: '盘点',
  };

  return (
    <div className="flex flex-col gap-6">
      {skus.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="font-medium">库存调整</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span>SKU</span>
              <select
                value={skuId}
                onChange={(e) => {
                  setSkuId(e.target.value);
                  void loadMovements(e.target.value);
                }}
                className="rounded-md border px-2 py-1"
              >
                {skus.map((sku) => (
                  <option key={sku.skuId} value={sku.skuId}>
                    {sku.code ?? sku.skuId}（当前 {sku.stock}）
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>类型</span>
              <select
                value={type}
                onChange={(e) =>
                  setType(e.target.value as 'ADJUST_IN' | 'ADJUST_OUT' | 'CHECK')
                }
                className="rounded-md border px-2 py-1"
              >
                <option value="ADJUST_IN">入库</option>
                <option value="ADJUST_OUT">出库</option>
                <option value="CHECK">盘点</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>{type === 'CHECK' ? '盘点后库存' : '数量'}</span>
              <input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                className="w-28 rounded-md border px-2 py-1"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>原因</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="rounded-md border px-2 py-1"
              />
            </label>

            <button
              type="button"
              onClick={adjust}
              disabled={busy}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
            >
              {busy ? '提交中…' : '提交调整'}
            </button>
          </div>
          {message && <p className="text-sm text-muted-foreground">{message}</p>}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">库存流水</h3>
        {movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有流水记录。</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th>时间</th>
                <th>类型</th>
                <th>变动</th>
                <th>前 → 后</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id} className="border-b">
                  <td>{new Date(movement.createdAt).toLocaleString('zh-CN')}</td>
                  <td>{TYPE_LABEL[movement.type] ?? movement.type}</td>
                  <td>
                    {movement.quantity > 0 ? '+' : ''}
                    {movement.quantity}
                  </td>
                  <td>
                    {movement.stockBefore} → {movement.stockAfter}
                  </td>
                  <td>{movement.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 7.3: 写 CSV 导入页**

创建 `merchant-admin/src/app/(dashboard)/products/import/page.tsx`：

```tsx
import { ImportPanel } from '@/components/product/import-panel';

export default function ProductImportPage() {
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">CSV 导入商品</h2>
      <p className="text-sm text-muted-foreground">
        只支持商品基础信息（名称、slug、品类 id、描述性属性 JSON）。
        规格矩阵与图片请在商品编辑页单独维护——用扁平表格表达规格结构
        会立刻变得不可读。
      </p>
      <ImportPanel />
    </div>
  );
}
```

创建 `merchant-admin/src/components/product/import-panel.tsx`：

```tsx
'use client';

import { useState } from 'react';

interface ImportResult {
  row: number;
  ok: boolean;
  name?: string;
  error?: string;
}

const TEMPLATE = '名称,slug,品类id,描述性属性JSON\n经典圆领T恤,classic-tee,,{"材质":"纯棉"}';

export function ImportPanel() {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  async function readFile(file: File) {
    const text = await file.text();
    setCsv(text);
  }

  async function submit() {
    setBusy(true);
    setResults(null);
    setSummary(null);
    try {
      const response = await fetch('/api/products/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? '导入失败');
      }
      setResults(payload.results ?? []);
      setSummary(
        `共 ${payload.total} 行，成功 ${payload.succeeded} 行，失败 ${payload.failed} 行`,
      );
    } catch (cause) {
      setSummary(cause instanceof Error ? cause.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>CSV 内容</span>
          <textarea
            value={csv}
            rows={8}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={TEMPLATE}
            className="rounded-md border px-3 py-2 font-mono text-xs"
          />
        </label>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
          }}
          className="text-sm"
        />
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={busy || csv.trim() === ''}
        className="w-fit rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40"
      >
        {busy ? '导入中…' : '开始导入'}
      </button>

      {summary && <p className="text-sm">{summary}</p>}

      {results && results.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>行号</th>
              <th>商品</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.row} className="border-b">
                <td>{result.row}</td>
                <td>{result.name ?? '—'}</td>
                <td className={result.ok ? '' : 'text-destructive'}>
                  {result.ok ? '成功' : (result.error ?? '失败')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 8: 类型检查与构建**

```bash
cd merchant-admin && npx tsc --noEmit && npm run lint && npm run build
```

预期：全部通过。

- [ ] **Step 9: 浏览器手测**

起全部服务，用浏览器走一遍：

1. 商家后台登录 → 商品列表 → 新建商品 → 保存
2. 编辑商品 → 加两个规格维度与值 → 保存规格 → 看到 SKU 数量正确
3. 在 SKU 表格里改价格 → 保存 → 商品列表的最低价跟着变
4. 库存页给某个 SKU 入库 → 流水里出现一条记录
5. 商品列表勾选两个商品 → 批量上架 → 两件都变成已上架
6. CSV 导入页粘两行数据 → 显示逐行结果

- [ ] **Step 10: 提交**

```bash
git add merchant-admin/src api/test
git commit -m "feat(merchant-admin): 商品管理、规格矩阵编辑器、批量操作与 CSV 导入导出"
```

---

## Task 12：阶段 2 验收与收尾

**Files:**
- Create: `docs/superpowers/plans/2026-10-22-plan-02-acceptance.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-21-multi-tenant-ecommerce-saas-design.md`
- Modify: `api/src/main.ts`

### 12.1 机制级验证（恒真自检）

**这一项是本次验收的重点。** 阶段 1 的验收记录里，这部分做得最扎实——
每个关键护栏都做过**失效注入**：把保护逻辑临时改坏，确认对应的测试**真的会失败**。
没有它，"测试全绿"可能只是断言写错了。

逐项做：

| # | 护栏 | 注入方式 | 预期 |
|---|------|---------|------|
| 1 | 租户隔离（读） | 去掉 `where.tenantId` 的合并 | 跨租户用例失败 |
| 2 | 租户隔离（写） | 去掉 `data.tenantId` 的注入 | 跨租户写入用例失败 |
| 3 | 软删除过滤 | 去掉 `deletedAt: null` 的合并 | 软删除用例失败 |
| 4 | 物理删除禁止 | 去掉 `assertNotPhysicallyDeletable` | 物理删除用例失败 |
| 5 | `@Public()` 不跳过租户上下文 | 把 `@Public()` 改成 `@Skip()` | 公开接口用例失败（500 而不是 200） |
| 6 | 匿名路径只返回公开数据 | 在公开详情里加上 `tenantId` 字段 | 字段裁剪用例失败 |
| 7 | minPrice 同步 | 去掉价格变更后的重算 | 一致性用例失败 |
| 8 | 乐观锁 | 去掉 version 校验 | 并发用例失败 |
| 9 | 库存不为负 | 去掉出库量校验 | 超量用例失败 |
| 10 | 规格矩阵笛卡尔积 | 改成只取第一个维度的值 | SKU 数量用例失败 |
| 11 | 有流水的 SKU 不删 | 去掉流水计数判断 | 库存流水保全用例失败 |
| 12 | 主题 token 白名单 | 去掉 `sanitize` 的过滤 | 未知 token 用例失败 |
| 13 | 部分唯一索引 | 删掉部分唯一索引 | 同名商品创建用例失败 |

**做法**：每项单独做——改一处 → 跑对应测试 → 确认失败 → 改回来 → 跑一遍确认通过。

记录每项的实际结果，写进验收记录。

- [ ] **Step 2: 跑全量自动化测试**

```bash
cd api && npm test && npm run test:e2e && npm run test:cov:e2e
```

```bash
cd storefront && npx tsc --noEmit && npm run lint && npm run build
cd merchant-admin && npx tsc --noEmit && npm run lint && npm run build
cd platform-admin && npx tsc --noEmit && npm run lint && npm run build
```

预期：全部通过。覆盖率应不低于阶段 1 的 63.9%。

- [ ] **Step 3: 容器化验证**

```bash
cd infra && docker compose build && docker compose up -d
```

| 场景 | 预期 |
|------|------|
| 七个服务起来 | postgres(healthy) / minio(healthy) / api(healthy) / storefront / merchant-admin / platform-admin / nginx |
| 经 nginx 访问后端健康检查 | 200 |
| 经 nginx 访问店铺前台 | 200 |
| 经 nginx 访问公开商品接口 | 200，且 `Host` 头决定返回哪个店的商品 |
| 全新数据卷启动 | 自动跑迁移，输出「All migrations have been successfully applied」 |

> **公开商品接口必须用店铺子域名访问**，不能用中心域名：
> `http://<tenant>.platform.test/api/v1/public/products`。
> 原因在 `infra/nginx/platform.test.conf` 里——中心域名的 server 块
> 显式执行了 `proxy_set_header X-Tenant-Subdomain ""`（剥除客户端带的子域名头），
> 而匿名请求的租户正是靠这个头定位的。用中心域名访问会得到 404，
> 这不是 bug，是设计如此。

> **迁移里的 `CREATE EXTENSION pg_trgm` 在全新数据卷上也要能跑通。**
> Task 1 Step 5 的验证是在**已有**数据卷上做的，而全新卷上这个扩展尚未装过
> ——`CREATE EXTENSION IF NOT EXISTS` 会自己装，前提是镜像里有扩展文件。
> 这一条要在全新卷上再验一次。

> **新增的验证点**：`pg_trgm` 扩展在全新数据卷上也要能装上。
> 如果迁移里 `CREATE EXTENSION` 失败，说明 Task 1 的验证漏了——
> 回查 Task 1 Step 6。

- [ ] **Step 4: 写验收记录**

新建 `docs/superpowers/plans/2026-10-22-plan-02-acceptance.md`，结构参照
`docs/superpowers/plans/2026-10-21-plan-01-acceptance.md`：

1. 自动化测试结果表
2. 容器化编排验证表
3. 手动验收场景表（覆盖：商家建品类 → 上架带规格商品 → 传图 → 改库存 →
   配主题 → 消费者浏览 → 搜索 → 选规格 → 改价后最低价同步 → 批量操作 →
   CSV 导入导出）
4. **机制级验证（恒真自检）表** —— 上面 13 项的实测结果
5. 交付物清单
6. 已知遗留项
7. 下一阶段

- [ ] **Step 5: 更新 README**

- 「当前进度」改为「阶段 2「商品中心与店铺前台浏览」已完成并验收通过」
- 「后续计划」表格里计划 2 标为已完成
- 加一节说明主题 token 的配置位置

- [ ] **Step 6: 更新主设计文档**

`docs/superpowers/specs/2026-10-21-multi-tenant-ecommerce-saas-design.md` 的
§3 路线图表述要改成与实施计划编号一致（计划 1–4 的划分），
并把 §1.2「非目标」里「不做主题可视化编辑器」补上「阶段 2 做了全量 token 表单配置」。

- [ ] **Step 7: 更新 swagger 描述**

`api/src/main.ts` 的 `.setDescription('多租户电商 SaaS API · 阶段 2：商品中心与店铺前台浏览')`。

- [ ] **Step 8: 提交**

```bash
git add api/src README.md docs/
git commit -m "docs: 阶段 2 验收记录与文档收尾"
```

**下一步：计划 3「交易链路」——购物车 → 库存预占 → 订单 → 支付。**
它会直接用上本阶段的 SKU、库存流水（含已留位的 RESERVE / RELEASE / DEDUCT
三种类型）与规格矩阵数据。
