import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { KycModule } from '../kyc/kyc.module';
import { TradingModule } from '../trading/trading.module';
import { BrokersModule } from '../brokers/brokers.module';
import { WalletModule } from '../wallet/wallet.module';
import { SystemErrorsModule } from '../system-errors/system-errors.module';


// Repository
import { AdminRepository } from './repositories/admin.repository';

// Services
import { MfaService } from './services/mfa.service';
import { AdminFinanceService } from './services/admin-finance.service';
import { AdminAuthService } from './services/admin-auth.service';

// Controllers
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminDashboardController } from './controllers/admin-dashboard.controller';
import { AdminUsersController } from './controllers/admin-users.controller';
import { AdminKycController } from './controllers/admin-kyc.controller';
import { AdminTradingController } from './controllers/admin-trading.controller';
import { AdminWalletController } from './controllers/admin-wallet.controller';
import { AdminNotificationsController } from './controllers/admin-notifications.controller';
import { AdminMeController } from './controllers/admin-me.controller';
import { AdminPlatformController } from './controllers/admin-platform.controller';

/**
 * AdminModule — the administrative control surface for Pine.
 *
 * Design Principle:
 *   The Admin Portal never bypasses business modules.
 *   Everything goes through existing services and repositories.
 *   Admin-specific aggregation queries live in AdminRepository.
 *
 * Security:
 *   - All routes require JWT authentication (inherited from global guards)
 *   - Each endpoint is protected by @RequirePermissions() or @Roles()
 *   - Staff login requires mandatory TOTP MFA
 *   - Every write action creates an immutable audit log entry
 *
 * Architecture:
 *   AdminAuthController     → AdminAuthService → MfaService + Auth services
 *   AdminDashboardController → AdminRepository (aggregation queries)
 *   AdminUsersController    → AdminRepository + SessionService + PrismaService
 *   AdminKycController      → KYC Repository (existing, via DI token)
 *   AdminTradingController  → AdminRepository
 *   AdminWalletController   → AdminRepository
 *   AdminNotificationsController → AdminRepository + PrismaService
 *
 * All write controllers inject AuditLogService for audit logging.
 */
@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    AuthModule,
    AuditModule,
    KycModule,
    TradingModule,
    BrokersModule,
    WalletModule,
    SystemErrorsModule,
  ],
  controllers: [
    AdminAuthController,
    AdminDashboardController,
    AdminUsersController,
    AdminKycController,
    AdminTradingController,
    AdminWalletController,
    AdminNotificationsController,
    AdminMeController,
    AdminPlatformController,
  ],
  providers: [
    AdminRepository,
    MfaService,
    AdminAuthService,
    AdminFinanceService,
  ],
  exports: [MfaService],
})
export class AdminModule {}
