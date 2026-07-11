/**
 * Seeds baseline reference data needed for local development and CI:
 * a handful of real MSE-listed symbols and the current year's market
 * calendar (weekends + declared public holidays as CLOSED, everything
 * else OPEN). Safe to re-run — every write is an `upsert`.
 *
 * Run via `npm run prisma:seed` (also invoked automatically by
 * `prisma migrate dev` in local development, per the `prisma.seed`
 * entry below).
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const MSE_STOCKS = [
  { symbol: 'AIRTEL', name: 'Airtel Malawi plc', sector: 'Telecommunications' },
  { symbol: 'FDHB', name: 'FDH Bank plc', sector: 'Banking' },
  { symbol: 'ICON', name: 'ICON Properties plc', sector: 'Real Estate' },
  { symbol: 'ILLOVO', name: 'Illovo Sugar (Malawi) plc', sector: 'Agriculture' },
  { symbol: 'MPICO', name: 'MPICO plc', sector: 'Real Estate' },
  { symbol: 'NBM', name: 'National Bank of Malawi plc', sector: 'Banking' },
  { symbol: 'NBS', name: 'NBS Bank plc', sector: 'Banking' },
  { symbol: 'NICO', name: 'NICO Holdings plc', sector: 'Insurance' },
  { symbol: 'NITL', name: 'National Investment Trust plc', sector: 'Investment' },
  { symbol: 'OMU', name: 'Old Mutual Limited', sector: 'Insurance' },
  { symbol: 'PCL', name: 'Press Corporation plc', sector: 'Conglomerate' },
  { symbol: 'STANDARD', name: 'Standard Bank Malawi plc', sector: 'Banking' },
  { symbol: 'SUNBIRD', name: 'Sunbird Tourism plc', sector: 'Hospitality' },
  { symbol: 'TNM', name: 'Telekom Networks Malawi plc', sector: 'Telecommunications' },
];

const PUBLIC_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-03-03', // Martyrs' Day
  '2026-04-03', // Good Friday
  '2026-04-06', // Easter Monday
  '2026-05-01', // Labour Day
  '2026-05-14', // Kamuzu Day
  '2026-07-06', // Independence Day
  '2026-10-15', // Mother's Day
  '2026-12-25', // Christmas Day
  '2026-12-26', // Boxing Day
];

async function main(): Promise<void> {
  console.log('🌱 Seeding stocks...');
  for (const stock of MSE_STOCKS) {
    await prisma.stock.upsert({
      where: { symbol: stock.symbol },
      update: { name: stock.name, sector: stock.sector },
      create: stock,
    });
  }

  console.log('🌱 Seeding market calendar...');
  const year = 2026;
  const holidaySet = new Set(PUBLIC_HOLIDAYS_2026);

  for (let month = 0; month < 12; month++) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(Date.UTC(year, month, day));
      const isoDate = date.toISOString().slice(0, 10);
      const dayOfWeek = date.getUTCDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const isHoliday = holidaySet.has(isoDate);

      await prisma.marketCalendar.upsert({
        where: { date },
        update: {},
        create: {
          date,
          status: isHoliday ? 'HOLIDAY' : isWeekend ? 'CLOSED' : 'OPEN',
          description: isHoliday ? 'Public holiday' : undefined,
        },
      });
    }
  }

  console.log('🌱 Seeding admin user...');
  const adminPassword = await argon2.hash('PineAdmin2026!', {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await prisma.user.upsert({
    where: { phone: '+265888000001' },
    update: {
      email: 'admin@pine.mw',
      firstName: 'Pine',
      lastName: 'Admin',
      role: 'SUPER_ADMIN',
      passwordHash: adminPassword,
      isActive: true,
      phoneVerifiedAt: new Date(),
      emailVerifiedAt: new Date(),
      kycStatus: 'APPROVED',
    },
    create: {
      phone: '+265888000001',
      email: 'admin@pine.mw',
      firstName: 'Pine',
      lastName: 'Admin',
      passwordHash: adminPassword,
      role: 'SUPER_ADMIN',
      isActive: true,
      phoneVerifiedAt: new Date(),
      emailVerifiedAt: new Date(),
      kycStatus: 'APPROVED',
    },
  });

  console.log('  ✓ Admin: admin@pine.mw / PineAdmin2026!');

  console.log('✅ Seed complete');
}

main()
  .catch((error: unknown) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
