import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Device lifecycle management. Each physical device used to
 * access Pine gets its own record with trust scoring.
 *
 * Trust levels:
 *   UNKNOWN   → first login from this device (default)
 *   TRUSTED   → user has verified ownership (OTP from this device)
 *   SUSPICIOUS → anomaly detected (e.g. impossible travel)
 *   BLOCKED   → explicitly blocked by user or admin
 */
@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Register or update a device for a user. Uses upsert on
   * the (userId, fingerprint) unique constraint so the same
   * physical device is never duplicated.
   */
  async registerOrUpdate(data: {
    userId: string;
    fingerprint: string;
    platform: string;
    osVersion?: string;
    appVersion?: string;
    ipAddress?: string;
  }): Promise<{ deviceId: string; isNewDevice: boolean }> {
    const existing = await this.prisma.device.findUnique({
      where: {
        userId_fingerprint: {
          userId: data.userId,
          fingerprint: data.fingerprint,
        },
      },
    });

    if (existing) {
      // Update last-seen metadata
      await this.prisma.device.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          lastSeenIp: data.ipAddress,
          osVersion: data.osVersion ?? existing.osVersion,
          appVersion: data.appVersion ?? existing.appVersion,
        },
      });

      return { deviceId: existing.id, isNewDevice: false };
    }

    // New device
    const device = await this.prisma.device.create({
      data: {
        userId: data.userId,
        fingerprint: data.fingerprint,
        platform: data.platform,
        osVersion: data.osVersion,
        appVersion: data.appVersion,
        lastSeenIp: data.ipAddress,
        trustLevel: 'UNKNOWN',
        trustScore: 50,
      },
    });

    // Emit event — Notifications module can send "new device login" alert
    this.events.emit('auth.device.new', {
      userId: data.userId,
      deviceId: device.id,
      platform: data.platform,
    });

    this.logger.log(
      { userId: data.userId, deviceId: device.id, platform: data.platform },
      'New device registered',
    );

    return { deviceId: device.id, isNewDevice: true };
  }

  /**
   * List all devices for a user (for the "Manage Devices" screen).
   */
  async listByUserId(userId: string): Promise<
    Array<{
      id: string;
      platform: string;
      osVersion: string | null;
      appVersion: string | null;
      trustLevel: string;
      lastSeenAt: Date;
      lastSeenIp: string | null;
      isRevoked: boolean;
      firstSeenAt: Date;
    }>
  > {
    return this.prisma.device.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        platform: true,
        osVersion: true,
        appVersion: true,
        trustLevel: true,
        lastSeenAt: true,
        lastSeenIp: true,
        isRevoked: true,
        firstSeenAt: true,
      },
    });
  }

  /**
   * Revoke a device — all sessions on this device are also revoked.
   */
  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new Error('Device not found');
    }

    await this.prisma.$transaction([
      // Mark device as revoked
      this.prisma.device.update({
        where: { id: deviceId },
        data: {
          isRevoked: true,
          revokedAt: new Date(),
          trustLevel: 'BLOCKED',
        },
      }),
      // Revoke all sessions on this device
      this.prisma.session.updateMany({
        where: { deviceId, isRevoked: false },
        data: {
          isRevoked: true,
          revokedAt: new Date(),
          revokedReason: 'device_revoked',
        },
      }),
    ]);

    this.events.emit('auth.device.revoked', { userId, deviceId });
    this.logger.log({ userId, deviceId }, 'Device revoked');
  }

  /**
   * Update push notification token for a device.
   */
  async updatePushToken(
    deviceId: string,
    pushToken: string,
  ): Promise<void> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { pushToken },
    });
  }
}
