#!/usr/bin/env node
/**
 * Wipe ALL investor (role=CUSTOMER) accounts and every row that belongs to
 * them — wallets, ledger, orders, trades, holdings, KYC, notifications,
 * support tickets, portfolio snapshots, payments. Staff accounts
 * (SUPER_ADMIN, BROKER, officers, support) and platform data (brokers,
 * stocks, prices, news, treasury products, fee configs) are untouched.
 *
 * DESTRUCTIVE. Take a pg_dump BEFORE running. Deletes run inside a single
 * transaction — either the whole wipe commits or nothing does.
 *
 * Usage: node scripts/wipe-customers.mjs [--dry-run]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const DRY = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

async function main() {
  const customers = await prisma.user.findMany({
    where: { role: 'CUSTOMER' },
    select: { id: true, email: true, phone: true },
  });
  const uids = customers.map((u) => u.id);

  const staff = await prisma.user.groupBy({ by: ['role'], _count: { id: true } });
  console.log('\nCurrent users by role:');
  for (const r of staff) console.log(`  ${r.role}: ${r._count.id}`);
  console.log(`\nWill delete ${uids.length} CUSTOMER account(s):`);
  for (const u of customers.slice(0, 30)) console.log(`  - ${u.email ?? u.phone}`);
  if (customers.length > 30) console.log(`  … and ${customers.length - 30} more`);

  if (uids.length === 0) { console.log('\nNothing to delete.'); return; }
  if (DRY) { console.log('\n--dry-run: no changes made.'); return; }

  const wallets = await prisma.wallet.findMany({ where: { userId: { in: uids } }, select: { id: true } });
  const wids = wallets.map((w) => w.id);
  const orders = await prisma.order.findMany({ where: { userId: { in: uids } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  const trades = await prisma.trade.findMany({ where: { orderId: { in: oids } }, select: { id: true } });
  const tids = trades.map((t) => t.id);
  const payments = await prisma.payment.findMany({ where: { userId: { in: uids } }, select: { id: true } });
  const pids = payments.map((p) => p.id);

  console.log('\nDeleting (single transaction)…');
  await prisma.$transaction(async (tx) => {
    const step = async (label, fn) => {
      const r = await fn();
      console.log(`  ${label}: ${r.count ?? r}`);
    };
    // Trading chain
    await step('settlement records', () => tx.settlementRecord.deleteMany({ where: { tradeId: { in: tids } } }));
    await step('trade audits', () => tx.tradeAudit.deleteMany({ where: { orderId: { in: oids } } }));
    await step('order executions', () => tx.orderExecution.deleteMany({ where: { orderId: { in: oids } } }));
    await step('trades', () => tx.trade.deleteMany({ where: { orderId: { in: oids } } }));
    // Money chain
    await step('ledger entries', () => tx.ledgerEntry.deleteMany({
      where: { OR: [{ walletId: { in: wids } }, { transaction: { walletId: { in: wids } } }] },
    }));
    await step('transactions', () => tx.transaction.deleteMany({ where: { walletId: { in: wids } } }));
    await step('wallet reservations', () => tx.walletReservation.deleteMany({ where: { walletId: { in: wids } } }));
    await step('wallet snapshots', () => tx.walletSnapshot.deleteMany({ where: { walletId: { in: wids } } }));
    await step('orders', () => tx.order.deleteMany({ where: { id: { in: oids } } }));
    await step('holdings', () => tx.holding.deleteMany({ where: { userId: { in: uids } } }));
    await step('wallets', () => tx.wallet.deleteMany({ where: { id: { in: wids } } }));
    // Payments + webhooks
    await step('webhook events', () => tx.webhookEvent.deleteMany({ where: { paymentId: { in: pids } } }));
    await step('payments', () => tx.payment.deleteMany({ where: { id: { in: pids } } }));
    // Portfolio derivatives + dividends
    await step('portfolio snapshots', () => tx.portfolioSnapshot.deleteMany({ where: { userId: { in: uids } } }));
    await step('portfolio performance', () => tx.portfolioPerformance.deleteMany({ where: { userId: { in: uids } } }));
    await step('portfolio allocations', () => tx.portfolioAllocation.deleteMany({ where: { userId: { in: uids } } }));
    await step('dividend distributions', () => tx.dividendDistribution.deleteMany({ where: { userId: { in: uids } } }));
    // KYC
    await step('kyc documents', () => tx.kycDocument.deleteMany({ where: { kycApplication: { userId: { in: uids } } } }));
    await step('face embeddings', () => tx.faceEmbedding.deleteMany({ where: { userId: { in: uids } } }));
    await step('kyc applications', () => tx.kycApplication.deleteMany({ where: { userId: { in: uids } } }));
    // Notifications
    await step('notification deliveries', () => tx.notificationDelivery.deleteMany({ where: { notification: { userId: { in: uids } } } }));
    await step('notifications', () => tx.notification.deleteMany({ where: { userId: { in: uids } } }));
    await step('notification prefs', () => tx.notificationPreference.deleteMany({ where: { userId: { in: uids } } }));
    // Support (messages cascade from tickets)
    await step('support tickets', () => tx.supportTicket.deleteMany({ where: { userId: { in: uids } } }));
    // Misc user-scoped rows
    await step('linked banks', () => tx.linkedBank.deleteMany({ where: { userId: { in: uids } } }));
    await step('saved cards', () => tx.savedCard.deleteMany({ where: { userId: { in: uids } } }));
    await step('watchlist entries', () => tx.watchlistEntry.deleteMany({ where: { userId: { in: uids } } }));
    await step('treasury investments', () => tx.treasuryInvestment.deleteMany({ where: { userId: { in: uids } } }));
    await step('audit logs (as actor)', () => tx.auditLog.deleteMany({ where: { actorId: { in: uids } } }));
    // Auth/session artifacts
    await step('sessions', () => tx.session.deleteMany({ where: { userId: { in: uids } } }));
    await step('devices', () => tx.device.deleteMany({ where: { userId: { in: uids } } }));
    await step('otp codes', () => tx.otpCode.deleteMany({ where: { userId: { in: uids } } }));
    await step('mfa configs', () => tx.mfaConfig.deleteMany({ where: { userId: { in: uids } } }));
    await step('user preferences', () => tx.userPreference.deleteMany({ where: { userId: { in: uids } } }));
    // Finally, the users themselves
    await step('USERS', () => tx.user.deleteMany({ where: { id: { in: uids } } }));
  }, { timeout: 120_000 });

  const after = await prisma.user.groupBy({ by: ['role'], _count: { id: true } });
  console.log('\nRemaining users by role:');
  for (const r of after) console.log(`  ${r.role}: ${r._count.id}`);
  console.log('\n✓ Wipe complete.');
}

main()
  .catch((e) => { console.error('\nFATAL (transaction rolled back — nothing deleted):', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
