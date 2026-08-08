import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuditModule } from '../audit/audit.module';
import { MobileThemeController } from './controllers/mobile-theme.controller';
import { AdminMobileThemeController } from './controllers/admin-mobile-theme.controller';
import { MobileThemeService } from './services/mobile-theme.service';

/**
 * MobileThemeModule — broker-configurable mobile app brand colors.
 *
 *   Public: /v1/mobile-theme
 *   Admin:  /v1/admin/mobile-theme
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [MobileThemeController, AdminMobileThemeController],
  providers: [MobileThemeService],
  exports: [MobileThemeService],
})
export class MobileThemeModule {}
