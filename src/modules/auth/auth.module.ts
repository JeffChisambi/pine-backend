import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';

// Controller
import { AuthController } from './controllers/auth.controller';

// Services
import { AuthService } from './services/auth.service';
import { IdentityService } from './services/identity.service';
import { SessionService } from './services/session.service';
import { TokenService } from './services/token.service';
import { OtpService } from './services/otp.service';
import { DeviceService } from './services/device.service';
import { PasswordService } from './services/password.service';
import { PinService } from './services/pin.service';

// Guards
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { PinGuard } from './guards/pin.guard';

/**
 * AuthModule — the security foundation of Pine.
 *
 * Architecture:
 *   Auth (orchestrator) → Identity, Session, Token, OTP, Device, Password, PIN
 *
 * Guards (registered globally via APP_GUARD):
 *   1. JwtAuthGuard  — every route authenticated by default; @Public() opts out
 *   2. RolesGuard    — @Roles() metadata check
 *   3. PermissionsGuard — @RequirePermissions() metadata check
 *
 * PinGuard is NOT global — applied per-route with @UseGuards(PinGuard)
 * on financial action endpoints in other modules.
 *
 * This module has ONE responsibility: prove identity and manage trust.
 * It never touches wallets, KYC, trading, or any business domain.
 * Cross-module effects happen exclusively through domain events.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    EventEmitterModule.forRoot(),
  ],
  controllers: [AuthController],
  providers: [
    // ── Services ──────────────────────────────────────────────
    AuthService,
    IdentityService,
    SessionService,
    TokenService,
    OtpService,
    DeviceService,
    PasswordService,
    PinService,

    // ── Global Guards (order matters: auth → roles → perms) ──
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },

    // PinGuard is NOT global — exported for per-route use
    PinGuard,
  ],
  exports: [
    // Other modules need these for:
    // - TokenService: verifying pin tokens in PinGuard
    // - SessionService: checking session validity
    // - IdentityService: user lookups
    // - PinGuard: @UseGuards(PinGuard) on financial endpoints
    TokenService,
    SessionService,
    IdentityService,
    PasswordService,
    PinGuard,
  ],
})
export class AuthModule {}
