#!/usr/bin/env node
/**
 * Seed treasury_products from scripts/treasury-seed.json. Idempotent by tenorDays.
 *   docker exec kapwanje-api node scripts/seed-treasury.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'treasury-seed.json'), 'utf8'));
let created = 0, skipped = 0;
for (const a of items) {
  const exists = await prisma.treasuryProduct.findFirst({ where: { tenorDays: a.tenorDays } });
  if (exists) { skipped++; continue; }
  await prisma.treasuryProduct.create({
    data: {
      label: a.label, tenorDays: a.tenorDays, yieldPercent: a.yieldPercent, minAmount: a.minAmount,
      riskLevel: a.riskLevel, status: a.status, isActive: true, currency: 'MWK',
      auctionDate: a.auctionDate ? new Date(a.auctionDate) : null,
      issueDate: a.issueDate ? new Date(a.issueDate) : null,
      maturityDate: a.maturityDate ? new Date(a.maturityDate) : null,
    },
  });
  created++;
}
console.log(`Treasury seed complete: ${created} created, ${skipped} skipped.`);
await prisma.$disconnect();
