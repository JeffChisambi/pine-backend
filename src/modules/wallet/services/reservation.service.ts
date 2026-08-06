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
   *
   * Runs check-and-reserve in a single SERIALIZABLE transaction so two
   * concurrent orders cannot both pass the availability check and
   * collectively overdraw the wallet. Idempotent per order: an existing
   * ACTIVE reservation for the same order is returned unchanged.
   */
  async reserveFunds(params: {
    userId: string;
    orderId: string;
    amount: number;
    expiresInMinutes?: number;
  }): Promise<string> {
    const amountDecimal = new Decimal(params.amount);
    const expiresAt = params.expiresInMinutes
      ? new Date(Date.now() + params.expiresInMinutes * 60_000)
      : new Date(Date.now() + 24 * 60 * 60_000); // Default 24h

    const reservationId = await this.repo.prismaClient.$transaction(
      async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { userId: params.userId } });
        if (!wallet) {
          throw new NotFoundException('Wallet not found');
        }
        if (wallet.isFrozen) {
          throw new BadRequestException('Wallet is frozen');
        }

        // Idempotency: one ACTIVE reservation per order, ever.
        const existing = await tx.walletReservation.findFirst({
          where: { orderId: params.orderId, status: 'ACTIVE' },
          select: { id: true },
        });
        if (existing) return existing.id;

        const reservedAgg = await tx.walletReservation.aggregate({
          where: { walletId: wallet.id, status: 'ACTIVE' },
          _sum: { amount: true },
        });
        const available = wallet.balance.sub(reservedAgg._sum.amount ?? new Decimal(0));

        if (available.lt(amountDecimal)) {
          throw new BadRequestException(
            `Insufficient available funds. Available: MWK ${available.toNumber().toLocaleString()}, ` +
            `Required: MWK ${params.amount.toLocaleString()}`,
          );
        }

        const reservation = await tx.walletReservation.create({
          data: {
            walletId: wallet.id,
            orderId: params.orderId,
            amount: amountDecimal,
            status: 'ACTIVE',
            reason: `Order ${params.orderId}`,
            expiresAt,
          },
        });
        return reservation.id;
      },
      { isolationLevel: 'Serializable' as any, maxWait: 5_000, timeout: 10_000 },
    );

    this.logger.log(
      { userId: params.userId, orderId: params.orderId, amount: params.amount },
      'Funds reserved',
    );

    return reservationId;
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

  /** Order cancelled → refund the hold to available balance */
  @OnEvent('trading.order.cancelled')
  async onOrderCancelled(event: { orderId: string }) {
    await this.releaseReservation(event.orderId);
  }

  /** Order rejected (validation failure, broker reject) → refund the hold */
  @OnEvent('trading.order.rejected')
  async onOrderRejected(event: { orderId: string }) {
    await this.releaseReservation(event.orderId);
  }

  // NOTE: consumption on settlement happens INSIDE the trading module's
  // atomic settlement transaction (same commit as the cash debit), not via
  // an event handler — the two can never diverge.

  // ── Cron: expire stale reservations ─────────────────────────

  @Cron('*/15 * * * *', { name: 'expire-reservations' })
  async expireStaleReservations(): Promise<void> {
    const result = await this.repo.expireReservations();
    if (result.count > 0) {
      this.logger.log({ count: result.count }, 'Expired stale reservations');
    }
  }
}
