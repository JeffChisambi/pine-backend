/**
 * Gives the practice users who were already here a fair starting score.
 *
 *   npx ts-node -r tsconfig-paths/register src/modules/points/scripts/backfill-points.ts [--apply]
 *
 * Dry run unless `--apply` is passed, and safe to run twice: every award
 * carries a deterministic dedupe key, so a second run inserts nothing.
 *
 * History is replayed through the SAME award service as live events, with the
 * original timestamps, so the daily caps apply exactly as they would have at
 * the time. Someone who churned fifty trades in one afternoon gets credit for
 * two, which is the point — a backfill must not hand out points the live
 * rules would have refused.
 *
 * Four rules are deliberately NOT backfilled: daily check-ins, compare opens,
 * notification opens and lesson completions. Nothing on the server records
 * that any of them ever happened — lesson progress lived only on each device
 * — so inventing them would be fabricating leaderboard positions. Lessons
 * backfill themselves the first time each app reports its local progress.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { dedupeKeys } from '../domain/dedupe-keys';
import { toMalawiDayString } from '../domain/malawi-day';
import { MIN_SCORING_NOTIONAL } from '../domain/rule-catalogue';
import { MilestoneService } from '../services/milestone.service';
import { PointsAwardService } from '../services/points-award.service';
import { SeasonService } from '../services/season.service';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const logger = new Logger('backfill-points');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);
    const awards = app.get(PointsAwardService);
    const milestones = app.get(MilestoneService);
    const seasons = app.get(SeasonService);

    const season = await seasons.ensureSeason();
    logger.log(`Season: ${season.name} (${season.slug})`);
    if (!apply) logger.warn('DRY RUN — pass --apply to write. Nothing will be saved.');

    const users = await prisma.user.findMany({
      where: { role: 'CUSTOMER', deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        emailVerifiedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    logger.log(`${users.length} practice investor(s) to consider`);

    const summary: Array<{ user: string; awarded: number; points: number }> = [];

    for (const user of users) {
      let awarded = 0;
      let points = 0;

      const give = async (
        ruleKey: Parameters<typeof awards.award>[0]['ruleKey'],
        dedupeKey: string,
        occurredAt: Date,
        metadata?: Record<string, unknown>,
      ) => {
        if (!apply) return;
        const r = await awards.award({
          userId: user.id,
          ruleKey,
          dedupeKey,
          occurredAt,
          metadata: metadata as never,
        });
        if (r.awarded) {
          awarded += 1;
          points += r.points;
        }
      };

      await give('SIGN_UP', dedupeKeys.signUp(user.id), user.createdAt);

      if (user.emailVerifiedAt) {
        await give(
          'PROFILE_EMAIL_VERIFIED',
          dedupeKeys.profile(user.id, 'email', season.id),
          user.emailVerifiedAt,
        );
      }

      // Deposits: one per day the user deposited. The day-shaped key does the
      // grouping for free, so several deposits in a day collapse into one row.
      const deposits = await prisma.transaction.findMany({
        where: {
          wallet: { userId: user.id },
          type: 'DEPOSIT',
          status: 'COMPLETED',
          createdAt: { gte: season.startsAt, lte: season.endsAt },
        },
        select: { amount: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const d of deposits) {
        if (d.amount.toNumber() < MIN_SCORING_NOTIONAL) continue;
        await give(
          'DEPOSIT_FUNDS',
          dedupeKeys.deposit(user.id, toMalawiDayString(d.createdAt)),
          d.createdAt,
          { amount: d.amount.toNumber(), backfilled: true },
        );
      }

      // Trades, oldest first so the caps bite in the order they really would.
      const trades = await prisma.trade.findMany({
        where: {
          order: { userId: user.id },
          createdAt: { gte: season.startsAt, lte: season.endsAt },
        },
        select: {
          id: true,
          quantity: true,
          price: true,
          createdAt: true,
          order: { select: { side: true, stock: { select: { symbol: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      });
      for (const t of trades) {
        const notional = t.quantity.toNumber() * t.price.toNumber();
        if (notional < MIN_SCORING_NOTIONAL) continue;
        const isBuy = t.order.side === 'BUY';
        await give(
          isBuy ? 'BUY_STOCK' : 'SELL_STOCK',
          isBuy ? dedupeKeys.buy(t.id) : dedupeKeys.sell(t.id),
          t.createdAt,
          { symbol: t.order.stock?.symbol, backfilled: true },
        );
      }

      if (apply) await milestones.evaluateTrading(user.id, new Date());

      summary.push({
        user: `${user.firstName} ${user.lastName}`.trim(),
        awarded,
        points,
      });
    }

    logger.log('─'.repeat(52));
    for (const row of summary.sort((a, b) => b.points - a.points)) {
      logger.log(`${row.user.padEnd(28)} ${String(row.points).padStart(6)} pts  (${row.awarded} awards)`);
    }
    logger.log('─'.repeat(52));
    logger.log(apply ? 'Backfill written.' : 'Dry run complete — nothing was written.');
  } finally {
    await app.close();
  }
}

// Exit explicitly: the application context leaves timers and queue
// connections behind after close(), which otherwise keep a one-off container
// running indefinitely.
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Backfill failed:', error);
  process.exit(1);
});
