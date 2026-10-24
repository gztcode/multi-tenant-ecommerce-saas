import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { MediaService } from '../src/modules/media/media.service';
import { MinioService } from '../src/modules/media/storage/minio.service';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';

/** 签发上传凭证接口的响应体 */
interface UploadUrlResponseBody {
  media: {
    id: string;
    tenantId: string;
    key: string;
    url: string;
    mime: string;
    size: number;
    status: string;
    uploadedBy: string;
    deletedAt: string | null;
  };
  uploadUrl: string;
}

interface MediaResponseBody {
  id: string;
  status: string;
  size: number;
  deletedAt: string | null;
}

interface MediaListBody {
  items: MediaResponseBody[];
  total: number;
  page: number;
  pageSize: number;
}

/** supertest 的 response.body 是 any，集中做一次类型收敛 */
function uploadBody(response: { body: unknown }): UploadUrlResponseBody {
  return response.body as UploadUrlResponseBody;
}

function mediaBody(response: { body: unknown }): MediaResponseBody {
  return response.body as MediaResponseBody;
}

function mediaListBody(response: { body: unknown }): MediaListBody {
  return response.body as MediaListBody;
}

/**
 * 媒体上传 (e2e)
 *
 * 这个套件要证明六件事：
 * 1. 签发凭证返回 mediaId 与**真的可用的** presigned URL（host 是浏览器可达的
 *    localhost:19000，不是容器内的 minio:9000）；
 * 2. 类型白名单真的生效，且被拒时**没有任何记录写进库**；
 * 3. 大小上限真的生效，同样不留下脏记录；
 * 4. 没上传就 confirm 会被拒，且状态仍留在 PENDING；
 * 5. 真实 PUT 上传后 confirm 成功，size 取**对象真实字节数**而非客户端申报值；
 * 6. 租户隔离在媒体上生效，孤儿清理跨租户且只动「对象不存在」的那些。
 */
describe('媒体上传 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let mediaService: MediaService;
  let minio: MinioService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 main.ts 保持一致
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();

    prisma = app.get(TenantPrismaService);
    mediaService = app.get(MediaService);
    minio = app.get(MinioService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** 在指定租户的上下文里查库；必须 async 回调，否则上下文不传播 */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  /** 签发一次上传凭证并返回解析后的响应体 */
  async function issueUploadUrl(
    token: string,
    payload: { filename: string; mime: string; size: number },
  ): Promise<UploadUrlResponseBody> {
    const response = await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201);
    return uploadBody(response);
  }

  it('签发上传凭证：返回 mediaId 与 presigned URL', async () => {
    const merchant = await createMerchant(app, prisma);

    const body = await issueUploadUrl(merchant.token, {
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });

    expect(body.media.id).toBeTruthy();
    expect(body.uploadUrl).toContain('X-Amz-Signature');
    expect(body.media.status).toBe('PENDING');

    // 记录归属与登记内容都要对：只断言 media.id 存在的话，
    // 上面三行在「什么都没做」的返回体下也可能是绿的
    expect(body.media.tenantId).toBe(merchant.tenantId);
    expect(body.media.mime).toBe('image/jpeg');
    expect(body.media.size).toBe(1024);
    expect(body.media.deletedAt).toBeNull();
    // key 带租户前缀 + 扩展名由 mime 推断（不信任客户端的 filename）
    expect(body.media.key).toMatch(
      new RegExp(`^${merchant.tenantId}/\\d{4}/\\d{2}/[0-9a-f]{24}\\.jpg$`),
    );
    expect(body.media.url).toBe(
      `${process.env.MINIO_PUBLIC_URL ?? 'http://localhost:19000'}/${minio.getBucketName()}/${body.media.key}`,
    );

    // 库里确实有一行 PENDING 记录（接口返回不能自证落库）
    await asTenant(merchant.tenantId, async () => {
      const stored = await prisma.media.findFirst({
        where: { id: body.media.id },
      });
      expect(stored?.status).toBe('PENDING');
      expect(stored?.key).toBe(body.media.key);
    });
  });

  it('presigned URL 的 host 是浏览器可达的地址，不是容器内的服务名', async () => {
    const merchant = await createMerchant(app, prisma);

    const body = await issueUploadUrl(merchant.token, {
      filename: 'a.png',
      mime: 'image/png',
      size: 1024,
    });

    // 签名绑定 host：签发时若用了 minio:9000，浏览器根本解析不了这个主机名。
    // 这里直接断言 URL 里不含容器服务名。
    expect(body.uploadUrl).not.toContain('minio:9000');
    const host = new URL(body.uploadUrl).host;
    expect(host).toBe(
      new URL(process.env.MINIO_ENDPOINT ?? 'http://localhost:19000').host,
    );
    // presigned PUT 必须带签名与限定有效期
    expect(body.uploadUrl).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(body.uploadUrl).toContain('X-Amz-Expires=');
  });

  it('拒绝非白名单的图片类型', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ filename: 'a.exe', mime: 'application/x-msdownload', size: 1024 })
      .expect(400);

    // ⚠️ 只看 400 是恒真的（400 也可能来自别的校验），必须查库确认真的什么都没写
    await asTenant(merchant.tenantId, async () => {
      expect(
        await prisma.media.count({
          where: { mime: 'application/x-msdownload' },
        }),
      ).toBe(0);
      expect(await prisma.media.count()).toBe(0);
    });
  });

  it('拒绝超过大小上限的文件', async () => {
    const merchant = await createMerchant(app, prisma);

    const rejected = await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ filename: 'a.jpg', mime: 'image/jpeg', size: 99999999 })
      .expect(400);

    // 断言错误文案本身：光断言 400 挡不住「因为别的原因被拒」的实现
    expect((rejected.body as { message: string }).message).toContain('上限');

    // 超限时同样不能留下 PENDING 脏记录
    await asTenant(merchant.tenantId, async () => {
      expect(await prisma.media.count()).toBe(0);
    });
  });

  it('大小上限之内的文件被放行：不能把守卫写死成「一律拒绝」', async () => {
    const merchant = await createMerchant(app, prisma);

    // 上限是 MEDIA_MAX_SIZE（默认 5MB）。刚好等于上限应当通过——
    // 少了这条，上一条「超限被拒」在「全部拒绝」的错误实现下同样会绿。
    const maxSize = Number(process.env.MEDIA_MAX_SIZE ?? 5242880);
    const body = await issueUploadUrl(merchant.token, {
      filename: 'edge.jpg',
      mime: 'image/jpeg',
      size: maxSize,
    });
    expect(body.media.size).toBe(maxSize);
  });

  it('确认一个没上传的文件会被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await issueUploadUrl(merchant.token, {
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });

    const rejected = await http(app)
      .post(`/api/v1/media/${created.media.id}/confirm`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(400);

    expect((rejected.body as { message: string }).message).toContain(
      '尚未上传',
    );

    // 被拒之后状态必须还停在 PENDING，不能被 confirm 顺手改成 READY
    await asTenant(merchant.tenantId, async () => {
      const stored = await prisma.media.findFirst({
        where: { id: created.media.id },
      });
      expect(stored?.status).toBe('PENDING');
    });
  });

  it('真实上传后确认成功，状态变 READY', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await issueUploadUrl(merchant.token, {
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });

    // 用后端自己的 fetch 直传（模拟浏览器 PUT）
    const bytes = Buffer.alloc(1024, 7);
    const put = await fetch(created.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.ok).toBe(true);

    const confirmed = await http(app)
      .post(`/api/v1/media/${created.media.id}/confirm`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(201);

    expect(mediaBody(confirmed).status).toBe('READY');
    expect(mediaBody(confirmed).size).toBe(1024);

    // 库里也是 READY（接口返回不能自证落库）
    await asTenant(merchant.tenantId, async () => {
      const stored = await prisma.media.findFirst({
        where: { id: created.media.id },
      });
      expect(stored?.status).toBe('READY');
    });
  });

  it('confirm 采纳对象的真实字节数，而不是客户端申报的 size', async () => {
    const merchant = await createMerchant(app, prisma);

    // 故意申报 999 字节，实际传 2048 字节。
    // 若实现只是把客户端的申报值原样写回，这个断言就会红——
    // 「只信客户端说传完了」正是 confirm 要挡掉的失效模式。
    const created = await issueUploadUrl(merchant.token, {
      filename: 'lie.jpg',
      mime: 'image/jpeg',
      size: 999,
    });
    expect(created.media.size).toBe(999);

    const bytes = Buffer.alloc(2048, 1);
    const put = await fetch(created.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.ok).toBe(true);

    const confirmed = await http(app)
      .post(`/api/v1/media/${created.media.id}/confirm`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(201);

    expect(mediaBody(confirmed).size).toBe(2048);
  });

  it('媒体受租户隔离：B 看不见也改不动 A 的媒体', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const created = await issueUploadUrl(a.token, {
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });

    // B 的媒体列表里看不到 A 的
    const bList = await http(app)
      .get('/api/v1/media')
      .set('authorization', `Bearer ${b.token}`)
      .expect(200);
    expect(mediaListBody(bList).items).toEqual([]);

    // B 确认不了 A 的媒体（404 而不是 400，否则跨租户探测就成立了）
    await http(app)
      .post(`/api/v1/media/${created.media.id}/confirm`)
      .set('authorization', `Bearer ${b.token}`)
      .expect(404);

    // B 也删不掉 A 的媒体
    await http(app)
      .delete(`/api/v1/media/${created.media.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .expect(404);

    // 回 A 的视角确认一切如常
    await asTenant(a.tenantId, async () => {
      const stored = await prisma.media.findFirst({
        where: { id: created.media.id },
      });
      expect(stored?.deletedAt).toBeNull();
    });
  });

  it('删除媒体是软删除：列表里不再出现，详情也不再认它', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await issueUploadUrl(merchant.token, {
      filename: 'del.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });

    await http(app)
      .delete(`/api/v1/media/${created.media.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(204);

    const list = await http(app)
      .get('/api/v1/media')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(mediaListBody(list).items.map((i) => i.id)).not.toContain(
      created.media.id,
    );

    // ⚠️ 只看列表不够：软删与物理删都能让列表少一条。
    // 必须查库确认记录**还在**，只是 deletedAt 被填上了。
    // 而且不能用 tenant 版 prisma 查——扩展会把 deletedAt: null 合并进 where，
    // 软删掉的那行本来就查不到，必须绕开扩展用原生 client 读。
    const raw = new PrismaClient();
    try {
      const rows = await raw.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
        `SELECT "deletedAt" FROM media WHERE id = $1`,
        created.media.id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].deletedAt).not.toBeNull();
    } finally {
      await raw.$disconnect();
    }
  });

  it('列表分页：pageSize 上限 100', async () => {
    const merchant = await createMerchant(app, prisma);

    for (let i = 0; i < 2; i += 1) {
      await issueUploadUrl(merchant.token, {
        filename: `p${i}.jpg`,
        mime: 'image/jpeg',
        size: 1024,
      });
    }

    const response = await http(app)
      .get('/api/v1/media?page=1&pageSize=9999')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    expect(mediaListBody(response).pageSize).toBe(100);
    expect(mediaListBody(response).items).toHaveLength(2);
    expect(mediaListBody(response).total).toBe(2);
  });

  it('不允许传 key / url / status / tenantId 等服务端维护的字段', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        filename: 'hack.jpg',
        mime: 'image/jpeg',
        size: 1024,
        key: '../other-tenant/secret.jpg',
      })
      .expect(400);

    await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        filename: 'hack.jpg',
        mime: 'image/jpeg',
        size: 1024,
        status: 'READY',
      })
      .expect(400);

    await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        filename: 'hack.jpg',
        mime: 'image/jpeg',
        size: 1024,
        tenantId: 'someone-else',
      })
      .expect(400);

    await asTenant(merchant.tenantId, async () => {
      expect(await prisma.media.count()).toBe(0);
    });
  });

  it('不带 token 的媒体请求被拒绝', async () => {
    await http(app).get('/api/v1/media').expect(401);
    await http(app)
      .post('/api/v1/media/upload-url')
      .send({ filename: 'a.jpg', mime: 'image/jpeg', size: 1024 })
      .expect(401);
  });

  it('孤儿清理跨租户：只把「对象确实不存在」的 PENDING 标为 ORPHANED', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    // A 造两条超过 24 小时的 PENDING：一条有对象、一条没有
    const withObject = await issueUploadUrl(a.token, {
      filename: 'stale.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });
    const withoutObject = await issueUploadUrl(a.token, {
      filename: 'never.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });

    // B 也造一条超过 24 小时、同样没有对象的 PENDING。
    // ⚠️ 这条是关键：如果 cleanupOrphans 没有切到 platform scope，
    // 沿用请求的租户上下文就只会清理一个租户，B 这条永远清不掉。
    const otherTenant = await issueUploadUrl(b.token, {
      filename: 'b-stale.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });

    // 只给 A 的第一条真的上传对象
    const put = await fetch(withObject.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.alloc(1024, 3),
    });
    expect(put.ok).toBe(true);

    // 把三条的创建时间往前拨 48 小时
    const staleAt = new Date(Date.now() - 48 * 3600 * 1000);
    await asTenant(a.tenantId, async () => {
      for (const id of [withObject.media.id, withoutObject.media.id]) {
        await prisma.media.updateMany({
          where: { id },
          data: { createdAt: staleAt },
        });
      }
    });
    await asTenant(b.tenantId, async () => {
      await prisma.media.updateMany({
        where: { id: otherTenant.media.id },
        data: { createdAt: staleAt },
      });
    });

    // 清完之后应当只剩两条真正的孤儿被标掉（A 的没上传那条 + B 的那条）
    const freshStale = await issueUploadUrl(a.token, {
      filename: 'fresh.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });

    const result = await mediaService.cleanupOrphans();
    expect(result.marked).toBe(2);

    await asTenant(a.tenantId, async () => {
      // 对象存在的「超时 PENDING」被补确认成 READY，而不是标成孤儿
      const uploaded = await prisma.media.findFirst({
        where: { id: withObject.media.id },
      });
      expect(uploaded?.status).toBe('READY');
      expect(uploaded?.size).toBe(1024);

      // 对象不存在的被标成 ORPHANED
      const orphan = await prisma.media.findFirst({
        where: { id: withoutObject.media.id },
      });
      expect(orphan?.status).toBe('ORPHANED');

      // ⚠️ 没超过 24 小时的新记录必须原样不动。
      // 少了这条断言，一个「把所有 PENDING 都标成孤儿」的错误实现也能绿。
      const fresh = await prisma.media.findFirst({
        where: { id: freshStale.media.id },
      });
      expect(fresh?.status).toBe('PENDING');
    });

    // B 的那条也被清了——跨租户生效的直接证据
    await asTenant(b.tenantId, async () => {
      const bMedia = await prisma.media.findFirst({
        where: { id: otherTenant.media.id },
      });
      expect(bMedia?.status).toBe('ORPHANED');
    });
  });

  it('孤儿清理只删对象、不删记录：记录仍在库里可查', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await issueUploadUrl(merchant.token, {
      filename: 'orphan.jpg',
      mime: 'image/jpeg',
      size: 1024,
    });

    const staleAt = new Date(Date.now() - 48 * 3600 * 1000);
    await asTenant(merchant.tenantId, async () => {
      await prisma.media.updateMany({
        where: { id: created.media.id },
        data: { createdAt: staleAt },
      });
    });

    await mediaService.cleanupOrphans();

    await asTenant(merchant.tenantId, async () => {
      const stored = await prisma.media.findFirst({
        where: { id: created.media.id },
      });
      expect(stored).not.toBeNull();
      expect(stored?.status).toBe('ORPHANED');
    });

    // 对象确实被删了：再 confirm 一次应当拿不到对象
    await http(app)
      .post(`/api/v1/media/${created.media.id}/confirm`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(400);
  });
  // 阶段 2b 失败注入发现：confirm 时的媒体大小复核**没有 e2e 覆盖**。
  // 而它才是这条路径上唯一真正的防线——presigned PUT 的签名里没有长度约束，
  // 商家可以为 1KB 的申请签发凭证，再直传一个远超上限的文件。
  it('confirm 时复核大小：直传超大文件后确认被拒', async () => {
    const merchant = await createMerchant(app, prisma);

    // 按上限（5MB）申报，实际会传得更多
    const signed = await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ filename: 'huge.jpg', mime: 'image/jpeg', size: 1024 })
      .expect(201);

    // 直传一个超过 MEDIA_MAX_SIZE 的对象
    const tooBig = Buffer.alloc(6 * 1024 * 1024, 7);
    const put = await fetch(signed.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: tooBig,
    });
    expect(put.ok).toBe(true);

    // 确认时必须被拦下——不能因为「签发时申报的是 1KB」就放行
    const response = await http(app)
      .post(`/api/v1/media/${signed.body.media.id}/confirm`)
      .set('authorization', `Bearer ${merchant.token}`);

    expect(response.status).toBe(400);
    expect(String((response.body as { message?: string }).message)).toContain(
      '上限',
    );
  });
});
