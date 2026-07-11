import { Injectable, Logger } from '@nestjs/common';
import { NotificationRepository } from '../repositories/notification.repository';

/**
 * Preference Service — manages per-user notification preferences.
 *
 * Categories: SECURITY, TRADING, PORTFOLIO, WALLET, KYC, MARKET, SYSTEM, MARKETING
 *
 * Rules:
 * - SECURITY notifications ALWAYS deliver (can't be disabled by user)
 * - MARKETING notifications are fully opt-in/opt-out
 * - All other categories are opt-out per channel
 *
 * Default preferences (when user has no row):
 *   Push: ON, Email: ON, SMS: OFF, In-App: ON
 */

export interface ChannelPreferences {
  push: boolean;
  email: boolean;
  sms: boolean;
  inApp: boolean;
}

/** Categories that ALWAYS send regardless of user preference */
const MANDATORY_CATEGORIES = new Set(['SECURITY']);

/** All valid notification categories */
export const NOTIFICATION_CATEGORIES = [
  'SECURITY',
  'TRADING',
  'PORTFOLIO',
  'WALLET',
  'KYC',
  'MARKET',
  'SYSTEM',
  'MARKETING',
] as const;

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];

/** Default preferences for new users / unconfigured categories */
const DEFAULT_PREFERENCES: ChannelPreferences = {
  push: true,
  email: true,
  sms: false,
  inApp: true,
};

@Injectable()
export class PreferenceService {
  private readonly logger = new Logger(PreferenceService.name);

  constructor(private readonly repo: NotificationRepository) {}

  /**
   * Get the enabled channels for a user + category.
   *
   * Security notifications always return all channels regardless
   * of user preferences.
   */
  async getEnabledChannels(
    userId: string,
    category: string,
  ): Promise<string[]> {
    // Security notifications ALWAYS deliver on all channels
    if (MANDATORY_CATEGORIES.has(category)) {
      return ['PUSH', 'IN_APP', 'EMAIL'];
    }

    const pref = await this.repo.findUserPreference(userId, category);
    const channels: string[] = [];

    // Always include IN_APP (it's the inbox)
    channels.push('IN_APP');

    if (pref) {
      if (pref.pushEnabled) channels.push('PUSH');
      if (pref.emailEnabled) channels.push('EMAIL');
      if (pref.smsEnabled) channels.push('SMS');
    } else {
      // Default preferences
      if (DEFAULT_PREFERENCES.push) channels.push('PUSH');
      if (DEFAULT_PREFERENCES.email) channels.push('EMAIL');
      if (DEFAULT_PREFERENCES.sms) channels.push('SMS');
    }

    return [...new Set(channels)]; // Deduplicate
  }

  /**
   * Get all preferences for a user (for the settings screen).
   */
  async getAllPreferences(userId: string): Promise<Record<string, ChannelPreferences>> {
    const stored = await this.repo.findUserPreferences(userId);
    const result: Record<string, ChannelPreferences> = {};

    for (const category of NOTIFICATION_CATEGORIES) {
      const pref = stored.find((p) => p.category === category);
      const isMandatory = MANDATORY_CATEGORIES.has(category);

      result[category] = {
        push: isMandatory ? true : (pref?.pushEnabled ?? DEFAULT_PREFERENCES.push),
        email: isMandatory ? true : (pref?.emailEnabled ?? DEFAULT_PREFERENCES.email),
        sms: isMandatory ? false : (pref?.smsEnabled ?? DEFAULT_PREFERENCES.sms),
        inApp: true, // Always on
      };
    }

    return result;
  }

  /**
   * Update preferences for a specific category.
   */
  async updatePreferences(
    userId: string,
    category: string,
    prefs: Partial<ChannelPreferences>,
  ): Promise<void> {
    // Don't allow disabling mandatory categories
    if (MANDATORY_CATEGORIES.has(category)) {
      this.logger.warn(
        { userId, category },
        'Cannot modify preferences for mandatory category',
      );
      return;
    }

    const existing = await this.repo.findUserPreference(userId, category);
    await this.repo.upsertPreference({
      userId,
      category,
      pushEnabled: prefs.push ?? existing?.pushEnabled ?? DEFAULT_PREFERENCES.push,
      emailEnabled: prefs.email ?? existing?.emailEnabled ?? DEFAULT_PREFERENCES.email,
      smsEnabled: prefs.sms ?? existing?.smsEnabled ?? DEFAULT_PREFERENCES.sms,
      inAppEnabled: true, // Always on
    });

    this.logger.log({ userId, category, prefs }, 'Preferences updated');
  }
}
