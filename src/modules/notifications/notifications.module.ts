import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';
import { AuthModule } from '../auth/auth.module';

// Repository
import { NotificationRepository } from './repositories/notification.repository';

// Services
import { TemplateService } from './services/template.service';
import { PreferenceService } from './services/preference.service';
import {
  DeliveryService,
  InAppProvider,
  PushProvider,
  EmailProvider,
  SMSProvider,
} from './services/delivery.service';
import { NotificationService } from './services/notification.service';

// Controller
import { NotificationController } from './controllers/notification.controller';

/**
 * NotificationsModule — the Communications Platform.
 *
 * No other module sends notifications directly.
 * They publish events. This module listens and delivers.
 *
 * Architecture:
 *   Event Bus → NotificationService (orchestrator)
 *     → TemplateService    (render messages from templates)
 *     → PreferenceService  (check user channel preferences)
 *     → DeliveryService    (dispatch through channel providers)
 *       → InAppProvider    (always works — stored in DB)
 *       → PushProvider     (Firebase — stub until connected)
 *       → EmailProvider    (SMTP — stub until connected)
 *       → SMSProvider      (stub until connected)
 *
 * Priority levels:
 *   CRITICAL (0)      — always sent, can't disable (security)
 *   IMPORTANT (1)     — trade fills, deposits, KYC
 *   INFORMATIONAL (2) — settlements, summaries
 *   PROMOTIONAL (3)   — fully opt-in/opt-out
 */
@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    AuthModule,
  ],
  controllers: [NotificationController],
  providers: [
    // Repository
    NotificationRepository,

    // Channel providers
    InAppProvider,
    PushProvider,
    EmailProvider,
    SMSProvider,

    // Services
    TemplateService,
    PreferenceService,
    DeliveryService,
    NotificationService,
  ],
  exports: [
    NotificationService,
    TemplateService,
  ],
})
export class NotificationsModule {}
