import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { withTimeout } from '../../../common/util/with-timeout';

/** 读 URL 的有效期：1 小时 */
const READ_URL_TTL_SECONDS = 60 * 60;

const MAX_PRESIGN_TTL_SECONDS = 15 * 60;

/** 启动时确认 bucket 存在的超时（毫秒）。超时只告警，不挡启动。 */
const BUCKET_CHECK_TIMEOUT_MS = 5_000;

/** 判断是不是「bucket 不存在」（MinIO 返回 404 / NotFound / NoSuchBucket） */
function isBucketNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const err = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    err.name === 'NotFound' ||
    err.name === 'NoSuchBucket' ||
    err.$metadata?.httpStatusCode === 404
  );
}

/**
 * MinIO 封装。
 *
 * 两个 client，区别只在 endpoint：
 * - `publicClient`：签发 presigned URL。endpoint 是**浏览器可达**的地址，
 *   因为签名绑定了 host，用容器内地址签出来的 URL 浏览器解析不了主机名。
 * - `internalClient`：后端自己用（HEAD 确认、删除孤儿）。用容器内地址更快。
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private publicClient!: S3Client;
  private internalClient!: S3Client;
  private bucket!: string;

  constructor() {
    this.bucket = process.env.MINIO_BUCKET ?? 'ecommerce-media';
  }

  async onModuleInit(): Promise<void> {
    const region = process.env.MINIO_REGION ?? 'us-east-1';
    const credentials = {
      accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'ecommerce',
      secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'ecommerce-minio-secret',
    };

    this.publicClient = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:19000',
      region,
      credentials,
      forcePathStyle: true,
    });

    this.internalClient = new S3Client({
      endpoint: process.env.MINIO_INTERNAL_ENDPOINT ?? 'http://localhost:19000',
      region,
      credentials,
      forcePathStyle: true,
    });

    await this.ensureBucket();
  }

  /**
   * 确认 bucket 存在，不存在就建一个（审计 P2-7）。
   *
   * ⚠️ **全新部署必须能自动建**：MinIO 镜像里没有 `mc`（注释明写），
   *    compose 也不会建 bucket → 全新卷上「presigned 签发成功、
   *    但 PUT 返回 404 NoSuchBucket」，媒体表还会留下一堆 PENDING 垃圾行
   *    （`cleanupOrphans` 只标 ORPHANED，**从不硬删**）。
   *
   * ⚠️ **失败不挡启动**：MinIO 暂时不可达时只告警 —— 容器该起来还是要起来
   *    （健康检查会报 MinIO 不可用），让整个 api 因为对象存储没连上就起不来，
   *    弊大于利。
   */
  async ensureBucket(): Promise<void> {
    try {
      await withTimeout(
        this.internalClient.send(
          new HeadBucketCommand({ Bucket: this.bucket }),
        ),
        BUCKET_CHECK_TIMEOUT_MS,
        `确认 MinIO bucket ${this.bucket}`,
      );
      return;
    } catch (error) {
      if (!isBucketNotFound(error)) {
        // 连不上 / 鉴权失败 / 超时 —— 都不是「bucket 不存在」，不建。
        this.logger.warn(
          `确认 MinIO bucket ${this.bucket} 失败（不自动创建）：` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }

    try {
      await withTimeout(
        this.internalClient.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        ),
        BUCKET_CHECK_TIMEOUT_MS,
        `创建 MinIO bucket ${this.bucket}`,
      );
      this.logger.log(`已创建 MinIO bucket：${this.bucket}`);
    } catch (error) {
      this.logger.warn(
        `创建 MinIO bucket ${this.bucket} 失败：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 签发上传用的 presigned PUT URL */
  async createUploadUrl(key: string, contentType: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.publicClient, command, {
      expiresIn: MAX_PRESIGN_TTL_SECONDS,
    });
  }

  /** 确认对象存在，返回它的字节数；不存在返回 null */
  async statObject(key: string): Promise<number | null> {
    try {
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return head.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 读对象头部的前 `length` 个字节（阶段 11：媒体 magic-byte 校验用）。
   *
   * 用 S3 的 Range 请求只取文件头，不整对象下载——
   * 目的是核对「文件内容真的是它声称的图片类型」：
   * presigned PUT 的 Content-Type 由客户端自报，把一个改了扩展名的
   * 非图片文件传上来是挡不住的，只有看字节头才作数。
   *
   * 对象不存在返回 null；读流失败按 null 处理（调用方按「校验不过」走）。
   */
  async readObjectHead(key: string, length = 16): Promise<Buffer | null> {
    try {
      const res = await this.internalClient.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${length - 1}`,
        }),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  /** 删除对象（清理孤儿用） */
  async deleteObject(key: string): Promise<void> {
    try {
      await this.internalClient.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      // 对象不存在时静默忽略——清理任务要能重复执行
    }
  }

  /**
   * 签发一个**限时**的读 URL。
   *
   * 为什么不用固定 URL：Chainguard 版 MinIO 不支持 `PutBucketPolicy`
   * （实测返回 NotImplemented），配不了匿名读；而 bucket 保持私有时，
   * 浏览器 `<img src>` 直接 GET 会拿到 403，图片根本显示不出来。
   *
   * presigned GET 是 S3 标准 API，MinIO 支持（实测 200），
   * 而且比匿名读更安全：URL 带时效、且只能读不能写。
   *
   * 时效 1 小时——够页面渲染与浏览器缓存，不够长期泄露。
   */
  async createReadUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.publicClient, command, {
      expiresIn: READ_URL_TTL_SECONDS,
    });
  }

  /** 批量签发读 URL（商品详情一次要返回多张图） */
  async createReadUrls(keys: string[]): Promise<string[]> {
    return Promise.all(keys.map((key) => this.createReadUrl(key)));
  }

  getBucketName(): string {
    return this.bucket;
  }
}
