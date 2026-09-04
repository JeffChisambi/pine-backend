import { Injectable, Logger } from '@nestjs/common';
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { NotificationRepository } from '../repositories/notification.repository';

/**
 * Delivery Service — sends notifications through channel providers.
 *
 * Knows NOTHING about trading, KYC, or wallets.
 * Only knows: Push, Email, SMS, In-App.
 *
 * Each channel is a pluggable provider:
 *   push  → Expo Push API (sends to FCM/APNs via Expo)
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

// ── Push Provider (Expo Push API) ─────────────────────────────

@Injectable()
export class PushProvider implements IChannelProvider {
  readonly name = 'expo_push';
  readonly channel = 'PUSH';
  private readonly logger = new Logger(PushProvider.name);
  private readonly expo = new Expo();

  constructor(private readonly prisma: PrismaService) {}

  async send(payload: DeliveryPayload): Promise<DeliveryResult> {
    const devices = await this.prisma.device.findMany({
      where: {
        userId: payload.userId,
        isRevoked: false,
        pushToken: { not: null },
      },
      select: { id: true, pushToken: true },
    });

    const tokens = devices
      .map((d) => d.pushToken!)
      .filter((t) => Expo.isExpoPushToken(t));

    if (tokens.length === 0) {
      this.logger.debug(
        { userId: payload.userId },
        'No valid push tokens — skipping push delivery',
      );
      return { success: true, provider: this.name };
    }

    // The number on the app icon. Expo forwards this to APNs (which will not
    // show a badge without it) and to FCM. Counted here, at send time, from
    // the same query the in-app bell uses — the inbox row for THIS
    // notification already exists, so the icon and the bell always agree.
    // Without it `shouldSetBadge` on the device has no value to apply and no
    // badge ever appears.
    const badge = await this.prisma.notification
      .count({ where: { userId: payload.userId, channel: 'IN_APP', readAt: null } })
      .catch(() => undefined);

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      sound: 'default' as const,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      ...(badge != null ? { badge } : {}),
      // Heads-up pop-up delivery: 'high' wakes the device promptly, and the
      // 'alerts' Android channel is created client-side with MAX importance
      // (banner + sound) — the tray-only 'default' channel stays for legacy.
      priority: 'high' as const,
      channelId: 'alerts',
    }));

    const chunks = this.expo.chunkPushNotifications(messages);
    const ticketIds: string[] = [];
    const staleTokens: string[] = [];

    for (const chunk of chunks) {
      try {
        const tickets: ExpoPushTicket[] =
          await this.expo.sendPushNotificationsAsync(chunk);

        for (let i = 0; i < tickets.length; i++) {
          const ticket = tickets[i];
          if (ticket.status === 'ok') {
            ticketIds.push(ticket.id);
          } else {
            if (
              ticket.details?.error === 'DeviceNotRegistered' ||
              ticket.details?.error === 'InvalidCredentials'
            ) {
              staleTokens.push((chunk[i] as any).to);
            }
            this.logger.warn(
              { token: (chunk[i] as any).to, error: ticket.details },
              'Push ticket error',
            );
          }
        }
      } catch (error) {
        this.logger.error({ err: error }, 'Expo push chunk failed');
      }
    }

    // Clean up stale tokens
    if (staleTokens.length > 0) {
      await this.prisma.device
        .updateMany({
          where: { pushToken: { in: staleTokens } },
          data: { pushToken: null },
        })
        .catch(() => {});
      this.logger.log(
        { count: staleTokens.length },
        'Cleared stale push tokens',
      );
    }

    return {
      success: ticketIds.length > 0,
      provider: this.name,
      providerMsgId: ticketIds[0],
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
