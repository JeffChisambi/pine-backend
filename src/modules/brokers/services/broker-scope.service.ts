import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { Role } from '../../../core/constants/roles.constant';
import { ForbiddenException } from '../../../core/exceptions/app.exception';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';

/**
 * BrokerScopeService — the single authority for "which broker's data may
 * this authenticated staff member see?".
 *
 * Rules:
 *   - SUPER_ADMIN (and platform staff roles) → unscoped (brokerId undefined).
 *   - BROKER (broker admin) → scoped to the brokerId stored on THEIR user
 *     row in the database. The value is always re-read from the DB — never
 *     taken from the JWT, a header, a query param, or any client input —
 *     so a manually constructed API request cannot widen the scope.
 *
 * Every admin-surface query for broker-scoped data must pass the resolved
 * scope into the repository layer, which applies it as a WHERE condition.
 */
@Injectable()
export class BrokerScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the broker scope for an authenticated admin-surface user.
   * Returns `undefined` for platform-level roles (no restriction) or the
   * broker id for broker admins. Throws if a broker admin has no broker
   * assigned or their broker has been deactivated.
   */
  async resolveScope(user: Pick<AuthenticatedUser, 'id' | 'role'>): Promise<string | undefined> {
    if (user.role !== Role.BROKER) return undefined;

    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { brokerId: true, broker: { select: { isActive: true } } },
    });

    if (!dbUser?.brokerId) {
      throw new ForbiddenException(
        'Your account is not associated with a broker. Contact the platform administrator.',
      );
    }
    if (dbUser.broker && !dbUser.broker.isActive) {
      throw new ForbiddenException('Your broker has been deactivated.');
    }
    return dbUser.brokerId;
  }

  /**
   * Assert that a target investor belongs to the resolved scope.
   * No-op for unscoped (platform) callers.
   */
  async assertUserInScope(scopeBrokerId: string | undefined, targetUserId: string): Promise<void> {
    if (!scopeBrokerId) return;
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { brokerId: true },
    });
    if (!target || target.brokerId !== scopeBrokerId) {
      // Deliberately indistinguishable from "does not exist" to avoid
      // leaking other brokers' user ids.
      throw new ForbiddenException('Resource not accessible');
    }
  }
}
