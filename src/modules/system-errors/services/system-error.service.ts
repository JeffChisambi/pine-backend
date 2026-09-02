import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

export type ErrorSource = 'MOBILE_APP' | 'BROKER_DASHBOARD' | 'ADMIN_DASHBOARD' | 'BACKEND';
export type ErrorSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface CaptureParams {
  source: ErrorSource;
  severity: ErrorSeverity;
  message: string;
  stack?: string | null;
  location?: string | null;
  context?: Record<string, unknown> | null;
  userId?: string | null;
}

/**
 * SystemErrorService — the single sink for platform errors.
 *
 * Deduplication: identical (source, message, location) signatures within a
 * rolling window bump `occurrences` on the existing OPEN row instead of
 * creating a new one, so a crash loop reads as ONE issue with a count, not
 * ten thousand rows.
 *
 * capture() NEVER throws — error reporting must not create errors.
 */
@Injectable()
export class SystemErrorService {
  private readonly logger = new Logger(SystemErrorService.name);
  /** signature-hash → row id, small in-memory hot cache for the dedupe path */
  private readonly recent = new Map<string, { id: string; at: number }>();
  private static readonly DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h

  constructor(private readonly prisma: PrismaService) {}

  async capture(params: CaptureParams): Promise<void> {
    try {
      const message = (params.message || 'Unknown error').slice(0, 2000);
      const stack = params.stack?.slice(0, 8000) ?? null;
      const location = params.location?.slice(0, 300) ?? null;

      const sig = createHash('sha256')
        .update(`${params.source}|${message}|${location ?? ''}`)
        .digest('hex');

      // Hot path: same signature seen recently → bump the counter.
      const hot = this.recent.get(sig);
      if (hot && Date.now() - hot.at < SystemErrorService.DEDUPE_WINDOW_MS) {
        await this.prisma.systemErrorEvent.update({
          where: { id: hot.id },
          data: { occurrences: { increment: 1 }, lastSeenAt: new Date(), status: 'OPEN' },
        }).catch(() => this.recent.delete(sig)); // row deleted/resolved-gone → drop cache
        return;
      }

      // Cold path: look for an OPEN row with the same signature in the window.
      const since = new Date(Date.now() - SystemErrorService.DEDUPE_WINDOW_MS);
      const existing = await this.prisma.systemErrorEvent.findFirst({
        where: { source: params.source, message, location, status: 'OPEN', lastSeenAt: { gte: since } },
        select: { id: true },
      });

      if (existing) {
        this.recent.set(sig, { id: existing.id, at: Date.now() });
        await this.prisma.systemErrorEvent.update({
          where: { id: existing.id },
          data: { occurrences: { increment: 1 }, lastSeenAt: new Date() },
        });
        return;
      }

      const created = await this.prisma.systemErrorEvent.create({
        data: {
          source: params.source,
          severity: params.severity,
          message,
          stack,
          location,
          context: (params.context as any) ?? undefined,
          userId: params.userId ?? undefined,
        },
        select: { id: true },
      });
      this.recent.set(sig, { id: created.id, at: Date.now() });

      // Keep the hot cache bounded.
      if (this.recent.size > 500) {
        const cutoff = Date.now() - SystemErrorService.DEDUPE_WINDOW_MS;
        for (const [k, v] of this.recent) if (v.at < cutoff) this.recent.delete(k);
      }
    } catch (err) {
      // Last line of defense — never let error capture become an error source.
      this.logger.warn({ err }, 'Failed to capture system error');
    }
  }

  async list(filters: {
    source?: string;
    severity?: string;
    status?: string;
    /** ISO date string — only events last seen at or after this instant. */
    dateFrom?: string;
    /** ISO date string — only events last seen at or before this instant. */
    dateTo?: string;
    page?: number;
    limit?: number;
  }) {
    const limit = Math.min(filters.limit ?? 50, 200);
    const page = Math.max(1, filters.page ?? 1);
    const where: Record<string, unknown> = {};
    if (filters.source) where.source = filters.source;
    if (filters.severity) where.severity = filters.severity;
    if (filters.status) where.status = filters.status;
    // SystemErrorEvent has no `createdAt` — `lastSeenAt` is the row's activity
    // timestamp (a deduped row is bumped, not recreated), so a time window
    // means "errors that were still happening in this window".
    if (filters.dateFrom || filters.dateTo) {
      const lastSeenAt: { gte?: Date; lte?: Date } = {};
      if (filters.dateFrom) lastSeenAt.gte = new Date(filters.dateFrom);
      if (filters.dateTo) lastSeenAt.lte = new Date(filters.dateTo);
      where.lastSeenAt = lastSeenAt;
    }

    const [events, total] = await Promise.all([
      this.prisma.systemErrorEvent.findMany({
        where,
        orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.systemErrorEvent.count({ where }),
    ]);
    return { events, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  /** Counts for the console header: by severity (open only) and by source. */
  async stats() {
    const [bySeverity, bySource, open] = await Promise.all([
      this.prisma.systemErrorEvent.groupBy({
        by: ['severity'],
        where: { status: 'OPEN' },
        _count: { id: true },
      }),
      this.prisma.systemErrorEvent.groupBy({
        by: ['source'],
        where: { status: 'OPEN' },
        _count: { id: true },
      }),
      this.prisma.systemErrorEvent.count({ where: { status: 'OPEN' } }),
    ]);
    return {
      open,
      bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, r._count.id])),
      bySource: Object.fromEntries(bySource.map((r) => [r.source, r._count.id])),
    };
  }

  async resolve(id: string, adminId: string) {
    return this.prisma.systemErrorEvent.update({
      where: { id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: adminId },
    });
  }
}
