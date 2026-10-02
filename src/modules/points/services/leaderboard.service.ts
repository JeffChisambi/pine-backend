import { Injectable, Logger } from '@nestjs/common';
import { CompetitionSeason } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

export interface BoardRow {
  rank: number;
  userId: string;
  displayName: string;
  points: number;
  /** Places gained since the last snapshot. Positive is upward. */
  movement: number | null;
  isMe: boolean;
}

interface RawBoardRow {
  userId: string;
  totalPoints: number;
  cachedRank: number | null;
  previousRank: number | null;
  firstName: string;
  lastName: string;
  rank: bigint;
}

/**
 * Ranking.
 *
 * Rank is computed live on every read rather than served from a snapshot.
 * The cohort is small, and a board that disagrees with the points total a
 * user just watched go up is a support ticket. The cached rank exists only
 * to draw the movement arrow, which is *supposed* to compare against an
 * older state.
 *
 * THE INVARIANT: the ORDER BY in `page()` and the WHERE in `rankOf()` must
 * describe the same ordering, term for term. If they ever drift, a user's own
 * rank and their position in the list disagree, and for a cash prize that is
 * the one bug that matters. They are kept adjacent here for that reason, and
 * `leaderboard.service.spec.ts` asserts they agree for every seeded user.
 *
 * Tie-break: points, then whoever reached that total first, then id as a
 * final deterministic fallback so two identical rows cannot swap places
 * between two reads.
 */
@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(private readonly prisma: PrismaService) {}

  async page(
    season: CompetitionSeason,
    meUserId: string,
    page: number,
    limit: number,
  ): Promise<{ rows: BoardRow[]; total: number }> {
    const offset = (page - 1) * limit;

    const raw = await this.prisma.$queryRaw<RawBoardRow[]>`
      SELECT pb."userId",
             pb."totalPoints",
             pb."cachedRank",
             pb."previousRank",
             u."firstName",
             u."lastName",
             RANK() OVER (
               ORDER BY pb."totalPoints" DESC,
                        pb."lastAwardAt" ASC NULLS LAST,
                        pb."id" ASC
             ) AS rank
      FROM point_balances pb
      JOIN users u ON u."id" = pb."userId"
      WHERE pb."seasonId" = ${season.id}::uuid
        AND u."deletedAt" IS NULL
        AND u."role" = 'CUSTOMER'
      ORDER BY rank
      LIMIT ${limit} OFFSET ${offset}
    `;

    const total = await this.participantCount(season.id);

    return {
      total,
      rows: raw.map((r) => ({
        rank: Number(r.rank),
        userId: r.userId,
        displayName: displayName(r.firstName, r.lastName),
        points: r.totalPoints,
        movement:
          r.previousRank !== null && r.cachedRank !== null
            ? r.previousRank - r.cachedRank
            : null,
        isMe: r.userId === meUserId,
      })),
    };
  }

  /**
   * One user's rank, without paging to find them.
   *
   * "How many people beat me, plus one" is the definition of rank, and as a
   * counting query it is an index-range count rather than a scan — cheapest
   * for the users near the top and trivial everywhere else. This is what lets
   * someone on page 74 see their position on page 1.
   */
  async rankOf(
    season: CompetitionSeason,
    userId: string,
  ): Promise<{
    rank: number | null;
    points: number;
    movement: number | null;
    totalParticipants: number;
    percentile: number | null;
  }> {
    const mine = await this.prisma.pointBalance.findUnique({
      where: { userId_seasonId: { userId, seasonId: season.id } },
      select: { id: true, totalPoints: true, lastAwardAt: true, cachedRank: true, previousRank: true },
    });
    const totalParticipants = await this.participantCount(season.id);

    if (!mine) {
      return { rank: null, points: 0, movement: null, totalParticipants, percentile: null };
    }

    // Mirrors page()'s ORDER BY exactly: strictly greater points, or equal
    // points reached earlier, or equal on both with a lower id.
    const [{ rank }] = await this.prisma.$queryRaw<{ rank: bigint }[]>`
      SELECT COUNT(*) + 1 AS rank
      FROM point_balances pb
      JOIN users u ON u."id" = pb."userId"
      WHERE pb."seasonId" = ${season.id}::uuid
        AND u."deletedAt" IS NULL
        AND u."role" = 'CUSTOMER'
        AND (
              pb."totalPoints" > ${mine.totalPoints}
          OR (pb."totalPoints" = ${mine.totalPoints}
              AND pb."lastAwardAt" IS NOT NULL
              AND (${mine.lastAwardAt}::timestamp IS NULL
                   OR pb."lastAwardAt" < ${mine.lastAwardAt}::timestamp))
          OR (pb."totalPoints" = ${mine.totalPoints}
              AND pb."lastAwardAt" IS NOT DISTINCT FROM ${mine.lastAwardAt}::timestamp
              AND pb."id" < ${mine.id}::uuid)
        )
    `;

    const r = Number(rank);
    return {
      rank: r,
      points: mine.totalPoints,
      movement:
        mine.previousRank !== null && mine.cachedRank !== null
          ? mine.previousRank - mine.cachedRank
          : null,
      totalParticipants,
      percentile:
        totalParticipants > 0
          ? Math.round(((totalParticipants - r + 1) / totalParticipants) * 100)
          : null,
    };
  }

  async participantCount(seasonId: string): Promise<number> {
    const [{ count }] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
      FROM point_balances pb
      JOIN users u ON u."id" = pb."userId"
      WHERE pb."seasonId" = ${seasonId}::uuid
        AND u."deletedAt" IS NULL
        AND u."role" = 'CUSTOMER'
    `;
    return Number(count);
  }

  /**
   * Rewrites every cached rank, shifting the old one into previousRank so the
   * app can draw an arrow without keeping history on the device.
   */
  async refreshRankSnapshot(seasonId: string): Promise<number> {
    const updated = await this.prisma.$executeRaw`
      UPDATE point_balances pb
      SET "previousRank" = pb."cachedRank",
          "cachedRank"   = ranked.rank,
          "cachedAt"     = NOW()
      FROM (
        SELECT pb2."id",
               RANK() OVER (
                 ORDER BY pb2."totalPoints" DESC,
                          pb2."lastAwardAt" ASC NULLS LAST,
                          pb2."id" ASC
               )::int AS rank
        FROM point_balances pb2
        JOIN users u ON u."id" = pb2."userId"
        WHERE pb2."seasonId" = ${seasonId}::uuid
          AND u."deletedAt" IS NULL
          AND u."role" = 'CUSTOMER'
      ) ranked
      WHERE pb."id" = ranked."id"
    `;
    return updated;
  }
}

/** "Jeffrey Chisambi" becomes "Jeffrey C." — the surname never leaves here. */
export function displayName(firstName: string, lastName: string): string {
  const initial = lastName?.trim()?.[0];
  return initial ? `${firstName} ${initial.toUpperCase()}.` : firstName;
}
