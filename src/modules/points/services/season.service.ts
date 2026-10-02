import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { CompetitionSeason } from '@prisma/client';
import { appConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
/** How long the open season is trusted from cache. It changes once a year. */
const CACHE_TTL_MS = 60_000;

/**
 * Owns the competition window.
 *
 * The season is a row rather than a constant so the competition can start on
 * the day the feature is announced rather than the day someone happened to
 * run a migration, and so closing it is an update rather than a deploy.
 */
@Injectable()
export class SeasonService implements OnModuleInit {
  private readonly logger = new Logger(SeasonService.name);
  private cached: { season: CompetitionSeason | null; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.app.pointsEnabled) return;
    await this.ensureSeason().catch((e: unknown) =>
      this.logger.error({ err: e }, 'Could not ensure a Pine Points season'),
    );
  }

  /**
   * Creates the season on first boot if none covers today. The dates come
   * from config, defaulting to a year from now, so the launch date is a
   * deploy-time decision rather than something baked into SQL.
   */
  async ensureSeason(): Promise<CompetitionSeason> {
    const now = new Date();
    const open = await this.prisma.competitionSeason.findFirst({
      where: { startsAt: { lte: now }, endsAt: { gte: now } },
      orderBy: { startsAt: 'desc' },
    });
    if (open) return open;

    const startsAt = this.app.pointsSeasonStartsAt
      ? new Date(this.app.pointsSeasonStartsAt)
      : now;
    const endsAt = this.app.pointsSeasonEndsAt
      ? new Date(this.app.pointsSeasonEndsAt)
      : new Date(startsAt.getTime() + ONE_YEAR_MS);

    const count = await this.prisma.competitionSeason.count();
    const created = await this.prisma.competitionSeason.create({
      data: {
        name: `Pine Points Season ${count + 1}`,
        slug: `season-${count + 1}`,
        startsAt,
        endsAt,
      },
    });
    this.logger.log(
      `Opened ${created.name}: ${startsAt.toISOString()} → ${endsAt.toISOString()}`,
    );
    this.cached = null;
    return created;
  }

  /** The season an award at `at` belongs to, or null if none covers it. */
  async seasonFor(at: Date = new Date()): Promise<CompetitionSeason | null> {
    const fresh =
      this.cached &&
      Date.now() - this.cached.at < CACHE_TTL_MS &&
      this.cached.season &&
      this.cached.season.startsAt <= at &&
      this.cached.season.endsAt >= at;
    if (fresh) return this.cached!.season;

    const season = await this.prisma.competitionSeason.findFirst({
      where: { startsAt: { lte: at }, endsAt: { gte: at } },
      orderBy: { startsAt: 'desc' },
    });
    this.cached = { season, at: Date.now() };
    return season;
  }

  /** The season the app should display: the open one, else the most recent. */
  async currentOrLatest(): Promise<CompetitionSeason | null> {
    return (
      (await this.seasonFor()) ??
      this.prisma.competitionSeason.findFirst({ orderBy: { endsAt: 'desc' } })
    );
  }

  async bySlug(slug: string): Promise<CompetitionSeason | null> {
    return this.prisma.competitionSeason.findUnique({ where: { slug } });
  }

  /** Whole days left, floored at zero. */
  daysRemaining(season: CompetitionSeason, now: Date = new Date()): number {
    const ms = season.endsAt.getTime() - now.getTime();
    return Math.max(0, Math.ceil(ms / 86_400_000));
  }

  /** Invalidates the cache — used after an admin closes a season. */
  forget(): void {
    this.cached = null;
  }
}
