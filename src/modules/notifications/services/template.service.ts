import { Injectable, Logger } from '@nestjs/common';
import { NotificationRepository } from '../repositories/notification.repository';

/**
 * Template Service — renders notification messages from templates.
 *
 * Never build messages inside business logic!
 *
 * Bad:  sendPush("Your trade was successful")
 * Good: template('trade.executed', { stock: 'TNM', quantity: 100, price: 205 })
 *
 * Templates use simple {{variable}} interpolation.
 * Supports future multi-language expansion.
 */

/** Default templates seeded on startup if not in DB */
const DEFAULT_TEMPLATES: Record<string, { subject?: string; body: string }> = {
  // ── Trading ─────────────────────────────────────────────
  'trade.order.placed': {
    subject: 'Order Placed',
    body: 'Your {{side}} order for {{quantity}} {{symbol}} shares has been placed and sent to your broker for execution.',
  },
  'trade.buy.executed': {
    subject: 'Buy Order Filled',
    body: 'Your purchase of {{quantity}} {{symbol}} shares at MWK {{price}} has been completed. Total cost: MWK {{totalCost}}.',
  },
  'trade.sell.executed': {
    subject: 'Sell Order Filled',
    body: 'Your sale of {{quantity}} {{symbol}} shares at MWK {{price}} has been completed. Proceeds: MWK {{totalCost}}.',
  },
  'trade.order.cancelled': {
    subject: 'Order Cancelled',
    body: 'Your {{side}} order for {{quantity}} {{symbol}} shares has been cancelled.',
  },
  'trade.order.rejected': {
    subject: 'Order Rejected',
    body: 'Your {{side}} order for {{quantity}} {{symbol}} was rejected: {{reason}}.',
  },
  'trade.settlement.complete': {
    subject: 'Trade Settled',
    body: 'Your {{side}} of {{quantity}} {{symbol}} shares has been settled and your portfolio has been updated.',
  },

  // ── Wallet ──────────────────────────────────────────────
  'wallet.deposit.received': {
    subject: 'Deposit Received',
    body: 'Your deposit of MWK {{amount}} has been received and added to your wallet. Balance: MWK {{balance}}.',
  },
  'wallet.withdrawal.completed': {
    subject: 'Withdrawal Processed',
    body: 'Your withdrawal of MWK {{amount}} has been processed successfully.',
  },

  // ── KYC ─────────────────────────────────────────────────
  'kyc.approved': {
    subject: 'Identity Verified',
    body: 'Your identity has been verified! You can now trade on the Malawi Stock Exchange.',
  },
  'kyc.rejected': {
    subject: 'Verification Failed',
    body: 'Your identity verification was not approved: {{reason}}. Please resubmit your documents.',
  },

  // ── Security ────────────────────────────────────────────
  'security.new_login': {
    subject: 'New Login Detected',
    body: 'A new login was detected on your Pine account from {{device}} at {{time}}. If this wasn\'t you, please change your password immediately.',
  },
  'security.password_changed': {
    subject: 'Password Changed',
    body: 'Your password was changed at {{time}}. If you didn\'t make this change, contact support immediately.',
  },
  'security.pin_changed': {
    subject: 'Transaction PIN Changed',
    body: 'Your transaction PIN was changed. If you didn\'t make this change, contact support immediately.',
  },

  // ── Market ──────────────────────────────────────────────
  'market.price_alert': {
    subject: 'Price Alert: {{symbol}}',
    body: '{{symbol}} has reached MWK {{price}}. {{direction}} your target of MWK {{target}}.',
  },
  'market.dividend_declared': {
    subject: 'Dividend Declared: {{symbol}}',
    body: '{{symbol}} has declared a dividend of MWK {{amount}} per share. Record date: {{recordDate}}.',
  },
  'market.price_moved': {
    subject: '{{symbol}} {{direction}} {{changePct}}%',
    body: '{{name}} ({{symbol}}) moved {{signedPct}}% to MWK {{price}} today.',
  },

  // ── Portfolio ───────────────────────────────────────────
  'portfolio.daily_summary': {
    subject: 'Daily Portfolio Summary',
    body: 'Your portfolio value: MWK {{portfolioValue}}. Today\'s change: {{dailyChange}} ({{dailyChangePct}}%).',
  },

  // ── Support ─────────────────────────────────────────────
  // Pass-through template: the support module composes its own copy.
  'support.update': {
    subject: '{{title}}',
    body: '{{body}}',
  },

  // ── System ──────────────────────────────────────────────
  'system.welcome': {
    subject: 'Welcome to Pine',
    body: 'Welcome to Pine! Your journey into the Malawi Stock Exchange starts here. Complete your KYC verification to begin trading.',
  },
  'system.maintenance': {
    subject: 'Scheduled Maintenance',
    body: 'Pine will be undergoing maintenance on {{date}} from {{startTime}} to {{endTime}}. Trading will be temporarily unavailable.',
  },
};

@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);
  /** In-memory cache of templates for fast lookup */
  private cache = new Map<string, { subject?: string; body: string }>();

  constructor(private readonly repo: NotificationRepository) {}

  /**
   * Seed default templates on module init if they don't exist.
   */
  async seedDefaults(): Promise<void> {
    let seeded = 0;
    for (const [key, tmpl] of Object.entries(DEFAULT_TEMPLATES)) {
      const existing = await this.repo.findTemplateByKey(key);
      if (!existing) {
        await this.repo.upsertTemplate({
          key,
          channel: 'IN_APP',
          subject: tmpl.subject,
          body: tmpl.body,
        });
        seeded++;
      }
      // Populate cache
      this.cache.set(key, { subject: tmpl.subject, body: tmpl.body });
    }
    if (seeded > 0) {
      this.logger.log({ count: seeded }, 'Seeded notification templates');
    }
  }

  /**
   * Render a template by key with variables.
   *
   * @example
   * render('trade.buy.executed', { symbol: 'TNM', quantity: 100, price: '205' })
   * // → { subject: 'Buy Order Filled', body: 'Your purchase of 100 TNM shares...' }
   */
  async render(
    templateKey: string,
    variables: Record<string, string | number>,
  ): Promise<{ subject: string; body: string }> {
    // Check cache first
    let template = this.cache.get(templateKey);

    // Fallback to DB
    if (!template) {
      const dbTemplate = await this.repo.findTemplateByKey(templateKey);
      if (dbTemplate) {
        template = { subject: dbTemplate.subject ?? '', body: dbTemplate.body };
        this.cache.set(templateKey, template);
      }
    }

    // Fallback to defaults
    if (!template) {
      template = DEFAULT_TEMPLATES[templateKey];
    }

    if (!template) {
      this.logger.warn({ templateKey }, 'Template not found — using raw key');
      return { subject: templateKey, body: templateKey };
    }

    return {
      subject: this.interpolate(template.subject ?? '', variables),
      body: this.interpolate(template.body, variables),
    };
  }

  /**
   * Simple {{variable}} interpolation.
   */
  private interpolate(
    text: string,
    variables: Record<string, string | number>,
  ): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return variables[key]?.toString() ?? `{{${key}}}`;
    });
  }
}
