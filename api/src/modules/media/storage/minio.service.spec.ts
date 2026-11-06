import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { MinioService } from './minio.service';

/**
 * bucket 自动创建（审计 P2-7）。
 *
 * ⚠️ **为什么必须有**：MinIO 镜像里没有 `mc`，compose 也不会建 bucket
 *    → 全新卷上「presigned 签发成功、但 PUT 返回 404 NoSuchBucket」，
 *    媒体表还会留下一堆 PENDING 垃圾行。
 */
describe('MinioService.ensureBucket', () => {
  function setup(send: jest.Mock<Promise<unknown>, [unknown]>): MinioService {
    const service = new MinioService();
    (service as unknown as { internalClient: unknown }).internalClient = {
      send,
    };
    return service;
  }

  it('bucket 已存在 → 只探一次，不创建', async () => {
    const send = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({});

    await setup(send).ensureBucket();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
  });

  it('bucket 不存在（404）→ 建一个', async () => {
    const notFound = Object.assign(new Error('NotFound'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const send = jest
      .fn<Promise<unknown>, [unknown]>()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({});

    await setup(send).ensureBucket();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
  });

  it('MinIO 不可达 → 不建、也不抛（不挡启动）', async () => {
    const send = jest
      .fn<Promise<unknown>, [unknown]>()
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(setup(send).ensureBucket()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('鉴权失败（403）→ 不建（不是「不存在」）', async () => {
    const send = jest.fn<Promise<unknown>, [unknown]>().mockRejectedValue(
      Object.assign(new Error('AccessDenied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    );

    await setup(send).ensureBucket();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
  });
});
