import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuditRepository } from './repositories/audit.repository';
import { AuditLogService } from './services/audit-log.service';
import { AuditController } from './controllers/audit.controller';

/**
 * AuditModule — immutable audit logging for every administrative
 * and financial action across the platform.
 *
 * Architecture:
 *   AuditLogService (fire-and-forget writer)
 *     → AuditRepository (Prisma insert)
 *
 *   AuditController (admin-facing search)
 *     → AuditRepository (Prisma queries)
 *
 * The AuditLogService is exported so every module that performs
 * auditable actions (Admin, Auth, KYC, Wallet, Trading) can
 * inject it and call `auditLogService.log(...)`.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AuditController],
  providers: [AuditRepository, AuditLogService],
  exports: [AuditLogService, AuditRepository],
})
export class AuditModule {}
