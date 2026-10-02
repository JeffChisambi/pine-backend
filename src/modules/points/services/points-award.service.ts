import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { appConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { toMalawiDay } from '../domain/malawi-day';
import { getRule } from '../domain/rule-catalogue';
import { AwardRejection, RuleKey } from '../domain/rule-keys';
import { SeasonService } from './season.service';

export interface AwardRequest {
  userId: string;
  ruleKey: RuleKey;
  dedupeKey: string;
  metadata?: Prisma.InputJsonValue;
  /** When the thing being rewarded happened. Defaults to now; the backfill
   *  passes a historical time so the award lands on the right day. */
  occurredAt?: Date;
  /** Overrides the catalogue amount. Only the admin adjustment uses this. */
  pointsOverride?: number;
  /** Skips the daily cap. Only the admin adjustment uses this. */
  bypassCap?: boolean;
}

export interface AwardResult {
  awarded: boolean;
  points: number;
  reason?: AwardRejection;
  /** The user's season total after this call, awarded or not. */
  newTotal: number;
}

/**
 * The only thing in the system that writes a point.
 *
 * Everything funnels through `award()` so the cap check cannot be forgotten
 * at a call site — there is no other call site. The checks run inside one
 * transaction holding a per-user advisory lock, which is the part that makes
 * the caps real: a unique key stops a *replay*, but ten settlements arriving
 * at once carry ten different trade ids, and without the lock each would read
 * "no sells yet today" and all ten would pass a cap of two. Practice mode
 * fills orders instantly, so that race is one shell script away.
 */
@Injectable()
export class PointsAwardService {
  private readonly logger = new Logger(PointsAwardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly seasons: SeasonService,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  async award(req: AwardRequest): Promise<AwardResult> {
    // Belt and braces: even if a listener were somehow wired on a real-money
    // instance, no row can be written.
    if (!this.app.pointsEnabled) {
      return { awarded: false, points: 0, reason: 'DISABLED', newTotal: 0 };
    }

    const occurredAt = req.occurredAt ?? new Date();
    const season = await this.seasons.seasonFor(occurredAt);
    if (!season) {
      return { awarded: false, points: 0, reason: 'NO_SEASON', newTotal: 0 };
    }
    if (season.closedAt) {
      return { awarded: false, points: 0, reason: 'SEASON_CLOSED', newTotal: 0 };
    }

    const rule = getRule(req.ruleKey);
    const points = req.pointsOverride ?? rule.points;
    const awardedOn = toMalawiDay(occurredAt, this.app.timezone);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialise every award for this one user; different users stay fully
        // parallel. Released on commit.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${req.userId}, 0))`;

        const current = await tx.pointBalance.findUnique({
          where: { userId_seasonId: { userId: req.userId, seasonId: season.id } },
          select: { totalPoints: true },
        });
        const totalBefore = current?.totalPoints ?? 0;

        const reject = (reason: AwardRejection): AwardResult => ({
          awarded: false,
          points: 0,
          reason,
          newTotal: totalBefore,
        });

        const already = await tx.pointEvent.findUnique({
          where: { dedupeKey: req.dedupeKey },
          select: { id: true },
        });
        if (already) return reject('DUPLICATE');

        if (rule.oneTime) {
          const ever = await tx.pointEvent.findFirst({
            where: { userId: req.userId, seasonId: season.id, ruleKey: req.ruleKey },
            select: { id: true },
          });
          if (ever) return reject('ALREADY_EARNED');
        }

        if (!req.bypassCap && rule.dailyCap !== null) {
          const today = await tx.pointEvent.count({
            where: { userId: req.userId, ruleKey: req.ruleKey, awardedOn },
          });
          if (today >= rule.dailyCap) return reject('CAPPED');
        }

        await tx.pointEvent.create({
          data: {
            userId: req.userId,
            seasonId: season.id,
            ruleKey: req.ruleKey,
            points,
            awardedOn,
            dedupeKey: req.dedupeKey,
            metadata: req.metadata,
          },
        });

        // Written in the same transaction as the event, so the balance can
        // never drift from the ledger. lastAwardAt is the leaderboard
        // tie-break and must only move when the total actually changes.
        const balance = await tx.pointBalance.upsert({
          where: { userId_seasonId: { userId: req.userId, seasonId: season.id } },
          create: {
            userId: req.userId,
            seasonId: season.id,
            totalPoints: points,
            lastAwardAt: occurredAt,
          },
          update: {
            totalPoints: { increment: points },
            lastAwardAt: occurredAt,
          },
          select: { totalPoints: true },
        });

        return { awarded: true, points, newTotal: balance.totalPoints };
      });
    } catch (error) {
      // A concurrent insert of the same key loses the race on the unique
      // index. That is the correct outcome, not an error.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const total = await this.totalFor(req.userId, season.id);
        return { awarded: false, points: 0, reason: 'DUPLICATE', newTotal: total };
      }
      throw error;
    }
  }

  async totalFor(userId: string, seasonId: string): Promise<number> {
    const row = await this.prisma.pointBalance.findUnique({
      where: { userId_seasonId: { userId, seasonId } },
      select: { totalPoints: true },
    });
    return row?.totalPoints ?? 0;
  }
}
