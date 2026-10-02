import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ResourceNotFoundException } from '../../../core/exceptions/app.exception';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { dedupeKeys } from '../domain/dedupe-keys';
import { RULE_CATALOGUE } from '../domain/rule-catalogue';
import { RuleKey } from '../domain/rule-keys';
import { LeaderboardService } from './leaderboard.service';
import { PointsAwardService } from './points-award.service';
import { SeasonService } from './season.service';

/**
 * A score is "suspicious" when this much of it comes from one rule. Farming
 * leaves exactly that fingerprint: a human uses the app in several ways, a
 * script repeats the single most profitable one.
 */
const CONCENTRATION_THRESHOLD = 0.8;
/** Below this, concentration means nothing — a new user has one or two rows. */
const MIN_POINTS_TO_JUDGE = 200;

@Injectable()
export class AdminPointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seasons: SeasonService,
    private readonly ranking: LeaderboardService,
    private readonly awards: PointsAwardService,
  ) {}

  async leaderboard(query: {
    season?: string;
    page?: number;
    limit?: number;
    search?: string;
  }) {
    const season = query.season
      ? await this.seasons.bySlug(query.season)
      : await this.seasons.currentOrLatest();
    if (!season) return { season: null, page: 1, limit: 0, total: 0, rows: [] };

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const balances = await this.prisma.pointBalance.findMany({
      where: {
        seasonId: season.id,
        user: {
          deletedAt: null,
          role: 'CUSTOMER',
          ...(query.search
            ? {
                OR: [
                  { firstName: { contains: query.search, mode: 'insensitive' as const } },
                  { lastName: { contains: query.search, mode: 'insensitive' as const } },
                  { phone: { contains: query.search } },
                  { email: { contains: query.search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
      },
      orderBy: [{ totalPoints: 'desc' }, { lastAwardAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        userId: true,
        totalPoints: true,
        cachedRank: true,
        lastAwardAt: true,
        user: {
          select: { firstName: true, lastName: true, phone: true, email: true, createdAt: true },
        },
      },
    });

    const breakdowns = await this.breakdownsFor(
      season.id,
      balances.map((b) => b.userId),
    );

    const total = await this.ranking.participantCount(season.id);

    return {
      season: { slug: season.slug, name: season.name, endsAt: season.endsAt, closed: Boolean(season.closedAt) },
      page,
      limit,
      total,
      rows: balances.map((b, i) => {
        const breakdown = breakdowns.get(b.userId) ?? [];
        return {
          rank: b.cachedRank ?? (page - 1) * limit + i + 1,
          userId: b.userId,
          name: `${b.user.firstName} ${b.user.lastName}`,
          phone: b.user.phone,
          email: b.user.email,
          joinedAt: b.user.createdAt,
          totalPoints: b.totalPoints,
          lastAwardAt: b.lastAwardAt,
          breakdown,
          suspicious: isConcentrated(b.totalPoints, breakdown),
        };
      }),
    };
  }

  async userDetail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true, phone: true, email: true, createdAt: true },
    });
    if (!user) throw new ResourceNotFoundException('User', userId);

    const season = await this.seasons.currentOrLatest();

    const [events, opens, balance, lessons] = await Promise.all([
      this.prisma.pointEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true,
          ruleKey: true,
          points: true,
          awardedOn: true,
          createdAt: true,
          metadata: true,
          dedupeKey: true,
        },
      }),
      this.prisma.notificationOpen.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, notificationId: true, latencyMs: true, awarded: true, rejectedReason: true, createdAt: true },
      }),
      season
        ? this.prisma.pointBalance.findUnique({
            where: { userId_seasonId: { userId, seasonId: season.id } },
            select: { totalPoints: true, cachedRank: true, lastAwardAt: true },
          })
        : null,
      this.prisma.lessonCompletion.findMany({
        where: { userId },
        select: { lessonId: true, completedAt: true },
        orderBy: { completedAt: 'asc' },
      }),
    ]);

    const breakdown = season
      ? (await this.breakdownsFor(season.id, [userId])).get(userId) ?? []
      : [];

    return {
      user: { ...user, name: `${user.firstName} ${user.lastName}` },
      season: season ? { slug: season.slug, name: season.name } : null,
      totalPoints: balance?.totalPoints ?? 0,
      rank: balance?.cachedRank ?? null,
      lastAwardAt: balance?.lastAwardAt ?? null,
      breakdown,
      suspicious: isConcentrated(balance?.totalPoints ?? 0, breakdown),
      events: events.map((e) => ({
        ...e,
        title: RULE_CATALOGUE[e.ruleKey as RuleKey]?.title.en ?? e.ruleKey,
      })),
      notificationOpens: opens,
      lessons,
    };
  }

  async adjust(userId: string, points: number, reason: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new ResourceNotFoundException('User', userId);

    const result = await this.awards.award({
      userId,
      ruleKey: 'ADMIN_ADJUSTMENT',
      dedupeKey: dedupeKeys.adjustment(randomUUID()),
      pointsOverride: points,
      bypassCap: true,
      metadata: { reason },
    });
    return { awarded: result.awarded, points, reason, newTotal: result.newTotal };
  }

  private async breakdownsFor(seasonId: string, userIds: string[]) {
    if (!userIds.length) return new Map<string, Array<{ ruleKey: string; points: number; count: number }>>();

    const rows = await this.prisma.pointEvent.groupBy({
      by: ['userId', 'ruleKey'],
      where: { seasonId, userId: { in: userIds } },
      _sum: { points: true },
      _count: { _all: true },
    });

    const map = new Map<string, Array<{ ruleKey: string; points: number; count: number }>>();
    for (const r of rows) {
      const list = map.get(r.userId) ?? [];
      list.push({ ruleKey: r.ruleKey, points: r._sum.points ?? 0, count: r._count._all });
      map.set(r.userId, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.points - a.points);
    return map;
  }
}

function isConcentrated(
  total: number,
  breakdown: Array<{ ruleKey: string; points: number }>,
): boolean {
  if (total < MIN_POINTS_TO_JUDGE || breakdown.length === 0) return false;
  const biggest = Math.max(...breakdown.map((b) => b.points));
  return biggest / total >= CONCENTRATION_THRESHOLD;
}
