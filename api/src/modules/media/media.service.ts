import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Media } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { MinioService } from './storage/minio.service';
import { RedisLockService } from '../../common/lock/redis-lock.service';
import { ALLOWED_MIME_TYPES, UploadUrlDto } from './dto/upload-url.dto';
import { requireTenantId } from '../../common/tenant/require-tenant';

/** 超过这个时间仍是 PENDING 的记录视为孤儿 */
export const ORPHAN_AFTER_HOURS = 24;

/**
 * 图片 magic bytes 与 MIME 的比对（阶段 11）。
 *
 * 只覆盖 ALLOWED_MIME_TYPES 里的四种图片类型；`head` 不足长（空文件除外）
 * 或完全不匹配 → false。比对只认前几个字节，容忍后续任意内容。
 */
export function isMagicMatched(head: Buffer | null, mime: string): boolean {
  if (!head || head.length === 0) return false;
  const startsWith = (...bytes: number[]): boolean =>
    bytes.every((b, i) => head[i] === b);
  const ascii = head.toString('latin1');
  switch (mime) {
    case 'image/jpeg':
      // FFD8FF（JPEG SOI + 第一段 marker）
      return startsWith(0xff, 0xd8, 0xff);
    case 'image/png':
      // 89 50 4E 47 0D 0A 1A 0A（PNG 签名）
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/gif':
      // GIF87a / GIF89a
      return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
    case 'image/webp':
      // RIFF....WEBP（第 8-11 字节是 WEBP）
      return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    default:
      // 不在白名单的类型在上传签发处就被拒了；这里兜底拒绝
      return false;
  }
}

@Injectable()
export class MediaService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly minio: MinioService,
    private readonly lock: RedisLockService,
  ) {}

  /**
   * 启动孤儿清理定时器。
   *
   * 阶段 1 没有引入 @nestjs/schedule，用原生 setInterval 就够——
   * 这类低频后台任务不值得为它加一个依赖。
   *
   * ⚠️ **必须 unref()**：不 unref 的定时器会让 Node 进程一直不退出，
   * e2e 测试跑完后 jest 会挂住。
   */
  onModuleInit(): void {
    const intervalMs = Number(
      process.env.MEDIA_CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000,
    );
    this.cleanupTimer = setInterval(() => {
      void this.cleanupOrphans().catch((error: unknown) => {
        console.error('媒体孤儿清理失败', error);
      });
    }, intervalMs);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private currentTenantId(): string {
    return requireTenantId();
  }

  /** 取文件扩展名：优先用 mime 推断，不信任客户端传的原始文件名 */
  private extensionOf(mime: string): string {
    switch (mime) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      case 'image/gif':
        return 'gif';
      default:
        return 'bin';
    }
  }

  /**
   * 签发上传凭证。
   *
   * object key 带 tenantId 前缀：即使 bucket 权限配错，也能靠前缀做隔离，
   * 且清某个租户的文件时能按前缀批量处理。
   */
  async createUploadUrl(
    dto: UploadUrlDto,
    operatorId: string,
  ): Promise<{ media: Media; uploadUrl: string }> {
    const tenantId = this.currentTenantId();

    if (!ALLOWED_MIME_TYPES.includes(dto.mime as never)) {
      throw new BadRequestException(
        `不支持的图片类型：${dto.mime}。只支持 ${ALLOWED_MIME_TYPES.join('、')}`,
      );
    }

    const maxSize = Number(process.env.MEDIA_MAX_SIZE ?? 5242880);
    if (dto.size > maxSize) {
      throw new BadRequestException(
        `文件超过 ${Math.floor(maxSize / 1024 / 1024)}MB 上限`,
      );
    }

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const key = `${tenantId}/${yyyy}/${mm}/${randomBytes(12).toString('hex')}.${this.extensionOf(dto.mime)}`;

    // 媒体访问地址用 MINIO_PUBLIC_URL 而不是 MINIO_ENDPOINT：
    // 生产部署时媒体通常走 CDN 或 Nginx 暴露的域名，与 MinIO 接入地址不同。
    // 两者分开才能换。
    const publicBase =
      process.env.MINIO_PUBLIC_URL ??
      process.env.MINIO_ENDPOINT ??
      'http://localhost:19000';

    const media = await this.prisma.media.create({
      // as never 的理由同 CategoriesService.create：tenantId 由租户扩展在运行时
      // 注入，TS 不知道这回事，不加断言就会因为缺少 `tenant` 关系字段而报错。
      data: {
        key,
        url: `${publicBase}/${this.minio.getBucketName()}/${key}`,
        mime: dto.mime,
        size: dto.size,
        status: 'PENDING',
        uploadedBy: operatorId,
      } as never,
    });

    const uploadUrl = await this.minio.createUploadUrl(key, dto.mime);
    // 浏览器真正用 readUrl：bucket 是私有的，media.url 那个固定地址直接
    // GET 会 403。Chainguard 版 MinIO 不支持 PutBucketPolicy（实测
    // NotImplemented），配不了匿名读，所以走限时签名 URL。
    const readUrl = await this.minio.createReadUrl(key);
    return {
      media: { ...media, readUrl } as Media & { readUrl: string },
      uploadUrl,
    };
  }

  /**
   * 确认上传完成。
   *
   * 后端 HEAD 对象核对存在与大小——只信客户端说「我传完了」是不够的，
   * 客户端可能根本没传，或者传了个空文件。
   */
  async confirm(id: string): Promise<Media> {
    this.currentTenantId();
    const media = await this.prisma.media.findFirst({ where: { id } });
    if (!media) {
      throw new NotFoundException('媒体不存在');
    }

    const actualSize = await this.minio.statObject(media.key);
    if (actualSize === null) {
      throw new BadRequestException('文件尚未上传或已被删除');
    }

    // ⛔ 复核大小上限。presigned PUT 的签名里**没有**长度约束——商家可以为
    // 1KB 的申请签发凭证，然后直传一个 500MB 的文件。只在签发时校验大小，
    // 等于把限制交给客户端自觉。
    const maxSize = Number(process.env.MEDIA_MAX_SIZE ?? 5242880);
    if (actualSize > maxSize) {
      // 顺手把对象删掉，别让它继续占着 bucket
      await this.minio.deleteObject(media.key);
      await this.prisma.media.updateMany({
        where: { id },
        data: { status: 'ORPHANED' },
      });
      throw new BadRequestException(
        `文件超过 ${Math.floor(maxSize / 1024 / 1024)}MB 上限，实际 ${Math.floor(actualSize / 1024 / 1024)}MB`,
      );
    }

    // ⛔ 复核文件头（阶段 11）：presigned PUT 的 Content-Type 也是客户端
    //    自报的——把一个改了扩展名的可执行/HTML 文件以 image/png 传上来，
    //    大小校验完全放行。看 magic bytes 才算数。
    if (actualSize > 0) {
      const head = await this.minio.readObjectHead(media.key);
      if (!isMagicMatched(head, media.mime)) {
        await this.minio.deleteObject(media.key);
        await this.prisma.media.updateMany({
          where: { id },
          data: { status: 'ORPHANED' },
        });
        throw new BadRequestException(
          '文件内容与声称的图片类型不符，已拒绝入库',
        );
      }
    }

    await this.prisma.media.updateMany({
      where: { id },
      data: { status: 'READY', size: actualSize },
    });

    const updated = await this.prisma.media.findFirst({ where: { id } });
    const result = updated ?? {
      ...media,
      status: 'READY' as const,
      size: actualSize,
    };
    return {
      ...result,
      readUrl: await this.minio.createReadUrl(media.key),
    } as Media & { readUrl: string };
  }

  async list(page: number, pageSize: number) {
    this.currentTenantId();
    const [items, total] = await Promise.all([
      this.prisma.media.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.media.count(),
    ]);
    // 媒体列表是给前端展示用的，批量签发限时读 URL（bucket 私有）。
    // ⚠️ 阶段 11：改用 createReadUrls 一次批量签名（一页 20 条就是
    //    20 次 HMAC，逐条 await 虽然有 Promise.all 并发，仍省不下
    //    客户端建立的连接开销；批量版在 storage 层一次循环内完成）。
    const readUrls = await this.minio.createReadUrls(
      items.map((item) => item.key),
    );
    const withUrls = items.map((item, index) => ({
      ...item,
      readUrl: readUrls[index],
    }));
    return { items: withUrls, total, page, pageSize };
  }

  /** 软删除媒体 */
  async remove(id: string): Promise<void> {
    this.currentTenantId();
    const media = await this.prisma.media.findFirst({ where: { id } });
    if (!media) {
      throw new NotFoundException('媒体不存在');
    }
    await this.prisma.media.updateMany({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * 清理孤儿：PENDING 超过 24 小时的记录标为 ORPHANED。
   *
   * 为什么需要：presigned URL 签发后商家可能直接关页面，
   * 数据库里就留下一条永远指向不存在文件的记录。
   *
   * 逐条处理而不是一条 SQL 批量改：每条都要先 HEAD 一次确认对象确实不存在
   * （商家可能上传了但没来得及 confirm），存在的话不该标记为孤儿。
   *
   * ⚠️ **必须切到 platform scope**：这是平台级任务，要扫所有租户的记录。
   * 若沿用当前请求的租户上下文，扩展会自动附加 tenantId 条件，
   * 结果只能清理自己租户的媒体。
   *
   * platform scope 下 updateMany 不附加任何租户条件——所以 where 里必须
   * 有精确的 `id` 过滤（下面每条都是按 id 更新的，不会误伤）。
   */
  async cleanupOrphans(): Promise<{ marked: number }> {
    // ⚠️ **分布式锁**（阶段 11）：清理定时器是**每个副本各自的 setInterval**，
    //    N 副本部署时本来会重复清理 N 遍（逐条 HEAD + updateMany）。
    //    抢不到锁 = 另一副本在清，直接跳过本轮。
    const outcome = await this.lock.withLock('media-orphan-cleanup', () =>
      this.doCleanupOrphans(),
    );
    return outcome.acquired ? outcome.value : { marked: 0 };
  }

  private async doCleanupOrphans(): Promise<{ marked: number }> {
    const threshold = new Date(Date.now() - ORPHAN_AFTER_HOURS * 3600 * 1000);

    return tenantContext.run(platformScope(), async () => {
      const stale = await this.prisma.media.findMany({
        where: { status: 'PENDING', createdAt: { lt: threshold } },
      });

      let marked = 0;
      for (const media of stale) {
        const exists = await this.minio.statObject(media.key);
        if (exists !== null) {
          // 文件其实传上去了，只是没 confirm——补上确认而不是标孤儿
          await this.prisma.media.updateMany({
            where: { id: media.id },
            data: { status: 'READY', size: exists },
          });
          continue;
        }
        await this.prisma.media.updateMany({
          where: { id: media.id },
          data: { status: 'ORPHANED' },
        });
        await this.minio.deleteObject(media.key);
        marked += 1;
      }

      return { marked };
    });
  }
}
