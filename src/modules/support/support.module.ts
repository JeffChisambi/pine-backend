import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { SupportController } from './controllers/support.controller';
import { AdminSupportController } from './controllers/admin-support.controller';
import { SupportService } from './services/support.service';

/**
 * SupportModule — customer Help & Support ("Report a problem") + staff inbox.
 *
 *   Customer:  /v1/support/*
 *   Admin:     /v1/admin/support/*
 */
@Module({
  imports: [DatabaseModule, AuditModule, StorageModule],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
