import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { LeaderboardService } from './leaderboard.service';
import { SeasonService } from './season.service';

/**
 * The two background jobs.
 *
 * Neither is on the authoritative path: balances are written in the same
 * transaction as the event that earned them, so nothing here is required for
 * the board to be correct. The snapshot only feeds the movement arrow, and
 * the reconciliation only tells us if something has gone wrong.
 */
@Injectable()
export class PointsMaintenanceService {
  private readonly logger = new Logger(PointsMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly seasons: SeasonService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  /** Ten minutes is the right grain for an arrow meaning "since recently". */
  @Cron('*/10 * * * *', { name: 'points-rank-snapshot' })
  async refreshRanks(): Promise<void> {
    try {
      const season = await this.seasons.seasonFor();
      if (!season || season.closedAt) return;
      const rows = await this.leaderboard.refreshRankSnapshot(season.id);
      this.logger.debug(`Refreshed ${rows} Pine Points ranks`);
    } catch (error) {
      this.logger.error({ err: error }, 'Pine Points rank snapshot failed');
    }
  }

  /**
   * Re-derives every balance from the ledger and shouts if one disagrees.
   * The same belt and braces the wallet ledger gets: a materialised total is
   * only trustworthy if something checks it.
   */
  @Cron('0 23 * * *', { name: 'points-balance-reconciliation' })
  async reconcile(): Promise<void> {
    try {
      const season = await this.seasons.seasonFor();
      if (!season) return;

      const drift = await this.prisma.$queryRaw<
        Array<{ userId: string; stored: number; derived: number }>
      >`
        SELECT pb."userId",
               pb."totalPoints" AS stored,
               COALESCE(SUM(pe."points"), 0)::int AS derived
        FROM point_balances pb
        LEFT JOIN point_events pe
          ON pe."userId" = pb."userId" AND pe."seasonId" = pb."seasonId"
        WHERE pb."seasonId" = ${season.id}::uuid
        GROUP BY pb."userId", pb."totalPoints"
        HAVING pb."totalPoints" <> COALESCE(SUM(pe."points"), 0)::int
      `;

      if (drift.length === 0) {
        this.logger.log('Pine Points balances reconcile with the ledger');
        return;
      }
      this.logger.error(
        { drift },
        `${drift.length} Pine Points balance(s) disagree with the ledger`,
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Pine Points reconciliation failed');
    }
  }
}
