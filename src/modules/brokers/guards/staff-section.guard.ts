import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { ForbiddenException } from '../../../core/exceptions/app.exception';
import type { RequestWithUser } from '../../../core/types/request-context.types';
import { Role } from '../../../core/constants/roles.constant';
import { ROUTE_SECTIONS, UNGATED_ADMIN_ROUTES } from '../staff/dashboard-sections';

/** How long a staff member's section list is trusted before re-reading it. */
const CACHE_TTL_MS = 30_000;

/**
 * Enforces section-level access for broker STAFF on every admin API route.
 *
 * Runs after JwtAuthGuard and PermissionsGuard, so by the time it fires the
 * caller is authenticated and holds the role-level permission for the route.
 * This guard narrows further: a broker admin who set up a staff member with
 * access to KYC and Support only must find that /admin/trading refuses that
 * person — hiding the sidebar item is not security, this is.
 *
 * Only users flagged isBrokerStaff are gated. Broker administrators and
 * platform staff pass straight through: their access is governed by role.
 *
 * Sections are read from the database, not the JWT, so a change a broker
 * makes takes effect within CACHE_TTL_MS rather than at the next sign-in.
 */
@Injectable()
export class StaffSectionGuard implements CanActivate {
  private readonly cache = new Map<string, { sections: Set<string>; staff: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    // Not an admin route, or not signed in (JwtAuthGuard already decided) —
    // nothing for us to narrow.
    if (!user || user.role !== Role.BROKER) return true;

    const segment = this.adminSegment(request.path ?? request.url ?? '');
    if (!segment || UNGATED_ADMIN_ROUTES.has(segment)) return true;

    const access = await this.accessFor(user.id);
    if (!access.staff) return true;

    const section = ROUTE_SECTIONS[segment];
    // An admin route we have no section for is platform-only; PermissionsGuard
    // already refuses broker users there. Refuse here too rather than assume.
    if (!section || !access.sections.has(section)) {
      throw new ForbiddenException(
        'Your account does not have access to this part of the dashboard. Ask your broker administrator.',
      );
    }
    return true;
  }

  /** "/v1/admin/kyc/queue?x=1" → "kyc"; anything not under /admin → null. */
  private adminSegment(path: string): string | null {
    const m = /\/admin\/([^/?]+)/.exec(path);
    return m ? m[1] : null;
  }

  private async accessFor(userId: string): Promise<{ staff: boolean; sections: Set<string> }> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isBrokerStaff: true, staffSections: true },
    });
    const entry = {
      staff: row?.isBrokerStaff ?? false,
      sections: new Set(row?.staffSections ?? []),
      at: Date.now(),
    };
    this.cache.set(userId, entry);
    return entry;
  }

  /** Called after a broker edits someone's sections so it applies at once. */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
