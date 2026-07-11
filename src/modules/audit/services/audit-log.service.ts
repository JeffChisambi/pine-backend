import { Injectable, Logger } from '@nestjs/common';
import { AuditRepository } from '../repositories/audit.repository';
import type { Role } from '@prisma/client';

export interface AuditLogParams {
  actorId?: string;
  actorRole?: Role;
  action: string;
  resourceType: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * AuditLogService — immutable audit trail for every administrative action.
 *
 * Design:
 *   - Append-only: never updates or deletes audit rows
 *   - Fire-and-forget: logging never blocks the caller (async, catch errors internally)
 *   - Used by every admin controller action and auth event
 *
 * Every call creates one row in the `audit_logs` table.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly repository: AuditRepository) {}

  /**
   * Log an administrative action. This method is intentionally
   * fire-and-forget — it catches and logs errors internally
   * so it never blocks or fails the caller's operation.
   */
  async log(params: AuditLogParams): Promise<void> {
    try {
      await this.repository.create({
        actorId: params.actorId,
        actorRole: params.actorRole,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        requestId: params.requestId,
        metadata: params.metadata,
      });
    } catch (error) {
      // Never let audit logging break the caller's operation
      this.logger.error(
        `Failed to write audit log: ${params.action} on ${params.resourceType}/${params.resourceId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
