import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** 读 URL 的有效期：1 小时 */
const READ_URL_TTL_SECONDS = 60 * 60;

const MAX_PRESIGN_TTL_SECONDS = 15 * 60;

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
  private publicClient!: S3Client;
  private internalClient!: S3Client;
  private bucket!: string;

  constructor() {
    this.bucket = process.env.MINIO_BUCKET ?? 'ecommerce-media';
  }

  onModuleInit(): void {
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
