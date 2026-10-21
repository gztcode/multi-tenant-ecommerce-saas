import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
  const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';

  const existing = await prisma.user.findFirst({
    where: { email, role: UserRole.PLATFORM_ADMIN },
  });

  if (existing) {
    console.log(`平台超管已存在，跳过：${email}`);
    return;
  }

  try {
    await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password),
        displayName: '平台超管',
        role: UserRole.PLATFORM_ADMIN,
        tenantId: null,
      },
    });
  } catch (error) {
    // 平台超管邮箱由部分唯一索引 users_platform_admin_email_key 兜底，
    // 并发执行 seed 时后到的一方会撞唯一约束，此时同样视为幂等成功。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      console.log(`平台超管已存在（并发创建），跳过：${email}`);
      return;
    }
    throw error;
  }

  console.log(`已创建平台超管：${email} / ${password}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
