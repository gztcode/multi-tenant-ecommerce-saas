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
   *
   * 之所以必须**丢弃未知键**而不是原样回写：未知的键会一路传到 storefront，
   * 被拼进 `<style>` 标签。白名单之外的键名不受正则保护（正则管的是值），
   * 键名一旦可注入，`}` 就能凭空结束 `:root` 规则、后面跟什么就是什么。
   *
   * 返回值是一个结构全新的对象，`defaults()` 的原对象不会被调用方拿到，
   * 因此不存在「改返回值顺带改掉默认值」的共享引用问题。
   */
  sanitize(raw: unknown): ThemeTokens {
    const result = this.defaults();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return result;
    }
    const source = raw as Record<string, unknown>;

    // 颜色
    const colors = source.colors;
    if (
      typeof colors === 'object' &&
      colors !== null &&
      !Array.isArray(colors)
    ) {
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
      const target = result[groupName as 'textScale'];
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
