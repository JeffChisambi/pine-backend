import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';

// Repository
import { UsersRepository } from './repositories/users.repository';

// Services
import { ProfileService } from './services/profile.service';
import { UserPreferenceService } from './services/preference.service';
import { IdentityFacade } from './services/identity-facade.service';
import { AccountService } from './services/account.service';

// Controller
import { UsersController } from './controllers/users.controller';

/**
 * UsersModule — intentionally small.
 *
 * The customer profile service. It answers:
 *   "Who is this customer?"
 *
 * It does NOT answer:
 *   "Can they log in?"           → Auth
 *   "Are they verified?"         → KYC
 *   "How much money do they have?" → Wallet/Ledger
 *   "What stocks do they own?"   → Portfolio
 *   "Can they trade?"            → Trading + Compliance
 *
 * Architecture:
 *   Controller → ProfileService     (name, avatar, completion)
 *             → PreferenceService   (language, timezone, notifications)
 *             → IdentityFacade      (read-only aggregation for home screen)
 *
 * Rule: If changing the code could accidentally move money,
 * execute a trade, approve KYC, or weaken security,
 * it does NOT belong here.
 */
@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    AuthModule,
    AuditModule,
    StorageModule,
  ],
  controllers: [UsersController],
  providers: [
    UsersRepository,
    ProfileService,
    UserPreferenceService,
    IdentityFacade,
    AccountService,
  ],
  exports: [
    ProfileService,
    UserPreferenceService,
    IdentityFacade,
    UsersRepository,
  ],
})
export class UsersModule {}
