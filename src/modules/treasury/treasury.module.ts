import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuditModule } from '../audit/audit.module';
import { TreasuryController } from './controllers/treasury.controller';
import { AdminTreasuryController } from './controllers/admin-treasury.controller';
import { TreasuryService } from './services/treasury.service';

/**
 * TreasuryModule — T-bill investment feature.
 *
 * Endpoints:
 *   GET  /v1/treasury/products         → list available products (tenor, yield, min)
 *   GET  /v1/treasury/investments      → user's active investments
 *   POST /v1/treasury/invest           → submit a new investment order
 *   GET  /v1/treasury/investments/:id  → single investment status
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [TreasuryController, AdminTreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
