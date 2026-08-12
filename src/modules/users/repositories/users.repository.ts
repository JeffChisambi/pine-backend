import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

/**
 * Users Repository — Prisma queries for profile and preferences.
 *
 * Intentionally small. Only manages profile data and user preferences.
 * Authentication, KYC, wallet, portfolio all live in their own modules.
 */
@Injectable()
export class UsersRepository {
  private readonly logger = new Logger(UsersRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Profile ─────────────────────────────────────────────────

  async findById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        phoneVerifiedAt: true,
        email: true,
        emailVerifiedAt: true,
        firstName: true,
        lastName: true,
        role: true,
        kycStatus: true,
        avatarKey: true,
        isActive: true,
        brokerId: true,
        brokerSelectedAt: true,
        broker: { select: { id: true, name: true, code: true, logoUrl: true, isActive: true } },
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findByIdWithPreferences(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        phoneVerifiedAt: true,
        email: true,
        emailVerifiedAt: true,
        firstName: true,
        lastName: true,
        role: true,
        kycStatus: true,
        avatarKey: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        preferences: true,
      },
    });
  }

  async updateProfile(
    userId: string,
    data: {
      firstName?: string;
      lastName?: string;
      email?: string;
      avatarKey?: string;
    },
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        phone: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarKey: true,
        updatedAt: true,
      },
    });
  }

  async updateAvatar(userId: string, avatarKey: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { avatarKey },
      select: { id: true, avatarKey: true },
    });
  }

  // ── Preferences ─────────────────────────────────────────────

  async findPreferences(userId: string) {
    return this.prisma.userPreference.findUnique({
      where: { userId },
    });
  }

  async upsertPreferences(
    userId: string,
    data: {
      pushNotifications?: boolean;
      emailNotifications?: boolean;
      smsNotifications?: boolean;
      marketingOptIn?: boolean;
      language?: string;
      currency?: string;
      timezone?: string;
      country?: string;
      biometricLoginEnabled?: boolean;
      largeTextEnabled?: boolean;
      highContrastEnabled?: boolean;
    },
  ) {
    return this.prisma.userPreference.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });
  }

  // ── Identity Facade queries (read-only from other modules) ──

  async findWalletBalance(userId: string) {
    return this.prisma.wallet.findUnique({
      where: { userId },
      select: { balance: true, currency: true },
    });
  }

  async countUserHoldings(userId: string) {
    return this.prisma.holding.count({
      where: { userId, quantity: { gt: 0 } },
    });
  }

  async countUnreadNotifications(userId: string) {
    return this.prisma.notification.count({
      where: { userId, channel: 'IN_APP', readAt: null },
    });
  }

  // ── Admin ───────────────────────────────────────────────────

  /**
   * WARNING: UNSCOPED — returns every user on the platform. Currently
   * unused. If ever wired into an admin route, it MUST take a broker
   * scope (see AdminRepository.listUsers) or be restricted to SUPER_ADMIN.
   */
  async findAll(limit = 50, offset = 0) {
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        select: {
          id: true,
          phone: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          kycStatus: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.user.count(),
    ]);
    return { users, total };
  }
}
