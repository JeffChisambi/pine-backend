import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { dedupeKeys } from '../domain/dedupe-keys';
import { RuleKey } from '../domain/rule-keys';
import { PointsAwardService } from './points-award.service';
import { SeasonService } from './season.service';

/** How many lessons the mobile content pack ships. */
export const TOTAL_LESSONS = 6;

/**
 * Milestones derived from state rather than from a single event.
 *
 * These are re-evaluated after every trade and every lesson, which is only
 * affordable because they are all one-time rules: once awarded, the award
 * service refuses a second, so re-running the predicates costs a query and
 * can never double-pay. That is also why holdings flapping in and out of
 * existence is harmless — a user who sells down to one stock keeps the badge.
 */
@Injectable()
export class MilestoneService {
  private readonly logger = new Logger(MilestoneService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly awards: PointsAwardService,
    private readonly seasons: SeasonService,
  ) {}

  /** Call after any settled trade. */
  async evaluateTrading(userId: string, at: Date = new Date()): Promise<void> {
    const season = await this.seasons.seasonFor(at);
    if (!season) return;

    const [trades, distinctStocks] = await Promise.all([
      this.prisma.trade.count({ where: { order: { userId } } }),
      this.prisma.holding.count({ where: { userId, quantity: { gt: 0 } } }),
    ]);

    if (trades >= 1) {
      await this.grant(userId, 'MILESTONE_FIRST_TRADE', season.id, at, { trades });
    }
    if (distinctStocks >= 3) {
      await this.grant(userId, 'MILESTONE_THREE_STOCKS', season.id, at, { distinctStocks });
    }
    if (distinctStocks >= 5) {
      await this.grant(userId, 'MILESTONE_FIVE_STOCKS', season.id, at, { distinctStocks });
    }
  }

  /** Call after a lesson is recorded. Returns the milestone if it just paid. */
  async evaluateLessons(
    userId: string,
    at: Date = new Date(),
  ): Promise<{ key: RuleKey; points: number } | null> {
    const season = await this.seasons.seasonFor(at);
    if (!season) return null;

    const done = await this.prisma.lessonCompletion.count({ where: { userId } });
    if (done < TOTAL_LESSONS) return null;

    const result = await this.grant(userId, 'MILESTONE_ALL_LESSONS', season.id, at, {
      lessons: done,
    });
    return result.awarded ? { key: 'MILESTONE_ALL_LESSONS', points: result.points } : null;
  }

  private grant(
    userId: string,
    ruleKey: RuleKey,
    seasonId: string,
    at: Date,
    metadata: Record<string, unknown>,
  ) {
    return this.awards.award({
      userId,
      ruleKey,
      dedupeKey: dedupeKeys.milestone(userId, ruleKey, seasonId),
      occurredAt: at,
      metadata: metadata as never,
    });
  }
}
