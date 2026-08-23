import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationRepository } from '../repositories/notification.repository';
import { TemplateService } from './template.service';
import { PreferenceService } from './preference.service';
import { DeliveryService } from './delivery.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

/**
 * Notification Service — the orchestrator of the Communications Platform.
 *
 * Every other module only publishes events on the Event Bus.
 * They NEVER send notifications directly. This service:
 *
 * 1. Receives domain events (trade.executed, kyc.approved, etc.)
 * 2. Checks: should we notify? (preferences)
 * 3. Selects channels (push, email, SMS, in-app)
 * 4. Renders template
 * 5. Queues delivery
 * 6. Tracks delivery status
 *
 * Workflow:
 *   Event → Load Preferences → Select Channels → Render Template
 *   → Queue Delivery → Provider Sends → Status Saved → In-App Stored
 */

/** Priority levels */
const PRIORITY = {
  CRITICAL: 0,
  IMPORTANT: 1,
  INFORMATIONAL: 2,
  PROMOTIONAL: 3,
} as const;

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly repo: NotificationRepository,
    private readonly templateService: TemplateService,
    private readonly preferenceService: PreferenceService,
    private readonly deliveryService: DeliveryService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Seed default templates
    await this.templateService.seedDefaults();
    this.logger.log('Notification service initialized');
  }

  // ── Core: Send Notification ─────────────────────────────────

  /**
   * Send a notification to a user.
   *
   * This is the single entry point for all notification dispatch.
   * Every event handler calls this method.
   */
  async notify(params: {
    userId: string;
    templateKey: string;
    variables: Record<string, string | number>;
    category: string;
    priority: number;
    data?: Record<string, any>;
  }): Promise<void> {
    try {
      // 1. Render template
      const { subject, body } = await this.templateService.render(
        params.templateKey,
        params.variables,
      );

      // 2. Get enabled channels based on user preferences
      const channels = await this.preferenceService.getEnabledChannels(
        params.userId,
        params.category,
      );

      if (channels.length === 0) {
        this.logger.log(
          { userId: params.userId, templateKey: params.templateKey },
          'All channels disabled — skipping notification',
        );
        return;
      }

      // 3. Create IN_APP notification record (the inbox entry)
      const notification = await this.repo.createNotification({
        userId: params.userId,
        channel: 'IN_APP',
        templateKey: params.templateKey,
        type: this.priorityToType(params.priority),
        priority: params.priority,
        category: params.category,
        title: subject,
        body,
        data: params.data,
      });

      // 4. Deliver through each enabled channel
      await this.deliveryService.deliverToChannels(channels, {
        notificationId: notification.id,
        userId: params.userId,
        title: subject,
        body,
        data: params.data,
      });

      // 5. Mark notification as sent
      await this.repo.updateNotificationStatus(notification.id, 'SENT', {
        sentAt: new Date(),
      });

      this.logger.log(
        {
          userId: params.userId,
          templateKey: params.templateKey,
          channels,
        },
        'Notification sent',
      );
    } catch (error) {
      this.logger.error(
        { err: error, userId: params.userId, templateKey: params.templateKey },
        'Failed to send notification',
      );
    }
  }

  // ── Event Handlers ──────────────────────────────────────────

  /** Trading: order placed (immediate or queued for market open) */
  @OnEvent('trading.order.created')
  async onOrderCreated(event: {
    orderId: string;
    userId: string;
    stockSymbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    orderType: string;
  }) {
    await this.notify({
      userId: event.userId,
      templateKey: 'trade.order.placed',
      variables: {
        symbol: event.stockSymbol,
        quantity: event.quantity,
        side: event.side,
      },
      category: 'TRADING',
      priority: PRIORITY.INFORMATIONAL,
      data: { orderId: event.orderId },
    });
  }

  /** KYC: application approved (emitted by the admin review actions) */
  @OnEvent('kyc.approved')
  async onKycApproved(event: { userId: string }) {
    await this.notify({
      userId: event.userId,
      templateKey: 'kyc.approved',
      variables: {},
      category: 'KYC',
      priority: PRIORITY.IMPORTANT,
      data: { type: 'KYC_APPROVED' },
    });
  }

  /** KYC: application rejected (emitted by the admin review actions) */
  @OnEvent('kyc.rejected')
  async onKycRejected(event: { userId: string; reason?: string }) {
    await this.notify({
      userId: event.userId,
      templateKey: 'kyc.rejected',
      variables: { reason: event.reason ?? 'See the app for details' },
      category: 'KYC',
      priority: PRIORITY.IMPORTANT,
      data: { type: 'KYC_REJECTED' },
    });
  }

  /** Trading: order executed */
  @OnEvent('trading.order.executed')
  async onOrderExecuted(event: {
    orderId: string;
    userId: string;
    stockSymbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    totalCost: number;
    tradeId: string;
  }) {
    const templateKey = event.side === 'BUY' ? 'trade.buy.executed' : 'trade.sell.executed';
    await this.notify({
      userId: event.userId,
      templateKey,
      variables: {
        symbol: event.stockSymbol,
        quantity: event.quantity,
        price: event.price.toLocaleString(),
        totalCost: event.totalCost.toLocaleString(),
        side: event.side,
      },
      category: 'TRADING',
      priority: PRIORITY.IMPORTANT,
      data: { orderId: event.orderId, tradeId: event.tradeId },
    });
  }

  /**
   * Market: a stock's price moved during the trading day. Fired by the
   * market-sync pipeline (at most once per stock per day). Notifies every
   * investor who HOLDS or WATCHES the stock — a platform-wide broadcast
   * would be noise on a 16-stock exchange.
   */
  @OnEvent('market.price.moved')
  async onPriceMoved(event: {
    stockId: string;
    symbol: string;
    name: string;
    price: number;
    changePct: number;
  }) {
    const [holders, watchers] = await Promise.all([
      this.prisma.holding.findMany({
        where: { stockId: event.stockId, quantity: { gt: 0 } },
        select: { userId: true },
      }),
      this.prisma.watchlistEntry.findMany({
        where: { stockId: event.stockId },
        select: { userId: true },
      }),
    ]);
    const userIds = [...new Set([...holders, ...watchers].map((r) => r.userId))];
    if (userIds.length === 0) return;

    const up = event.changePct > 0;
    await Promise.allSettled(
      userIds.map((userId) =>
        this.notify({
          userId,
          templateKey: 'market.price_moved',
          variables: {
            symbol: event.symbol,
            name: event.name,
            direction: up ? 'up' : 'down',
            changePct: Math.abs(event.changePct).toFixed(2),
            signedPct: `${up ? '+' : '-'}${Math.abs(event.changePct).toFixed(2)}`,
            price: event.price.toLocaleString(),
          },
          category: 'MARKET',
          priority: PRIORITY.INFORMATIONAL,
          data: { stockId: event.stockId, symbol: event.symbol, screen: 'stock' },
        }),
      ),
    );
  }

  /** Trading: order rejected */
  @OnEvent('trading.order.rejected')
  async onOrderRejected(event: {
    orderId: string;
    userId: string;
    reason: string;
  }) {
    // Look up the order to get side/quantity/symbol — the event only carries
    // orderId/userId/reason, so hardcoded BUY/0/'' produced broken notifications.
    const order = await this.prisma.order
      .findUnique({
        where: { id: event.orderId },
        select: { side: true, quantity: true, stock: { select: { symbol: true } } },
      })
      .catch(() => null);

    await this.notify({
      userId: event.userId,
      templateKey: 'trade.order.rejected',
      variables: {
        reason: event.reason,
        side: order?.side?.toLowerCase() ?? 'buy',
        quantity: order?.quantity?.toNumber() ?? 0,
        symbol: order?.stock?.symbol ?? '',
      },
      category: 'TRADING',
      priority: PRIORITY.IMPORTANT,
      data: { orderId: event.orderId },
    });
  }

  /** Trading: order cancelled */
  @OnEvent('trading.order.cancelled')
  async onOrderCancelled(event: {
    orderId: string;
    userId: string;
    reason: string;
  }) {
    // Same as onOrderRejected — look up order details the event doesn't carry.
    const order = await this.prisma.order
      .findUnique({
        where: { id: event.orderId },
        select: { side: true, quantity: true, stock: { select: { symbol: true } } },
      })
      .catch(() => null);

    await this.notify({
      userId: event.userId,
      templateKey: 'trade.order.cancelled',
      variables: {
        reason: event.reason,
        side: order?.side?.toLowerCase() ?? '',
        quantity: order?.quantity?.toNumber() ?? 0,
        symbol: order?.stock?.symbol ?? '',
      },
      category: 'TRADING',
      priority: PRIORITY.INFORMATIONAL,
      data: { orderId: event.orderId },
    });
  }

  /** Trading: trade settled */
  @OnEvent('trading.trade.settled')
  async onTradeSettled(event: {
    tradeId: string;
    orderId: string;
    userId: string;
    stockId: string;
    stockSymbol: string;  // now carried by TradeSettledEvent
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
  }) {
    await this.notify({
      userId: event.userId,
      templateKey: 'trade.settlement.complete',
      variables: {
        side: event.side.toLowerCase(),
        quantity: event.quantity,
        symbol: event.stockSymbol, // was event.stockId (UUID) — now the human-readable ticker
      },
      category: 'TRADING',
      priority: PRIORITY.INFORMATIONAL,
      data: { tradeId: event.tradeId, orderId: event.orderId },
    });
  }

  /** Portfolio: updated after trade */
  @OnEvent('portfolio.updated')
  async onPortfolioUpdated(event: {
    userId: string;
    stockId: string;
    newQuantity: number;
    averageCost: number;
  }) {
    // Don't notify for portfolio updates — the trade notification is enough.
    // This handler is here as a hook for future portfolio-specific notifications
    // (e.g., "Your portfolio just crossed MWK 1,000,000!")
  }

  /** Wallet: balance updated after deposit or withdrawal */
  @OnEvent('wallet.updated')
  async onWalletUpdated(event: {
    userId: string;
    type: 'DEPOSIT' | 'WITHDRAWAL';
    amount: number;
    newBalance: number;
  }) {
    if (event.type === 'DEPOSIT') {
      await this.notify({
        userId: event.userId,
        templateKey: 'wallet.deposit.received',
        variables: {
          amount: event.amount.toLocaleString(),
          balance: event.newBalance.toLocaleString(),
        },
        category: 'WALLET',
        priority: PRIORITY.IMPORTANT,
        data: {
          type: 'DEPOSIT',
          amount: event.amount,
          newBalance: event.newBalance,
        },
      });
    } else if (event.type === 'WITHDRAWAL') {
      await this.notify({
        userId: event.userId,
        templateKey: 'wallet.withdrawal.completed',
        variables: {
          amount: event.amount.toLocaleString(),
        },
        category: 'WALLET',
        priority: PRIORITY.IMPORTANT,
        data: {
          type: 'WITHDRAWAL',
          amount: event.amount,
        },
      });
    }
  }

  /** Wallet: withdrawal rejected by the broker — funds stay in the wallet */
  @OnEvent('wallet.withdrawal.rejected')
  async onWithdrawalRejected(event: {
    userId: string;
    amount: number;
    reason: string;
  }) {
    await this.notify({
      userId: event.userId,
      templateKey: 'wallet.withdrawal.rejected',
      variables: {
        amount: event.amount.toLocaleString(),
        reason: event.reason,
      },
      category: 'WALLET',
      priority: PRIORITY.IMPORTANT,
      data: {
        type: 'WITHDRAWAL_REJECTED',
        amount: event.amount,
        reason: event.reason,
      },
    });
  }

  /** Corporate Actions: dividend paid to user */
  @OnEvent('corporate-actions.dividend.paid')
  async onDividendPaid(event: {
    userId: string;
    stockSymbol: string;
    quantity: number;
    grossAmount: number;
    netAmount: number;
  }) {
    await this.notify({
      userId: event.userId,
      templateKey: 'market.dividend_declared',
      variables: {
        symbol: event.stockSymbol,
        amount: event.netAmount.toLocaleString(),
        recordDate: new Date().toISOString().split('T')[0],
      },
      category: 'PORTFOLIO',
      priority: PRIORITY.IMPORTANT,
      data: {
        stockSymbol: event.stockSymbol,
        grossAmount: event.grossAmount,
        netAmount: event.netAmount,
      },
    });
  }

  /** Corporate Actions: bonus shares issued */
  @OnEvent('corporate-actions.bonus.issued')
  async onBonusIssued(event: {
    userId: string;
    stockId: string;
    bonusShares: number;
    newQuantity: number;
  }) {
    await this.notify({
      userId: event.userId,
      templateKey: 'system.welcome', // Fallback — will use title/body
      variables: {},
      category: 'PORTFOLIO',
      priority: PRIORITY.IMPORTANT,
      data: {
        type: 'BONUS_ISSUE',
        stockId: event.stockId,
        bonusShares: event.bonusShares,
        newQuantity: event.newQuantity,
      },
    });
  }

  /** Corporate Actions: stock split applied */
  @OnEvent('corporate-actions.split.applied')
  async onStockSplit(event: {
    userId: string;
    stockId: string;
    ratioFrom: number;
    ratioTo: number;
    oldQuantity: number;
    newQuantity: number;
  }) {
    await this.notify({
      userId: event.userId,
      templateKey: 'system.welcome', // Fallback — will use title/body
      variables: {},
      category: 'PORTFOLIO',
      priority: PRIORITY.IMPORTANT,
      data: {
        type: 'STOCK_SPLIT',
        stockId: event.stockId,
        ratio: `${event.ratioTo}-for-${event.ratioFrom}`,
        oldQuantity: event.oldQuantity,
        newQuantity: event.newQuantity,
      },
    });
  }

  // ── API Methods ─────────────────────────────────────────────

  /** GET /notifications — user's in-app notifications */
  async getNotifications(userId: string, limit = 30, offset = 0) {
    const { notifications, total } = await this.repo.findUserNotifications(userId, limit, offset);
    return {
      notifications: notifications.map((n) => this.formatNotification(n)),
      total,
      unreadCount: await this.repo.countUnread(userId),
    };
  }

  /** GET /notifications/unread */
  async getUnreadNotifications(userId: string) {
    const notifications = await this.repo.findUnreadNotifications(userId);
    return {
      notifications: notifications.map((n) => this.formatNotification(n)),
      count: notifications.length,
    };
  }

  /** POST /notifications/read */
  async markAsRead(userId: string, notificationId: string) {
    await this.repo.markAsRead(notificationId, userId);
    return { success: true };
  }

  /** POST /notifications/read-all */
  async markAllAsRead(userId: string) {
    const result = await this.repo.markAllAsRead(userId);
    return { success: true, count: result.count };
  }

  /** DELETE /notifications/:id */
  async deleteNotification(userId: string, notificationId: string) {
    await this.repo.deleteNotification(notificationId, userId);
    return { success: true };
  }

  /** DELETE /notifications — clear the whole in-app inbox */
  async clearAllNotifications(userId: string) {
    const result = await this.repo.deleteAllNotifications(userId);
    return { success: true, count: result.count };
  }

  /** GET /notifications/preferences */
  async getPreferences(userId: string) {
    return this.preferenceService.getAllPreferences(userId);
  }

  /** PUT /notifications/preferences */
  async updatePreferences(
    userId: string,
    category: string,
    prefs: { push?: boolean; email?: boolean; sms?: boolean },
  ) {
    await this.preferenceService.updatePreferences(userId, category, prefs);
    return { success: true };
  }

  // ── Helpers ─────────────────────────────────────────────────

  private priorityToType(priority: number): string {
    switch (priority) {
      case 0: return 'CRITICAL';
      case 1: return 'IMPORTANT';
      case 2: return 'INFORMATIONAL';
      case 3: return 'PROMOTIONAL';
      default: return 'INFORMATIONAL';
    }
  }

  private formatNotification(n: any) {
    return {
      id: n.id,
      type: n.type,
      category: n.category,
      priority: n.priority,
      title: n.title,
      body: n.body,
      data: n.data,
      isRead: !!n.readAt,
      readAt: n.readAt,
      createdAt: n.createdAt,
    };
  }
}
