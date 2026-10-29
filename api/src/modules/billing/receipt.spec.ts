import {
  shouldBackfillReceipt,
  shouldBackfillReceiptReversal,
} from './receipt.service';

describe('货款流水的回填判定', () => {
  it('没付过钱 → 不回填', () => {
    expect(shouldBackfillReceipt(null, 100)).toBe(false);
  });

  it('零额货款 → 不回填', () => {
    expect(shouldBackfillReceipt(new Date(), 0)).toBe(false);
  });

  it('正常订单 → 回填', () => {
    expect(shouldBackfillReceipt(new Date(), 100)).toBe(true);
  });

  it('⚠️ 零额抽佣但货款不为零 → 仍然回填（货款与抽佣的零额判定字段不同）', () => {
    // ⚠️ **这是与抽佣判定的关键差异**：抽佣看 `commissionAmount === 0`，
    // 货款看 `totalAmount === 0`。费率 0 的订单照样有货款要记。
    expect(shouldBackfillReceipt(new Date(), 100)).toBe(true);
  });

  describe('货款冲回的回填判定', () => {
    it('没退过款 → 不回填', () => {
      expect(shouldBackfillReceiptReversal(false, new Date(), 100)).toBe(false);
    });

    it('⚠️ 退过款但 refundedAt 为 null → 不回填（无法归期，与抽佣口径一致）', () => {
      expect(shouldBackfillReceiptReversal(true, null, 100)).toBe(false);
    });

    it('零额货款 → 不回填', () => {
      expect(shouldBackfillReceiptReversal(true, new Date(), 0)).toBe(false);
    });

    it('正常退款 → 回填', () => {
      expect(shouldBackfillReceiptReversal(true, new Date(), 100)).toBe(true);
    });
  });
});
