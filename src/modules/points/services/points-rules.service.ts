import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { appConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { toMalawiDay } from '../domain/malawi-day';
import {
  GROUP_TITLES,
  PRIZES,
  PUBLIC_RULE_ORDER,
  RULE_CATALOGUE,
} from '../domain/rule-catalogue';
import { RuleGroup } from '../domain/rule-keys';
import { SeasonService } from './season.service';

export type Lang = 'en' | 'ny';

/**
 * Serves the rule catalogue to the app, with the caller's own progress mixed
 * in. The app renders the earn screen entirely from this and hardcodes no
 * points values, so changing what something is worth is a backend deploy
 * rather than an app-store release.
 */
@Injectable()
export class PointsRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seasons: SeasonService,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  async catalogueFor(userId: string, lang: Lang) {
    const season = await this.seasons.currentOrLatest();
    const now = new Date();
    const today = toMalawiDay(now, this.app.timezone);

    const [todayRows, everRows] = season
      ? await Promise.all([
          this.prisma.pointEvent.groupBy({
            by: ['ruleKey'],
            where: { userId, awardedOn: today },
            _count: { _all: true },
          }),
          this.prisma.pointEvent.groupBy({
            by: ['ruleKey'],
            where: { userId, seasonId: season.id },
            _count: { _all: true },
            _sum: { points: true },
          }),
        ])
      : [[], []];

    const earnedToday = new Map(todayRows.map((r) => [r.ruleKey, r._count._all]));
    const earnedEver = new Map(everRows.map((r) => [r.ruleKey, r._count._all]));

    const groups = new Map<RuleGroup, ReturnType<typeof this.shapeRule>[]>();
    for (const key of PUBLIC_RULE_ORDER) {
      const rule = RULE_CATALOGUE[key];
      const list = groups.get(rule.group) ?? [];
      list.push(
        this.shapeRule(rule, lang, earnedToday.get(key) ?? 0, earnedEver.get(key) ?? 0),
      );
      groups.set(rule.group, list);
    }

    return {
      season: season
        ? {
            slug: season.slug,
            name: season.name,
            startsAt: season.startsAt,
            endsAt: season.endsAt,
            closed: Boolean(season.closedAt),
            daysRemaining: this.seasons.daysRemaining(season, now),
          }
        : null,
      prizes: PRIZES.map((p) => ({ rank: p.rank, label: p.label[lang] })),
      groups: [...groups.entries()].map(([group, rules]) => ({
        group,
        title: GROUP_TITLES[group][lang],
        rules,
      })),
    };
  }

  private shapeRule(
    rule: (typeof RULE_CATALOGUE)[keyof typeof RULE_CATALOGUE],
    lang: Lang,
    today: number,
    ever: number,
  ) {
    return {
      key: rule.key,
      points: rule.points,
      dailyCap: rule.dailyCap,
      oneTime: rule.oneTime,
      icon: rule.icon,
      title: rule.title[lang],
      hint: rule.hint[lang],
      earnedToday: today,
      earnedTotal: ever,
      /** One-time rules show a tick once earned; the rest never "complete". */
      completed: rule.oneTime ? ever > 0 : false,
      /** True when today's allowance for this rule is used up. */
      cappedToday: rule.dailyCap !== null && today >= rule.dailyCap,
    };
  }
}
