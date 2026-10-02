import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { appConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { TradeSettledEvent } from '../../trading/events/trading.events';
import { dedupeKeys } from '../domain/dedupe-keys';
import { toMalawiDay, toMalawiDayString } from '../domain/malawi-day';
import { MIN_SCORING_NOTIONAL } from '../domain/rule-catalogue';
import { PointsAwardService } from './points-award.service';
import { MilestoneService } from './milestone.service';
import { SeasonService } from './season.service';

interface WalletUpdatedPayload {
  userId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  newBalance: number;
}

/**
 * Where the rest of the platform becomes points.
 *
 * Every handler is fire-and-forget and must never throw: a points failure
 * cannot be allowed to break a settlement or a registration, which is the
 * same stance the notification service takes on the same event bus. Nothing
 * here calls into the wallet or trading modules; the coupling is one way.
 */
@Injectable()
export class PointsListenerService {
  private readonly logger = new Logger(PointsListenerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly awards: PointsAwardService,
    private readonly milestones: MilestoneService,
    private readonly seasons: SeasonService,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  @OnEvent('auth.user.registered')
  async onRegistered(payload: { userId: string }): Promise<void> {
    await this.safely('auth.user.registered', async () => {
      await this.awards.award({
        userId: payload.userId,
        ruleKey: 'SIGN_UP',
        dedupeKey: dedupeKeys.signUp(payload.userId),
      });
    });
  }

  /**
   * Deposits are keyed by the DAY, not the transaction. Practice deposits
   * are instant and free, so a transaction key would let a thousand
   * one-kwacha deposits score a thousand times; with a day key the second
   * deposit of a day is literally the same row and bounces off the index.
   */
  @OnEvent('wallet.updated')
  async onWalletUpdated(payload: WalletUpdatedPayload): Promise<void> {
    if (payload.type !== 'DEPOSIT') return;
    await this.safely('wallet.updated', async () => {
      if (payload.amount < MIN_SCORING_NOTIONAL) return;
      const now = new Date();
      await this.awards.award({
        userId: payload.userId,
        ruleKey: 'DEPOSIT_FUNDS',
        dedupeKey: dedupeKeys.deposit(
          payload.userId,
          toMalawiDayString(now, this.app.timezone),
        ),
        metadata: { amount: payload.amount },
      });
    });
  }

  /**
   * Trades score on settlement, which is the platform's post-commit channel
   * and fires once per settled trade.
   *
   * A sell only scores when the holding was opened on an EARLIER Malawi day.
   * This is the measure that actually kills wash trading: practice orders
   * fill instantly, so buy-then-sell is one round trip, and without this the
   * leaderboard would simply rank whoever wrote the shortest script. With it,
   * a cycle takes a day rather than a second.
   */
  @OnEvent(TradeSettledEvent.event)
  async onTradeSettled(event: TradeSettledEvent): Promise<void> {
    await this.safely('trading.trade.settled', async () => {
      const notional = event.quantity * event.price;
      const now = new Date();

      if (notional < MIN_SCORING_NOTIONAL) {
        await this.milestones.evaluateTrading(event.userId, now);
        return;
      }

      if (event.side === 'BUY') {
        await this.awards.award({
          userId: event.userId,
          ruleKey: 'BUY_STOCK',
          dedupeKey: dedupeKeys.buy(event.tradeId),
          metadata: { symbol: event.stockSymbol, quantity: event.quantity },
        });
      } else {
        const heldSinceEarlierDay = await this.heldSinceEarlierDay(
          event.userId,
          event.stockId,
          now,
        );
        if (heldSinceEarlierDay) {
          await this.awards.award({
            userId: event.userId,
            ruleKey: 'SELL_STOCK',
            dedupeKey: dedupeKeys.sell(event.tradeId),
            metadata: { symbol: event.stockSymbol, quantity: event.quantity },
          });
        } else {
          this.logger.debug(
            `Sell of ${event.stockSymbol} by ${event.userId} scored nothing: bought today`,
          );
        }
      }

      await this.milestones.evaluateTrading(event.userId, now);
    });
  }

  /** Daily check-in rides the login event as well as the explicit claim. */
  @OnEvent('auth.user.loggedin')
  async onLoggedIn(payload: { userId: string }): Promise<void> {
    await this.safely('auth.user.loggedin', async () => {
      const now = new Date();
      await this.awards.award({
        userId: payload.userId,
        ruleKey: 'DAILY_CHECK_IN',
        dedupeKey: dedupeKeys.checkIn(
          payload.userId,
          toMalawiDayString(now, this.app.timezone),
        ),
      });
    });
  }

  /**
   * True when the user's position in this stock was opened on an earlier
   * Malawi day. `Holding` is unique per user and stock, so its createdAt is
   * when the position was first opened — a same-day buy-and-sell leaves a row
   * created today.
   */
  private async heldSinceEarlierDay(
    userId: string,
    stockId: string,
    at: Date,
  ): Promise<boolean> {
    const holding = await this.prisma.holding.findUnique({
      where: { userId_stockId: { userId, stockId } },
      select: { createdAt: true },
    });
    if (!holding) return false;
    const openedOn = toMalawiDay(holding.createdAt, this.app.timezone);
    const today = toMalawiDay(at, this.app.timezone);
    return openedOn.getTime() < today.getTime();
  }

  /** Points must never break the thing that earned them. */
  private async safely(event: string, work: () => Promise<void>): Promise<void> {
    if (!this.app.pointsEnabled) return;
    try {
      await work();
    } catch (error) {
      this.logger.error({ err: error, event }, `Pine Points handler for ${event} failed`);
    }
  }
}
