import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UsersRepository } from '../repositories/users.repository';

/**
 * Identity Facade — read-only aggregation from other modules.
 *
 * The Users module reads these values but does NOT own them:
 *
 *   Source         → Exposes
 *   ──────────────────────────────────
 *   Auth           → emailVerified, phoneVerified
 *   KYC            → kycStatus
 *   Wallet         → walletBalance
 *   Portfolio      → holdingsCount
 *   Notifications  → unreadCount
 *   Trading        → tradingEnabled (derived from KYC + wallet)
 *
 * This facade provides the mobile app's home screen data
 * in a single optimized payload.
 */

export interface IdentitySummary {
  profile: {
    id: string;
    firstName: string;
    lastName: string;
    fullName: string;
    initials: string;
    avatarUrl: string | null;
  };
  verification: {
    phoneVerified: boolean;
    emailVerified: boolean;
    kycStatus: string;
  };
  financial: {
    walletBalance: number;
    walletCurrency: string;
    holdingsCount: number;
    tradingEnabled: boolean;
  };
  engagement: {
    unreadNotifications: number;
  };
}

@Injectable()
export class IdentityFacade {
  private readonly logger = new Logger(IdentityFacade.name);

  constructor(private readonly repo: UsersRepository) {}

  /**
   * GET /users/identity — the home screen aggregation.
   *
   * Returns identity data from multiple modules in a single call
   * so the mobile app doesn't need 5 separate API requests.
   */
  async getIdentitySummary(userId: string): Promise<IdentitySummary> {
    const user = await this.repo.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Parallel read from other modules' data
    const [wallet, holdingsCount, unreadCount] = await Promise.all([
      this.repo.findWalletBalance(userId),
      this.repo.countUserHoldings(userId),
      this.repo.countUnreadNotifications(userId),
    ]);

    const kycApproved = user.kycStatus === 'APPROVED';
    const hasWallet = !!wallet;
    const tradingEnabled = kycApproved && hasWallet && user.isActive;

    return {
      profile: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: `${user.firstName} ${user.lastName}`,
        initials: `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase(),
        avatarUrl: user.avatarKey ? `/storage/avatars/${user.avatarKey}` : null,
      },
      verification: {
        phoneVerified: !!user.phoneVerifiedAt,
        emailVerified: !!user.emailVerifiedAt,
        kycStatus: user.kycStatus,
      },
      financial: {
        walletBalance: wallet?.balance.toNumber() ?? 0,
        walletCurrency: wallet?.currency ?? 'MWK',
        holdingsCount,
        tradingEnabled,
      },
      engagement: {
        unreadNotifications: unreadCount,
      },
    };
  }
}
