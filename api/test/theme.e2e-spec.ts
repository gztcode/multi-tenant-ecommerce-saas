import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';

/** /theme/schema 的响应：token 的定义本身 */
interface SchemaResponseBody {
  colors: Array<{
    key: string;
    label: string;
    cssVar: string;
    defaultValue: string;
  }>;
  radius: { key: string; label: string; cssVar: string; defaultValue: string };
  fonts: Array<{
    key: string;
    label: string;
    cssVar: string;
    defaultValue: string;
  }>;
  textScale: Array<{
    key: string;
    label: string;
    cssVar: string;
    defaultValue: string;
  }>;
  weights: Array<{
    key: string;
    label: string;
    cssVar: string;
    defaultValue: string;
  }>;
  spacing: Array<{
    key: string;
    label: string;
    cssVar: string;
    defaultValue: string;
  }>;
  shadows: Array<{
    key: string;
    label: string;
    cssVar: string;
    defaultValue: string;
  }>;
}

/** /public/theme 的响应 */
interface PublicThemeResponseBody {
  tokens: {
    colors: Record<string, string>;
    radius: string;
    textScale: Record<string, string>;
    weights: Record<string, string>;
    spacing: Record<string, string>;
    shadows: Record<string, string>;
  };
}

function schemaBody(response: { body: unknown }): SchemaResponseBody {
  return response.body as SchemaResponseBody;
}

function themeBody(response: { body: unknown }): PublicThemeResponseBody {
  return response.body as PublicThemeResponseBody;
}

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
    const body = schemaBody(response);

    expect(body.colors.map((c) => c.key)).toContain('primary');
    expect(body.radius.key).toBe('radius');
    expect(body.textScale).toHaveLength(5);
  });

  it('schema 的定义覆盖全部六组，且每项都带默认值与 CSS 变量名', async () => {
    // 只断言 primary 存在的话，后端只导出颜色组、其余五组漏掉也能通过。
    // 商家后台的表单是按 schema 逐组渲染的，漏一组就等于那一组配不了。
    const response = await http(app).get('/api/v1/theme/schema').expect(200);
    const body = schemaBody(response);

    expect(body.colors.length).toBeGreaterThan(0);
    expect(body.fonts.length).toBeGreaterThan(0);
    expect(body.textScale).toHaveLength(5);
    expect(body.weights.length).toBeGreaterThan(0);
    expect(body.spacing.length).toBeGreaterThan(0);
    expect(body.shadows.length).toBeGreaterThan(0);

    for (const group of [
      body.colors,
      body.fonts,
      body.textScale,
      body.weights,
      body.spacing,
      body.shadows,
    ]) {
      for (const token of group) {
        expect(token.cssVar).toMatch(/^--/);
        expect(token.defaultValue.length).toBeGreaterThan(0);
        expect(token.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('公开主题接口返回当前店铺的 token，未配置时返回默认值', async () => {
    const merchant = await createMerchant(app, app.get(TenantPrismaService));

    const response = await http(app)
      .get('/api/v1/public/theme')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(themeBody(response).tokens.colors.primary).toBeTruthy();
  });

  it('未配置的店铺返回的是**完整的默认值**，而不是空对象', async () => {
    const merchant = await createMerchant(app, app.get(TenantPrismaService));

    // 新建店铺的 themeTokens 是 Prisma 的默认 "{}"。如果 sanitize 对空输入
    // 返回 {} 而不是全量默认值，storefront 拼出来的 :root 会是空的，
    // 页面退回 globals.css 里的默认配色——商家配了色的店铺没问题，
    // 但「未配置」这条路径会与「已配置」表现不一致。这里钉死默认值的形状。
    const response = await http(app)
      .get('/api/v1/public/theme')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    const tokens = themeBody(response).tokens;

    expect(Object.keys(tokens.colors).length).toBeGreaterThan(0);
    expect(tokens.colors.primary).toBe('oklch(0.205 0 0)');
    expect(tokens.radius).toBe('0.625rem');
    expect(Object.keys(tokens.textScale)).toHaveLength(5);
    expect(Object.keys(tokens.weights).length).toBeGreaterThan(0);
    expect(Object.keys(tokens.spacing).length).toBeGreaterThan(0);
    expect(Object.keys(tokens.shadows).length).toBeGreaterThan(0);
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

    const tokens = themeBody(response).tokens;

    expect(tokens.colors.primary).toBe('oklch(0.55 0.22 264)');
    expect(tokens.colors.evil).toBeUndefined();
    expect((tokens as Record<string, unknown>)['未知分组']).toBeUndefined();
  });

  it('非法形状的 token 值回落到默认值，而不是原样透出', async () => {
    const merchant = await createMerchant(app, app.get(TenantPrismaService));

    // 这些值全是「客户端可控」的输入：stores.themeTokens 是 Prisma 的 Json 字段，
    // 任何人都能塞。字符串拼进 <style> 标签后，;} 一旦放行就是任意 CSS 注入。
    await http(app)
      .patch('/api/v1/stores/me')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        themeTokens: {
          colors: {
            // 颜色必须是 oklch(...)：这里混进裸色名、hex、以及注入 payload
            background: 'url(javascript:alert(1))',
            foreground: '#1677ff',
            card: 'oklch(0.9 0 0); } body { display: none',
            // 合法值必须仍然生效，确认不是「全部拒绝」
            primary: 'oklch(0.55 0.22 264)',
          },
          radius: '1rem;} html{display:none}',
          textScale: { xs: '<script>', base: '1.125rem' },
        },
      })
      .expect(200);

    const response = await http(app)
      .get('/api/v1/public/theme')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    const tokens = themeBody(response).tokens;

    // 非法值一律回落到默认值
    expect(tokens.colors.background).toBe('oklch(1 0 0)');
    expect(tokens.colors.foreground).toBe('oklch(0.145 0 0)');
    expect(tokens.colors.card).toBe('oklch(1 0 0)');
    expect(tokens.radius).toBe('0.625rem');
    expect(tokens.textScale.xs).toBe('0.75rem');

    // 同一批请求里的合法值确实生效了——否则上面的「回落」可能只是
    // 「全部被丢弃」造成的假象
    expect(tokens.colors.primary).toBe('oklch(0.55 0.22 264)');
    expect(tokens.textScale.base).toBe('1.125rem');
  });

  it('一个店铺的主题不会串到另一个店铺', async () => {
    const a = await createMerchant(app, app.get(TenantPrismaService));
    const b = await createMerchant(app, app.get(TenantPrismaService));

    await http(app)
      .patch('/api/v1/stores/me')
      .set('authorization', `Bearer ${a.token}`)
      .send({ themeTokens: { colors: { primary: 'oklch(0.11 0.33 264)' } } })
      .expect(200);

    await http(app)
      .patch('/api/v1/stores/me')
      .set('authorization', `Bearer ${b.token}`)
      .send({ themeTokens: { colors: { primary: 'oklch(0.77 0.19 145)' } } })
      .expect(200);

    const themeOf = async (subdomain: string) =>
      themeBody(
        await http(app)
          .get('/api/v1/public/theme')
          .set('x-tenant-subdomain', subdomain)
          .expect(200),
      ).tokens.colors.primary;

    expect(await themeOf(a.subdomain)).toBe('oklch(0.11 0.33 264)');
    expect(await themeOf(b.subdomain)).toBe('oklch(0.77 0.19 145)');
  });
});
