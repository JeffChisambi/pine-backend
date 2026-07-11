import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { Decimal } from '@prisma/client/runtime/library';
import { WalletRepository } from '../repositories/wallet.repository';

/**
 * Reservation Service — fund holds for pending orders.
 *
 * When a user submits a buy order:
 *   Available: 100,000  →  Available: 20,000
 *   Reserved:       0   →  Reserved:  80,000
 *
 * The money isn't gone. It's reserved until:
 *   - Order executes (CONSUMED)
 *   - Order fails/expires (RELEASED)
 *   - User cancels (RELEASED)
 *
 * Banks do this all the time.
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(private readonly repo: WalletRepository) {}

  /**
   * Reserve funds for a pending order.
   */
  async reserveFunds(params: {
    userId: string;
    orderId: string;
    amount: number;
    expiresInMinutes?: number;
  }): Promise<string> {
    const wallet = await this.repo.findWalletByUserId(params.userId);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    if (wallet.isFrozen) {
      throw new BadRequestException('Wallet is frozen');
    }

    const amountDecimal = new Decimal(params.amount);
    const reserved = await this.repo.sumActiveReservations(wallet.id);
    const available = wallet.balance.sub(reserved);

    if (available.lt(amountDecimal)) {
      throw new BadRequestException(
        `Insufficient available funds. Available: ${available.toNumber()}, Required: ${params.amount}`,
      );
    }

    const expiresAt = params.expiresInMinutes
      ? new Date(Date.now() + params.expiresInMinutes * 60_000)
      : new Date(Date.now() + 24 * 60 * 60_000); // Default 24h

    const reservation = await this.repo.createReservation({
      walletId: wallet.id,
      orderId: params.orderId,
      amount: amountDecimal,
      reason: `Order ${params.orderId}`,
      expiresAt,
    });

    this.logger.log(
      { userId: params.userId, orderId: params.orderId, amount: params.amount },
      'Funds reserved',
    );

    return reservation.id;
  }

  /**
   * Consume a reservation (order was filled).
   */
  async consumeReservation(orderId: string): Promise<void> {
    const reservation = await this.repo.findReservationByOrderId(orderId);
    if (!reservation) {
      this.logger.warn({ orderId }, 'No active reservation found for order');
      return;
    }

    await this.repo.consumeReservation(reservation.id);
    this.logger.log({ orderId, amount: reservation.amount.toString() }, 'Reservation consumed');
  }

  /**
   * Release a reservation (order cancelled/failed).
   */
  async releaseReservation(orderId: string): Promise<void> {
    const reservation = await this.repo.findReservationByOrderId(orderId);
    if (!reservation) {
      this.logger.warn({ orderId }, 'No active reservation found for order');
      return;
    }

    await this.repo.releaseReservation(reservation.id);
    this.logger.log({ orderId, amount: reservation.amount.toString() }, 'Reservation released');
  }

  /**
   * Get all active reservations for a user.
   */
  async getActiveReservations(userId: string) {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) return { reservations: [], totalReserved: 0 };

    const reservations = await this.repo.findActiveReservations(wallet.id);
    const total = reservations.reduce(
      (sum, r) => sum.add(r.amount),
      new Decimal(0),
    );

    return {
      reservations: reservations.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        amount: r.amount.toNumber(),
        currency: r.currency,
        status: r.status,
        reason: r.reason,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      })),
      totalReserved: total.toNumber(),
    };
  }

  // ── Event Handlers ──────────────────────────────────────────

  /** Order cancelled → release reservation */
  @OnEvent('trading.order.cancelled')
  async onOrderCancelled(event: { orderId: string }) {
    await this.releaseReservation(event.orderId);
  }

  /** Trade settled → consume reservation */
  @OnEvent('trading.trade.settled')
  async onTradeSettled(event: { orderId: string }) {
    await this.consumeReservation(event.orderId);
  }

  // ── Cron: expire stale reservations ─────────────────────────

  @Cron('*/15 * * * *', { name: 'expire-reservations' })
  async expireStaleReservations(): Promise<void> {
    const result = await this.repo.expireReservations();
    if (result.count > 0) {
      this.logger.log({ count: result.count }, 'Expired stale reservations');
    }
  }
}
