import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UsersRepository } from '../repositories/users.repository';

/**
 * Profile Service — manages user profile data.
 *
 * Owns:
 *   Legal display name, preferred name, avatar, profile completion
 *
 * Does NOT own:
 *   Passwords, PINs, sessions, KYC, wallet, portfolio, orders
 *
 * Rule: If changing the code could accidentally move money, execute
 * a trade, approve KYC, or weaken security, it does NOT belong here.
 */

export interface UserProfile {
  id: string;
  phone: string;
  phoneVerified: boolean;
  email: string | null;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  fullName: string;
  initials: string;
  avatarUrl: string | null;
  kycStatus: string;
  isActive: boolean;
  profileCompletion: number;
  memberSince: string;
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(private readonly repo: UsersRepository) {}

  /**
   * GET /users/me — the user's profile.
   */
  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.repo.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      id: user.id,
      phone: this.maskPhone(user.phone),
      phoneVerified: !!user.phoneVerifiedAt,
      email: user.email,
      emailVerified: !!user.emailVerifiedAt,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: `${user.firstName} ${user.lastName}`,
      initials: `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase(),
      avatarUrl: user.avatarKey ? this.buildAvatarUrl(user.avatarKey) : null,
      kycStatus: user.kycStatus,
      isActive: user.isActive,
      profileCompletion: this.calculateCompletion(user),
      memberSince: user.createdAt.toISOString().split('T')[0],
    };
  }

  /**
   * PATCH /users/me — update profile fields.
   */
  async updateProfile(
    userId: string,
    data: { firstName?: string; lastName?: string; email?: string },
  ) {
    const user = await this.repo.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.repo.updateProfile(userId, data);

    this.logger.log(
      { userId, fields: Object.keys(data) },
      'Profile updated',
    );

    return {
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      fullName: `${updated.firstName} ${updated.lastName}`,
      email: updated.email,
      avatarUrl: updated.avatarKey ? this.buildAvatarUrl(updated.avatarKey) : null,
    };
  }

  /**
   * PUT /users/avatar — upload/update avatar.
   */
  async updateAvatar(userId: string, avatarKey: string): Promise<{ avatarUrl: string }> {
    await this.repo.updateAvatar(userId, avatarKey);
    return { avatarUrl: this.buildAvatarUrl(avatarKey) };
  }

  // ── Helpers ─────────────────────────────────────────────────

  /**
   * Calculate profile completion percentage.
   * Checks: name, email, phone verified, avatar, KYC
   */
  private calculateCompletion(user: {
    firstName: string;
    lastName: string;
    email: string | null;
    emailVerifiedAt: Date | null;
    phoneVerifiedAt: Date | null;
    avatarKey: string | null;
    kycStatus: string;
  }): number {
    let completed = 0;
    const total = 5;

    if (user.firstName && user.lastName) completed++;
    if (user.email) completed++;
    if (user.phoneVerifiedAt) completed++;
    if (user.avatarKey) completed++;
    if (user.kycStatus === 'APPROVED') completed++;

    return Math.round((completed / total) * 100);
  }

  /**
   * Mask phone number for display: +265 99X XXX X32
   */
  private maskPhone(phone: string): string {
    if (phone.length < 6) return phone;
    const visible = phone.slice(0, 7);
    const hidden = phone.slice(7, -2).replace(/\d/g, 'X');
    const last = phone.slice(-2);
    return `${visible}${hidden}${last}`;
  }

  /**
   * Build full avatar URL from storage key.
   */
  private buildAvatarUrl(key: string): string {
    // TODO: Replace with actual CDN/storage URL builder
    return `/storage/avatars/${key}`;
  }
}
