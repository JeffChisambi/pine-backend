import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { appConfig } from '../../../config/configuration';
import { ResourceNotFoundException, ValidationException } from '../../../core/exceptions/app.exception';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { dedupeKeys } from '../domain/dedupe-keys';
import { toMalawiDay, toMalawiDayString, daysBetween } from '../domain/malawi-day';
import { AwardRejection, RuleKey } from '../domain/rule-keys';
import { MilestoneService, TOTAL_LESSONS } from './milestone.service';
import { PointsAwardService } from './points-award.service';
import { SeasonService } from './season.service';

/** The lessons the mobile content pack ships. An unknown id is a mistake. */
export const KNOWN_LESSON_IDS = [
  'what-is-a-stock',
  'how-the-exchange-works',
  'reading-stock-prices',
  'market-indices',
  'buy-sell-hold',
  'first-portfolio',
] as const;

/** How quickly a notification must be opened to score. */
const NOTIFICATION_WINDOW_MS = 60_000;

const STREAK_BONUSES: Array<{ at: number; rule: RuleKey }> = [
  { at: 3, rule: 'STREAK_BONUS_3' },
  { at: 7, rule: 'STREAK_BONUS_7' },
  { at: 30, rule: 'STREAK_BONUS_30' },
];

/**
 * Everything the app asks for rather than the platform observing.
 *
 * This is the trust boundary. Each claim names a thing that happened and the
 * server decides for itself whether it did, how long ago, and whether it has
 * already been paid for. Nothing a phone sends is taken at face value.
 */
@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly awards: PointsAwardService,
    private readonly milestones: MilestoneService,
    private readonly seasons: SeasonService,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  /**
   * "I opened this notification just now."
   *
   * The request carries only the notification's id — there is no timestamp
   * field, so a tampered device clock has nothing to tamper with. The server
   * measures the gap between its own delivery timestamp and the moment this
   * request arrives. Rejected claims are recorded too, so we can see whether
   * sixty seconds turns out to be too tight in the field.
   */
  async notificationOpened(
    userId: string,
    notificationId: string,
  ): Promise<{
    awarded: boolean;
    points: number;
    latencyMs: number;
    reason?: AwardRejection | 'TOO_SLOW' | 'NOT_DELIVERED';
    newTotal: number;
  }> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        userId: true,
        sentAt: true,
        readAt: true,
        deliveries: { select: { sentAt: true, deliveredAt: true } },
        pointsOpen: { select: { awarded: true, latencyMs: true } },
      },
    });

    if (!notification || notification.userId !== userId) {
      throw new ResourceNotFoundException('Notification', notificationId);
    }

    const total = await this.currentTotal(userId);

    // Already claimed: hand back what happened the first time rather than an
    // error, so a retrying app settles down.
    if (notification.pointsOpen) {
      return {
        awarded: false,
        points: 0,
        latencyMs: notification.pointsOpen.latencyMs,
        reason: 'DUPLICATE',
        newTotal: total,
      };
    }

    const deliveredAt = earliestDelivery(notification);
    const now = new Date();

    if (!deliveredAt) {
      await this.recordOpen(userId, notificationId, 0, false, 'NOT_DELIVERED');
      return { awarded: false, points: 0, latencyMs: 0, reason: 'NOT_DELIVERED', newTotal: total };
    }

    const latencyMs = now.getTime() - deliveredAt.getTime();
    if (latencyMs < 0 || latencyMs >= NOTIFICATION_WINDOW_MS) {
      await this.recordOpen(userId, notificationId, latencyMs, false, 'TOO_SLOW');
      return { awarded: false, points: 0, latencyMs, reason: 'TOO_SLOW', newTotal: total };
    }

    const result = await this.awards.award({
      userId,
      ruleKey: 'NOTIFICATION_OPEN_FAST',
      dedupeKey: dedupeKeys.notificationOpen(notificationId),
      metadata: { notificationId, latencyMs },
    });

    await this.recordOpen(
      userId,
      notificationId,
      latencyMs,
      result.awarded,
      result.awarded ? null : (result.reason ?? null),
    );

    // The claim doubles as a read receipt — they did just open it.
    if (!notification.readAt) {
      await this.prisma.notification
        .update({ where: { id: notificationId }, data: { readAt: now } })
        .catch(() => undefined);
    }

    return {
      awarded: result.awarded,
      points: result.points,
      latencyMs,
      reason: result.reason,
      newTotal: result.newTotal,
    };
  }

  /**
   * "I finished this lesson."
   *
   * Recorded server-side, which is the real fix for progress that until now
   * lived only in the device's storage: clearing it re-earned every lesson,
   * and a new phone lost the course. The completion row is the dedupe, so the
   * points follow the fact rather than the device.
   */
  async lessonCompleted(
    userId: string,
    lessonId: string,
  ): Promise<{
    awarded: boolean;
    points: number;
    reason?: AwardRejection;
    completedLessons: string[];
    totalLessons: number;
    milestone: { key: string; points: number } | null;
    newTotal: number;
  }> {
    const now = new Date();
    let firstTime = false;
    try {
      await this.prisma.lessonCompletion.create({
        data: { userId, lessonId, completedAt: now },
      });
      firstTime = true;
    } catch {
      firstTime = false;
    }

    const award = firstTime
      ? await this.awards.award({
          userId,
          ruleKey: 'COMPLETE_LESSON',
          dedupeKey: dedupeKeys.lesson(userId, lessonId),
          metadata: { lessonId },
        })
      : { awarded: false, points: 0, reason: 'DUPLICATE' as AwardRejection, newTotal: await this.currentTotal(userId) };

    const milestone = firstTime ? await this.milestones.evaluateLessons(userId, now) : null;

    const rows = await this.prisma.lessonCompletion.findMany({
      where: { userId },
      select: { lessonId: true },
      orderBy: { completedAt: 'asc' },
    });

    return {
      awarded: award.awarded,
      points: award.points,
      reason: award.reason,
      completedLessons: rows.map((r) => r.lessonId),
      totalLessons: TOTAL_LESSONS,
      milestone: milestone ? { key: milestone.key, points: milestone.points } : null,
      newTotal: milestone ? await this.currentTotal(userId) : award.newTotal,
    };
  }

  /** "I compared these two stocks." Once a day, whatever the pair. */
  async compareUsed(
    userId: string,
    symbolA: string,
    symbolB: string,
  ): Promise<{ awarded: boolean; points: number; reason?: AwardRejection; newTotal: number }> {
    const a = symbolA.trim().toUpperCase();
    const b = symbolB.trim().toUpperCase();
    if (a === b) {
      throw new ValidationException('Pick two different stocks to compare');
    }

    const known = await this.prisma.stock.count({ where: { symbol: { in: [a, b] } } });
    if (known < 2) {
      throw new ValidationException('Unknown stock symbol');
    }

    const now = new Date();
    const result = await this.awards.award({
      userId,
      ruleKey: 'USE_COMPARE_TOOL',
      dedupeKey: dedupeKeys.compare(userId, a, b, toMalawiDayString(now, this.app.timezone)),
      metadata: { symbolA: a, symbolB: b },
    });
    return { awarded: result.awarded, points: result.points, reason: result.reason, newTotal: result.newTotal };
  }

  /**
   * "I opened Pine today."
   *
   * The day comes from the server's clock in Malawi time; the request carries
   * no date, so changing the device's timezone achieves nothing. The streak
   * only advances when the award actually inserts, so a double tap cannot
   * move it and a thirty-day streak takes thirty real days.
   */
  async checkIn(userId: string): Promise<{
    awarded: boolean;
    points: number;
    currentStreak: number;
    longestStreak: number;
    bonus: { key: string; points: number } | null;
    reason?: AwardRejection;
    newTotal: number;
  }> {
    const now = new Date();
    const season = await this.seasons.seasonFor(now);
    const today = toMalawiDay(now, this.app.timezone);

    const result = await this.awards.award({
      userId,
      ruleKey: 'DAILY_CHECK_IN',
      dedupeKey: dedupeKeys.checkIn(userId, toMalawiDayString(now, this.app.timezone)),
    });

    if (!season) {
      return {
        awarded: false,
        points: 0,
        currentStreak: 0,
        longestStreak: 0,
        bonus: null,
        reason: result.reason,
        newTotal: result.newTotal,
      };
    }

    const existing = await this.prisma.pointStreak.findUnique({
      where: { userId_seasonId: { userId, seasonId: season.id } },
    });

    // Only a genuinely new day moves the streak.
    let currentStreak = existing?.currentStreak ?? 0;
    let longestStreak = existing?.longestStreak ?? 0;
    let bonus: { key: string; points: number } | null = null;

    if (result.awarded) {
      const gap = existing ? daysBetween(existing.lastCheckInOn, today) : null;
      currentStreak = gap === 1 ? (existing?.currentStreak ?? 0) + 1 : 1;
      longestStreak = Math.max(longestStreak, currentStreak);

      await this.prisma.pointStreak.upsert({
        where: { userId_seasonId: { userId, seasonId: season.id } },
        create: {
          userId,
          seasonId: season.id,
          lastCheckInOn: today,
          currentStreak,
          longestStreak,
        },
        update: { lastCheckInOn: today, currentStreak, longestStreak },
      });

      bonus = await this.awardStreakBonus(userId, currentStreak, now);
    } else if (existing) {
      currentStreak = existing.currentStreak;
      longestStreak = existing.longestStreak;
    }

    return {
      awarded: result.awarded,
      points: result.points,
      currentStreak,
      longestStreak,
      bonus,
      reason: result.reason,
      newTotal: bonus ? await this.currentTotal(userId) : result.newTotal,
    };
  }

  /**
   * The 3 and 7-day bonuses pay once per run; the 30-day one pays every
   * thirty days the streak survives. Keyed by how many times that length has
   * been reached, so rebuilding a streak can pay again — but only after
   * living through the days, which is strictly worse than not breaking it.
   */
  private async awardStreakBonus(
    userId: string,
    streak: number,
    at: Date,
  ): Promise<{ key: string; points: number } | null> {
    const hit = STREAK_BONUSES.find((b) => b.at === streak)
      ?? (streak > 30 && streak % 30 === 0 ? STREAK_BONUSES[2] : undefined);
    if (!hit) return null;

    const attainment = hit.at === 30 ? Math.floor(streak / 30) : 1;
    const result = await this.awards.award({
      userId,
      ruleKey: hit.rule,
      dedupeKey: dedupeKeys.streak(userId, hit.at, attainment),
      occurredAt: at,
      metadata: { streak },
    });
    return result.awarded ? { key: hit.rule, points: result.points } : null;
  }

  private async recordOpen(
    userId: string,
    notificationId: string,
    latencyMs: number,
    awarded: boolean,
    rejectedReason: string | null,
  ): Promise<void> {
    await this.prisma.notificationOpen
      .create({
        data: { userId, notificationId, latencyMs: Math.max(0, latencyMs), awarded, rejectedReason },
      })
      .catch(() => undefined);
  }

  private async currentTotal(userId: string): Promise<number> {
    const season = await this.seasons.currentOrLatest();
    if (!season) return 0;
    return this.awards.totalFor(userId, season.id);
  }
}

/** The earliest moment any channel reported sending or delivering it. */
function earliestDelivery(n: {
  sentAt: Date | null;
  deliveries: Array<{ sentAt: Date | null; deliveredAt: Date | null }>;
}): Date | null {
  const times = [
    ...n.deliveries.map((d) => d.sentAt),
    ...n.deliveries.map((d) => d.deliveredAt),
    n.sentAt,
  ].filter((t): t is Date => t instanceof Date);
  if (!times.length) return null;
  return times.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}
