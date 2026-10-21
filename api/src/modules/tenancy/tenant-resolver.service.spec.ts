import { RESERVED_SUBDOMAINS } from '../../common/tenant/tenant-models';
import { TenantResolverService } from './tenant-resolver.service';

const extract = (
  headers: Record<string, string | string[] | undefined>,
  host?: string,
) => TenantResolverService.extractSubdomain(headers, host);

describe('TenantResolverService.extractSubdomain', () => {
  it('优先使用 X-Tenant-Subdomain 头', () => {
    expect(
      extract({ 'x-tenant-subdomain': 'acme' }, 'ignored.platform.test'),
    ).toBe('acme');
  });

  it('从 host 提取子域名', () => {
    expect(extract({}, 'acme.platform.test')).toBe('acme');
  });

  it('host 带端口时忽略端口', () => {
    expect(extract({}, 'acme.platform.test:3000')).toBe('acme');
  });

  it('host 无点号时返回 null', () => {
    expect(extract({}, 'platform')).toBeNull();
  });

  it('无任何信息时返回 null', () => {
    expect(extract({}, undefined)).toBeNull();
  });

  describe('不可能承载子域名的 host', () => {
    it('裸 IPv4 不被误解析为子域名 127', () => {
      expect(extract({}, '127.0.0.1:3000')).toBeNull();
      expect(extract({}, '10.0.0.5')).toBeNull();
    });

    it('IPv6 返回 null', () => {
      expect(extract({}, '[::1]:3000')).toBeNull();
      expect(extract({}, '::1')).toBeNull();
    });

    it('localhost 返回 null', () => {
      expect(extract({}, 'localhost:3000')).toBeNull();
    });
  });

  describe('异常的 X-Tenant-Subdomain 头', () => {
    it('数组且有多个不同值时返回 null', () => {
      expect(
        extract({ 'x-tenant-subdomain': ['alpha', 'bravo'] }, 'acme.test'),
      ).toBeNull();
    });

    it('数组但只有一个非空值时返回该值', () => {
      expect(
        extract({ 'x-tenant-subdomain': ['', 'acme'] }, 'ignored.test'),
      ).toBe('acme');
    });

    it('逗号合并的字符串视为异常，返回 null', () => {
      expect(extract({ 'x-tenant-subdomain': 'a,b' }, 'acme.test')).toBeNull();
    });

    it('数组全部为空值时回退到 host 解析', () => {
      expect(extract({ 'x-tenant-subdomain': ['  ', ''] }, 'acme.test')).toBe(
        'acme',
      );
    });
  });

  describe('子域名格式校验', () => {
    it.each([
      ['过短', 'ab'],
      ['单个字符', 'a'],
      ['含下划线', 'a_b'],
      ['含大写字母', 'A'],
      ['过长', 'a'.repeat(40)],
      ['以连字符开头', '-abc'],
      ['以连字符结尾', 'abc-'],
    ])('非法子域名（%s）返回 null', (_label, value) => {
      expect(extract({}, `${value}.platform.test`)).toBeNull();
      expect(extract({ 'x-tenant-subdomain': value })).toBeNull();
    });

    it('合法子域名通过校验', () => {
      expect(extract({}, 'a-b.platform.test')).toBe('a-b');
      expect(extract({}, 'abc.platform.test')).toBe('abc');
      expect(extract({}, 'a1b.platform.test')).toBe('a1b');
    });
  });

  describe('平台保留子域名', () => {
    // 这些名字全部返回 null，调用方会给出「无法确定店铺」的 404。
    it.each([...RESERVED_SUBDOMAINS])(
      'Host 里的保留子域名 %s 被拒',
      (subdomain) => {
        expect(extract({}, `${subdomain}.platform.test`)).toBeNull();
      },
    );

    it.each([...RESERVED_SUBDOMAINS])(
      'X-Tenant-Subdomain 头里的保留子域名 %s 被拒',
      (subdomain) => {
        expect(extract({ 'x-tenant-subdomain': subdomain })).toBeNull();
      },
    );

    it('保留子域名带端口、带大小写时同样被拒', () => {
      expect(extract({}, 'Admin.platform.test:3000')).toBeNull();
      expect(extract({}, 'WWW.platform.test')).toBeNull();
    });

    it('合法商家子域名不被误伤', () => {
      expect(extract({}, 'administrator.platform.test')).toBe('administrator');
      expect(extract({}, 'my-admin.platform.test')).toBe('my-admin');
      expect(extract({}, 'tester.platform.test')).toBe('tester');
    });

    it('保留名单非穷尽的说明：新增基础设施子域名需登记', () => {
      // 这条测试不校验行为，而是锁住名单里必须存在的关键名字，
      // 防止有人误以为「反正不穷尽」就把已有条目删掉。
      expect(RESERVED_SUBDOMAINS.has('admin')).toBe(true);
      expect(RESERVED_SUBDOMAINS.has('platform')).toBe(true);
      expect(RESERVED_SUBDOMAINS.has('www')).toBe(true);
    });
  });

  describe('resolveBySubdomain 的纵深防御', () => {
    // 即使调用方绕过了 extractSubdomain 直接调 resolveBySubdomain，
    // 保留字也不该查到租户。这里验证「不查库」而不只是「报错」。
    const makeResolver = () => {
      const findFirst = jest.fn();
      const service = new TenantResolverService({
        tenant: { findFirst },
      } as never);
      return { service, findFirst };
    };

    it('保留子域名直接调用 resolveBySubdomain 时不查库并报 404', async () => {
      const { service, findFirst } = makeResolver();

      await expect(service.resolveBySubdomain('admin')).rejects.toThrow(
        '店铺不存在',
      );
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('保留子域名的大小写变体同样被挡', async () => {
      const { service, findFirst } = makeResolver();

      await expect(service.resolveBySubdomain('  WWW  ')).rejects.toThrow(
        '店铺不存在',
      );
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('非保留子域名正常走查库', async () => {
      const { service, findFirst } = makeResolver();
      findFirst.mockResolvedValue({
        id: 't1',
        name: '商家',
        subdomain: 'acme',
        status: 'ACTIVE',
      });

      await expect(service.resolveBySubdomain('acme')).resolves.toMatchObject({
        id: 't1',
      });
      expect(findFirst).toHaveBeenCalledWith({ where: { subdomain: 'acme' } });
    });
  });
});
