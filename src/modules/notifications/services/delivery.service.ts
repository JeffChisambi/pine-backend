import { Injectable, Logger } from '@nestjs/common';
import { NotificationRepository } from '../repositories/notification.repository';

/**
 * Delivery Service — sends notifications through channel providers.
 *
 * Knows NOTHING about trading, KYC, or wallets.
 * Only knows: Push, Email, SMS, In-App.
 *
 * Each channel is a pluggable provider:
 *   push  → FirebasePushProvider (future)
 *   email → SMTPProvider (future)
 *   sms   → SMSProvider (future)
 *   inApp → stored in DB (always works)
 *
 * Adding a new channel (WhatsApp, Telegram, WebSocket) requires
 * ZERO changes to Trading, Auth, or KYC modules.
 */

export interface DeliveryPayload {
  notificationId: string;
  userId: string;
  channel: string;
  title: string;
  body: string;
  data?: Record<string, any>;
}

export interface DeliveryResult {
  success: boolean;
  provider: string;
  providerMsgId?: string;
  error?: string;
}

// ── Channel Provider Interface ────────────────────────────────

export interface IChannelProvider {
  readonly name: string;
  readonly channel: string;
  send(payload: DeliveryPayload): Promise<DeliveryResult>;
}

// ── In-App Provider (always available) ────────────────────────

@Injectable()
export class InAppProvider implements IChannelProvider {
  readonly name = 'in_app';
  readonly channel = 'IN_APP';

  async send(payload: DeliveryPayload): Promise<DeliveryResult> {
    // In-app notifications are stored by the notification service
    // directly in the DB. This provider just confirms success.
    return { success: true, provider: this.name };
  }
}

// ── Push Provider (Firebase stub) ─────────────────────────────

@Injectable()
export class PushProvider implements IChannelProvider {
  readonly name = 'firebase';
  readonly channel = 'PUSH';
  private readonly logger = new Logger(PushProvider.name);

  async send(payload: DeliveryPayload): Promise<DeliveryResult> {
    // TODO: Integrate Firebase Cloud Messaging
    // const message = { notification: { title, body }, token: userFcmToken, data };
    // const response = await admin.messaging().send(message);
    this.logger.log(
      { userId: payload.userId, title: payload.title },
      'Push notification queued (Firebase not connected yet)',
    );

    return {
      success: true,
      provider: this.name,
      providerMsgId: `push-${Date.now()}`,
    };
  }
}

// ── Email Provider (SMTP stub) ────────────────────────────────

@Injectable()
export class EmailProvider implements IChannelProvider {
  readonly name = 'smtp';
  readonly channel = 'EMAIL';
  private readonly logger = new Logger(EmailProvider.name);

  async send(payload: DeliveryPayload): Promise<DeliveryResult> {
    // TODO: Integrate SMTP / SendGrid / SES
    // const info = await transporter.sendMail({ to, subject, html });
    this.logger.log(
      { userId: payload.userId, title: payload.title },
      'Email notification queued (SMTP not connected yet)',
    );

    return {
      success: true,
      provider: this.name,
      providerMsgId: `email-${Date.now()}`,
    };
  }
}

// ── SMS Provider (stub) ───────────────────────────────────────

@Injectable()
export class SMSProvider implements IChannelProvider {
  readonly name = 'sms_provider';
  readonly channel = 'SMS';
  private readonly logger = new Logger(SMSProvider.name);

  async send(payload: DeliveryPayload): Promise<DeliveryResult> {
    // TODO: Integrate SMS provider (Africa's Talking, Twilio, etc.)
    this.logger.log(
      { userId: payload.userId, title: payload.title },
      'SMS notification queued (SMS provider not connected yet)',
    );

    return {
      success: true,
      provider: this.name,
      providerMsgId: `sms-${Date.now()}`,
    };
  }
}

// ── Delivery Service ──────────────────────────────────────────

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  private readonly providers = new Map<string, IChannelProvider>();

  constructor(
    private readonly repo: NotificationRepository,
    private readonly inAppProvider: InAppProvider,
    private readonly pushProvider: PushProvider,
    private readonly emailProvider: EmailProvider,
    private readonly smsProvider: SMSProvider,
  ) {
    // Register providers
    this.providers.set('IN_APP', this.inAppProvider);
    this.providers.set('PUSH', this.pushProvider);
    this.providers.set('EMAIL', this.emailProvider);
    this.providers.set('SMS', this.smsProvider);
  }

  /**
   * Deliver a notification through a specific channel.
   * Creates a delivery record and tracks the result.
   */
  async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const provider = this.providers.get(payload.channel);
    if (!provider) {
      this.logger.warn({ channel: payload.channel }, 'No provider for channel');
      return { success: false, provider: 'none', error: `No provider for ${payload.channel}` };
    }

    // Create delivery record
    const delivery = await this.repo.createDelivery({
      notificationId: payload.notificationId,
      channel: payload.channel,
      provider: provider.name,
    });

    try {
      const result = await provider.send(payload);

      if (result.success) {
        await this.repo.updateDeliveryStatus(delivery.id, 'SENT', {
          sentAt: new Date(),
          providerMsgId: result.providerMsgId,
        });
      } else {
        await this.repo.updateDeliveryStatus(delivery.id, 'FAILED', {
          failureReason: result.error,
        });
      }

      return result;
    } catch (error) {
      const errorMsg = (error as Error).message;
      await this.repo.updateDeliveryStatus(delivery.id, 'FAILED', {
        failureReason: errorMsg,
      });

      this.logger.error(
        { err: error, channel: payload.channel, notificationId: payload.notificationId },
        'Delivery failed',
      );

      return { success: false, provider: provider.name, error: errorMsg };
    }
  }

  /**
   * Deliver to multiple channels simultaneously.
   */
  async deliverToChannels(
    channels: string[],
    basePayload: Omit<DeliveryPayload, 'channel'>,
  ): Promise<DeliveryResult[]> {
    const results = await Promise.allSettled(
      channels.map((channel) =>
        this.deliver({ ...basePayload, channel }),
      ),
    );

    return results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { success: false, provider: 'unknown', error: (r.reason as Error).message },
    );
  }
}
