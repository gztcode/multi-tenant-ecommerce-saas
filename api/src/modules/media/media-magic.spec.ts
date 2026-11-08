import { isMagicMatched } from './media.service';

/**
 * magic bytes 比对的单元测试（阶段 11）。
 *
 * presigned PUT 的 Content-Type 是客户端自报的——这里是「内容与类型
 * 声明不符就拒绝入库」的最后一道闸。
 */
describe('isMagicMatched', () => {
  it('JPEG：FFD8FF 开头通过', () => {
    const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(isMagicMatched(head, 'image/jpeg')).toBe(true);
  });

  it('PNG：完整 8 字节签名通过', () => {
    const head = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    expect(isMagicMatched(head, 'image/png')).toBe(true);
  });

  it('PNG：签名错一个字节就拒绝', () => {
    const head = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b, 0x00,
    ]);
    expect(isMagicMatched(head, 'image/png')).toBe(false);
  });

  it('GIF：GIF89a / GIF87a 都通过', () => {
    expect(isMagicMatched(Buffer.from('GIF89a...'), 'image/gif')).toBe(true);
    expect(isMagicMatched(Buffer.from('GIF87a...'), 'image/gif')).toBe(true);
    expect(isMagicMatched(Buffer.from('GIF86a...'), 'image/gif')).toBe(false);
  });

  it('WebP：RIFF 头 + 第 8-11 字节 WEBP 通过', () => {
    const head = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      Buffer.from('WEBP'),
    ]);
    expect(isMagicMatched(head, 'image/webp')).toBe(true);
    expect(isMagicMatched(Buffer.from('RIFF????WEPX'), 'image/webp')).toBe(
      false,
    );
  });

  it('⚠️ 内容与类型不符：把文本伪装成 PNG 会被拒绝', () => {
    const head = Buffer.from('#!/bin/sh\nrm -rf /\n');
    expect(isMagicMatched(head, 'image/png')).toBe(false);
    expect(isMagicMatched(head, 'image/jpeg')).toBe(false);
  });

  it('空缓冲与 null 一律拒绝', () => {
    expect(isMagicMatched(Buffer.alloc(0), 'image/png')).toBe(false);
    expect(isMagicMatched(null, 'image/png')).toBe(false);
  });

  it('不在白名单的 MIME 兜底拒绝', () => {
    const head = Buffer.from([0xff, 0xd8, 0xff]);
    expect(isMagicMatched(head, 'application/pdf')).toBe(false);
  });
});
