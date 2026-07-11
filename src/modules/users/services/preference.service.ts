import { Injectable, Logger } from '@nestjs/common';
import { UsersRepository } from '../repositories/users.repository';

/**
 * Preference Service — manages user settings.
 *
 * Owns:
 *   Language, timezone, country, currency
 *   Notification preferences (push/email/SMS toggles)
 *   Marketing consent
 *   Accessibility settings
 *   Biometric login preference
 *
 * Does NOT own:
 *   Per-notification-category preferences (that's the Notifications module)
 */

export interface UserPreferences {
  language: string;
  currency: string;
  timezone: string;
  country: string;
  notifications: {
    push: boolean;
    email: boolean;
    sms: boolean;
  };
  marketingOptIn: boolean;
  biometricLogin: boolean;
  accessibility: {
    largeText: boolean;
    highContrast: boolean;
  };
}

const DEFAULT_PREFERENCES: UserPreferences = {
  language: 'en',
  currency: 'MWK',
  timezone: 'Africa/Blantyre',
  country: 'MW',
  notifications: { push: true, email: true, sms: true },
  marketingOptIn: false,
  biometricLogin: false,
  accessibility: { largeText: false, highContrast: false },
};

@Injectable()
export class UserPreferenceService {
  private readonly logger = new Logger(UserPreferenceService.name);

  constructor(private readonly repo: UsersRepository) {}

  /**
   * GET /users/preferences
   */
  async getPreferences(userId: string): Promise<UserPreferences> {
    const pref = await this.repo.findPreferences(userId);

    if (!pref) {
      return DEFAULT_PREFERENCES;
    }

    return {
      language: pref.language,
      currency: pref.currency,
      timezone: pref.timezone,
      country: pref.country,
      notifications: {
        push: pref.pushNotifications,
        email: pref.emailNotifications,
        sms: pref.smsNotifications,
      },
      marketingOptIn: pref.marketingOptIn,
      biometricLogin: pref.biometricLoginEnabled,
      accessibility: {
        largeText: pref.largeTextEnabled,
        highContrast: pref.highContrastEnabled,
      },
    };
  }

  /**
   * PUT /users/preferences
   */
  async updatePreferences(
    userId: string,
    data: Partial<{
      language: string;
      currency: string;
      timezone: string;
      country: string;
      pushNotifications: boolean;
      emailNotifications: boolean;
      smsNotifications: boolean;
      marketingOptIn: boolean;
      biometricLoginEnabled: boolean;
      largeTextEnabled: boolean;
      highContrastEnabled: boolean;
    }>,
  ): Promise<UserPreferences> {
    await this.repo.upsertPreferences(userId, data);

    this.logger.log(
      { userId, fields: Object.keys(data) },
      'Preferences updated',
    );

    return this.getPreferences(userId);
  }
}
