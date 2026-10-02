import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { RULE_CATALOGUE, PUBLIC_RULE_ORDER } from '../domain/rule-catalogue';
import { RuleKey } from '../domain/rule-keys';
import { LeaderboardService, displayName } from './leaderboard.service';
import { TOTAL_LESSONS } from './milestone.service';
import { Lang, PointsRulesService } from './points-rules.service';
import { SeasonService } from './season.service';

/**
 * Read side of the Board tab. Everything that only assembles a response for
 * the app lives here, so the award path and the query path stay separate.
 */
@Injectable()
export class PointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seasons: SeasonService,
    private readonly ranking: LeaderboardService,
    private readonly rulesService: PointsRulesService,
  ) {}

  rules(userId: string, lang: Lang) {
    return this.rulesService.catalogueFor(userId, lang);
  }

  leaderboard(userId: string, opts: { season?: string; page?: number; limit?: number }) {
    return this.buildBoard(userId, opts);
  }

  private async buildBoard(
    userId: string,
    opts: { season?: string; page?: number; limit?: number },
  ) {
    const season = opts.season
      ? await this.seasons.bySlug(opts.season)
      : await this.seasons.currentOrLatest();

    if (!season) {
      return {
        season: null,
        page: 1,
        limit: opts.limit ?? 25,
        total: 0,
        totalPages: 0,
        rows: [],
        me: null,
      };
    }

    const page = opts.page ?? 1;
    const limit = opts.limit ?? 25;
    const { rows, total } = await this.ranking.page(season, userId, page, limit);

    const onThisPage = rows.find((r) => r.isMe);
    const mine = onThisPage
      ? {
          rank: onThisPage.rank,
          points: onThisPage.points,
          movement: onThisPage.movement,
          displayName: onThisPage.displayName,
          onThisPage: true,
        }
      : await this.meBlock(season.id, userId);

    return {
      season: {
        slug: season.slug,
        name: season.name,
        endsAt: season.endsAt,
        closed: Boolean(season.closedAt),
        daysRemaining: this.seasons.daysRemaining(season),
      },
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      rows: rows.map(({ userId: _omit, ...row }) => row),
      me: mine,
    };
  }

  async summary(userId: string) {
    const season = await this.seasons.currentOrLatest();
    if (!season) {
      return {
        totalPoints: 0,
        rank: null,
        percentile: null,
        movement: null,
        currentStreak: 0,
        longestStreak: 0,
        checkedInToday: false,
        pointsToday: 0,
        nextMilestone: null,
        season: null,
      };
    }

    const [rank, streak, today, earned] = await Promise.all([
      this.ranking.rankOf(season, userId),
      this.prisma.pointStreak.findUnique({
        where: { userId_seasonId: { userId, seasonId: season.id } },
      }),
      this.prisma.pointEvent.aggregate({
        where: { userId, seasonId: season.id, createdAt: { gte: startOfToday() } },
        _sum: { points: true },
      }),
      this.prisma.pointEvent.findMany({
        where: { userId, seasonId: season.id },
        select: { ruleKey: true },
        distinct: ['ruleKey'],
      }),
    ]);

    const earnedKeys = new Set(earned.map((e) => e.ruleKey));
    const nextMilestone = await this.nextMilestone(userId, earnedKeys);

    return {
      season: {
        slug: season.slug,
        name: season.name,
        endsAt: season.endsAt,
        closed: Boolean(season.closedAt),
        daysRemaining: this.seasons.daysRemaining(season),
      },
      totalPoints: rank.points,
      rank: rank.rank,
      percentile: rank.percentile,
      movement: rank.movement,
      totalParticipants: rank.totalParticipants,
      currentStreak: streak?.currentStreak ?? 0,
      longestStreak: streak?.longestStreak ?? 0,
      checkedInToday: streak ? sameDay(streak.lastCheckInOn) : false,
      pointsToday: today._sum.points ?? 0,
      nextMilestone,
    };
  }

  async rank(userId: string) {
    const season = await this.seasons.currentOrLatest();
    if (!season) {
      return { rank: null, totalPoints: 0, totalParticipants: 0, percentile: null, movement: null };
    }
    const r = await this.ranking.rankOf(season, userId);
    return {
      rank: r.rank,
      totalPoints: r.points,
      totalParticipants: r.totalParticipants,
      percentile: r.percentile,
      movement: r.movement,
    };
  }

  async history(userId: string, limit: number, offset: number) {
    const [rows, total] = await Promise.all([
      this.prisma.pointEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          ruleKey: true,
          points: true,
          createdAt: true,
          metadata: true,
        },
      }),
      this.prisma.pointEvent.count({ where: { userId } }),
    ]);

    return {
      total,
      limit,
      offset,
      items: rows.map((r) => ({
        id: r.id,
        ruleKey: r.ruleKey,
        title: RULE_CATALOGUE[r.ruleKey as RuleKey]?.title.en ?? r.ruleKey,
        points: r.points,
        createdAt: r.createdAt,
        metadata: r.metadata,
      })),
    };
  }

  async lessons(userId: string) {
    const rows = await this.prisma.lessonCompletion.findMany({
      where: { userId },
      select: { lessonId: true, completedAt: true },
      orderBy: { completedAt: 'asc' },
    });
    return {
      completedLessons: rows.map((r) => r.lessonId),
      totalLessons: TOTAL_LESSONS,
    };
  }

  private async meBlock(seasonId: string, userId: string) {
    const season = await this.prisma.competitionSeason.findUnique({ where: { id: seasonId } });
    if (!season) return null;
    const r = await this.ranking.rankOf(season, userId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return {
      rank: r.rank,
      points: r.points,
      movement: r.movement,
      displayName: user ? displayName(user.firstName, user.lastName) : null,
      onThisPage: false,
    };
  }

  /** The nearest unearned milestone, with how far along the user is. */
  private async nextMilestone(userId: string, earned: Set<string>) {
    const candidates = PUBLIC_RULE_ORDER.filter(
      (k) => RULE_CATALOGUE[k].group === 'MILESTONES' && !earned.has(k),
    );
    if (!candidates.length) return null;

    const key = candidates[0];
    const rule = RULE_CATALOGUE[key];

    let current = 0;
    let target = 1;
    if (key === 'MILESTONE_ALL_LESSONS') {
      current = await this.prisma.lessonCompletion.count({ where: { userId } });
      target = TOTAL_LESSONS;
    } else if (key === 'MILESTONE_THREE_STOCKS' || key === 'MILESTONE_FIVE_STOCKS') {
      current = await this.prisma.holding.count({ where: { userId, quantity: { gt: 0 } } });
      target = key === 'MILESTONE_THREE_STOCKS' ? 3 : 5;
    } else if (key === 'MILESTONE_FIRST_TRADE') {
      current = await this.prisma.trade.count({ where: { order: { userId } } });
      target = 1;
    }

    return {
      key,
      title: rule.title.en,
      points: rule.points,
      progress: { current: Math.min(current, target), target },
    };
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function sameDay(day: Date): boolean {
  const today = new Date();
  return (
    day.getUTCFullYear() === today.getUTCFullYear() &&
    day.getUTCMonth() === today.getUTCMonth() &&
    day.getUTCDate() === today.getUTCDate()
  );
}
