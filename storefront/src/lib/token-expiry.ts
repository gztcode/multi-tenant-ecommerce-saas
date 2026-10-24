/**
 * 访问令牌的过期判断。
 *
 * 单独成文件是因为它**要能单独测**：过期判断错一个方向，
 * 后果就是「明明还有效却去刷新」（白白轮换掉一枚好令牌）
 * 或「已经过期却当成有效」（用户看到一堆 Unauthorized）。
 *
 * ⚠️ 这里只**读** JWT 的 exp，不验签——验签是后端的事。
 * 前端读 exp 只是为了**决定要不要提前去刷新**，
 * 拿一个伪造的 exp 去刷新，后端照样会拒。
 */

/**
 * 从 JWT 里取出 exp（过期时刻，Unix 秒）。
 *
 * 返回 null 表示**读不出来**：令牌不是 JWT（格式不对、被截断、
 * 或根本不是令牌）。读不出来时不能当成「已过期」——
 * 那会把每一次请求都变成一次刷新风暴。
 */
export function readJwtExpiry(token: string | undefined | null): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const payload = Buffer.from(
      parts[1].replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const exp = (parsed as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    return exp;
  } catch {
    // 载荷不是合法 base64 或不是合法 JSON
    return null;
  }
}

/**
 * 从 JWT 里取出 iat（签发时刻，Unix 秒）。
 *
 * 用来算令牌**自己的寿命**（exp - iat）——提前量不能超过寿命的一小截，
 * 否则短寿命令牌会被永远判成「已过期」（见 isTokenExpired 的说明）。
 *
 * 返回 null 表示读不出来。
 */
export function readJwtIssuedAt(
  token: string | undefined | null,
): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const payload = Buffer.from(
      parts[1].replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const iat = (parsed as { iat?: unknown }).iat;
    if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
    return iat;
  } catch {
    return null;
  }
}

/**
 * 令牌是否已经过期（或即将过期）。
 *
 * `leewaySeconds` 是**提前量**：令牌还有 30 秒就过期时，
 * 请求发出去、响应回来，很可能已经过期了——那一次调用就白费了。
 * 提前一点去刷新更稳。
 *
 * ⚠️ 提前量不能大于令牌**自身寿命**的一个零头：
 * 否则一枚寿命本来就短于提前量的令牌会**永远**被判成「已过期」，
 * 于是每次读会话都去刷新——而刷新是轮换式的，
 * 并发的第二轮刷新会被后端当成重放，把用户的登录全部作废。
 * 所以提前量取「令牌寿命的 1/10」与传入值的较小者。
 *
 * ⚠️ 读不出 exp 时返回 false（当作「没过期」）：宁可多带一次无效令牌
 * 让后端拒，也不要凭空触发刷新——刷新会**轮换**掉旧令牌，
 * 无谓的轮换会让并发请求互相踩（后端会把并发的第二次当重放）。
 */
export function isTokenExpired(
  token: string | undefined | null,
  now: number,
  leewaySeconds = 60,
): boolean {
  const exp = readJwtExpiry(token);
  if (exp === null) return false;
  const iat = readJwtIssuedAt(token);
  // 拿不到签发时间就退回到「提前量 = 传入值」的老行为
  const lifetime = iat === null ? null : exp - iat;
  const leeway =
    lifetime !== null && lifetime > 0
      ? Math.min(leewaySeconds, Math.floor(lifetime / 10))
      : leewaySeconds;
  return exp - leeway <= now;
}
