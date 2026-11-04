import { TokenGraceService } from './token-grace.service';

const NOW = new Date('2026-11-04T00:00:00.000Z');

function fakePrisma() {
  return {
    databaseNow: jest.fn().mockResolvedValue(NOW),
    refreshToken: {
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
}

function makeService(prisma: ReturnType<typeof fakePrisma>) {
  return new TokenGraceService(prisma as never, {} as never);
}

describe('TokenGraceService.cleanup', () => {
  it('删除超过 30 天保留期的过期行', async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma);

    const result = await service.cleanup();

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: {
          lt: new Date('2026-10-05T00:00:00.000Z'),
        },
      },
    });
    expect(result.deleted).toBe(2);
  });

  it('仍然抹掉已过宽限期的密文', async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma);

    const result = await service.cleanup();

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        graceExpiresAt: { lt: NOW },
        rotatedToToken: { not: null },
      },
      data: { rotatedToToken: null },
    });
    expect(result.cleared).toBe(3);
  });
});
