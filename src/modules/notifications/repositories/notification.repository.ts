import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

/**
 * Notification Repository — all Prisma queries for the communications platform.
 */
@Injectable()
export class NotificationRepository {
  private readonly logger = new Logger(NotificationRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Notifications ───────────────────────────────────────────

  async createNotification(data: {
    userId: string;
    channel: string;
    templateKey?: string;
    type: string;
    priority: number;
    category: string;
    title: string;
    body: string;
    data?: Record<string, any>;
  }) {
    return this.prisma.notification.create({
      data: {
        userId: data.userId,
        channel: data.channel as any,
        templateKey: data.templateKey,
        type: data.type,
        priority: data.priority,
        category: data.category,
        title: data.title,
        body: data.body,
        data: data.data as any,
        status: 'QUEUED',
      },
    });
  }

  async updateNotificationStatus(
    id: string,
    status: string,
    extra: Record<string, any> = {},
  ) {
    return this.prisma.notification.update({
      where: { id },
      data: { status: status as any, ...extra },
    });
  }

  async findUserNotifications(
    userId: string,
    limit = 30,
    offset = 0,
  ) {
    const where: any = { userId, channel: 'IN_APP' };
    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { notifications, total };
  }

  async findUnreadNotifications(userId: string, limit = 50) {
    return this.prisma.notification.findMany({
      where: { userId, channel: 'IN_APP', readAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async countUnread(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, channel: 'IN_APP', readAt: null },
    });
  }

  async markAsRead(notificationId: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { readAt: new Date(), status: 'READ' },
    });
  }

  async markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date(), status: 'READ' },
    });
  }

  async deleteNotification(notificationId: string, userId: string) {
    return this.prisma.notification.deleteMany({
      where: { id: notificationId, userId },
    });
  }

  // ── Templates ───────────────────────────────────────────────

  async findTemplateByKey(key: string) {
    return this.prisma.notificationTemplate.findUnique({
      where: { key },
    });
  }

  async upsertTemplate(data: {
    key: string;
    channel: string;
    subject?: string;
    body: string;
  }) {
    return this.prisma.notificationTemplate.upsert({
      where: { key: data.key },
      update: { body: data.body, subject: data.subject },
      create: {
        key: data.key,
        channel: data.channel as any,
        subject: data.subject,
        body: data.body,
      },
    });
  }

  // ── Preferences ─────────────────────────────────────────────

  async findUserPreferences(userId: string) {
    return this.prisma.notificationPreference.findMany({
      where: { userId },
    });
  }

  async findUserPreference(userId: string, category: string) {
    return this.prisma.notificationPreference.findUnique({
      where: { userId_category: { userId, category } },
    });
  }

  async upsertPreference(data: {
    userId: string;
    category: string;
    pushEnabled: boolean;
    emailEnabled: boolean;
    smsEnabled: boolean;
    inAppEnabled: boolean;
  }) {
    return this.prisma.notificationPreference.upsert({
      where: { userId_category: { userId: data.userId, category: data.category } },
      update: {
        pushEnabled: data.pushEnabled,
        emailEnabled: data.emailEnabled,
        smsEnabled: data.smsEnabled,
        inAppEnabled: data.inAppEnabled,
      },
      create: data,
    });
  }

  // ── Delivery Tracking ───────────────────────────────────────

  async createDelivery(data: {
    notificationId: string;
    channel: string;
    provider: string;
  }) {
    return this.prisma.notificationDelivery.create({
      data: {
        notificationId: data.notificationId,
        channel: data.channel as any,
        provider: data.provider,
        status: 'QUEUED',
      },
    });
  }

  async updateDeliveryStatus(
    deliveryId: string,
    status: string,
    extra: Record<string, any> = {},
  ) {
    return this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: status as any, ...extra, attemptCount: { increment: 1 } },
    });
  }

  async findFailedDeliveries(limit = 50) {
    return this.prisma.notificationDelivery.findMany({
      where: { status: 'FAILED', attemptCount: { lt: 3 } },
      include: { notification: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}
