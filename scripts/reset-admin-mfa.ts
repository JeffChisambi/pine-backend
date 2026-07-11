const { PrismaClient } = require('@prisma/client');

async function resetAdminMfa() {
  const prisma = new PrismaClient();
  try {
    const admin = await prisma.user.findUnique({ where: { email: 'admin@pine.mw' } });
    if (!admin) {
      console.log('Admin user not found!');
      return;
    }
    const result = await prisma.mfaConfig.deleteMany({
      where: { userId: admin.id },
    });
    console.log('✅ Deleted MFA configs for admin@pine.mw:', result.count);
  } finally {
    await prisma.$disconnect();
  }
}

resetAdminMfa().catch(console.error);
