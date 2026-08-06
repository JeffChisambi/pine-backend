import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WalletService } from '../../wallet/services/wallet.service';
import { MastercardGatewayService } from '../../mastercard-gateway/services/mastercard-gateway.service';
import { MastercardGatewayException } from '../../mastercard-gateway/exceptions/mastercard-gateway.exception';
import { MockBankCardGatewayService } from './mock-bank-card.service';
import { InitiateBankCardPaymentDto, BankCardPaymentResponse, BankCardPaymentStatus } from '../dto/bank-card.dto';

/**
 * CardPaymentService — orchestrates the bank card deposit lifecycle.
 *
 *   1. Create (or replay) the PENDING wallet deposit keyed by a unique txRef
 *   2. Charge the card through the resolved gateway
 *   3. SUCCESS  → credit the wallet atomically (processPaymentByTxRef)
 *      FAILURE → mark the deposit FAILED with a user-safe reason
 *
 * Gateway resolution (business logic never changes when going live):
 *   - `testScenario` present            → mock gateway (Test Transaction mode)
 *   - MPGS credentials configured       → live Mastercard gateway
 *   - otherwise                         → 503 with a clear message
 *
 * Guarantees:
 *   - Idempotent: a client-supplied idempotencyKey maps to exactly one
 *     deposit; replays return the current state and never re-charge.
 *   - Unique transaction reference per payment (PINE-CARD-…).
 *   - PCI discipline: card number / CVV / expiry are passed through to the
 *     gateway and never logged, stored, or echoed back (only brand + last4).
 */
@Injectable()
export class CardPaymentService {
  private readonly logger = new Logger(CardPaymentService.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly mpgs: MastercardGatewayService,
    private readonly mockGateway: MockBankCardGatewayService,
  ) {}

  async initiateCardPayment(
    user: { id: string; email?: string | null },
    dto: InitiateBankCardPaymentDto,
  ): Promise<BankCardPaymentResponse> {
    this.validateCard(dto);

    const testMode = !!dto.testScenario;
    const txRef = dto.idempotencyKey
      ? `PINE-CARD-${this.sanitizeKey(dto.idempotencyKey)}`
      : `PINE-CARD-${randomUUID()}`;
    const purpose = dto.purpose ?? 'wallet_deposit';

    // Log only non-sensitive facts. NEVER card number, CVV, or expiry.
    this.logger.log(
      { userId: user.id, txRef, amount: dto.amount, currency: dto.currency, purpose, testMode },
      'Initiating bank card payment',
    );

    // 1) Create or replay the deposit (idempotent on txRef).
    const { transactionId, status: existingStatus } = await this.walletService.initiateDeposit({
      userId: user.id,
      amount: dto.amount,
      idempotencyKey: txRef,
      metadata: {
        purpose,
        method: 'BANK_CARD',
        testMode,
        ...(dto.stockSymbol ? { stockSymbol: dto.stockSymbol, quantity: dto.quantity } : {}),
      },
    });

    // Replay of an already-processed payment: report state, never re-charge.
    if (existingStatus === 'COMPLETED') {
      return this.response(txRef, transactionId, 'SUCCESS', dto, 'Payment already processed — charged exactly once.');
    }
    if (existingStatus === 'FAILED') {
      return this.response(txRef, transactionId, 'FAILED', dto, 'This payment reference previously failed. Start a new payment.');
    }

    // 2) Resolve the gateway.
    const gateway = testMode ? this.mockGateway : this.liveGatewayOrThrow();

    try {
      const charge = await gateway.chargeCard({
        txRef,
        amount: dto.amount,
        currency: dto.currency,
        cardholderName: dto.cardholderName,
        cardNumber: dto.cardNumber,
        expiryMonth: dto.expiryMonth,
        expiryYear: dto.expiryYear,
        cvv: dto.cvv,
        email: user.email ?? undefined,
        meta: {
          userId: user.id,
          transactionId,
          purpose,
          ...(testMode ? { testScenario: dto.testScenario } : {}),
        },
      });

      // 3) Credit the wallet through the standard, atomic, idempotent
      // deposit pipeline (also handles purpose=BUY_SHARES order submission).
      await this.walletService.processPaymentByTxRef(txRef);

      this.logger.log(
        { txRef, userId: user.id, amount: dto.amount, last4: charge.last4, brand: charge.cardBrand, testMode },
        'Card payment completed and wallet credited',
      );

      return {
        txRef,
        transactionId,
        status: BankCardPaymentStatus.SUCCESS,
        amount: dto.amount,
        currency: dto.currency,
        message: charge.message,
        processorReference: charge.processorReference,
        last4: charge.last4,
        cardBrand: charge.cardBrand,
      };
    } catch (error) {
      const { userMessage, code } = this.describeFailure(error);

      // Record the failure against the deposit so history/receipts are honest.
      await this.walletService.markDepositFailed(txRef, `${code}: ${userMessage}`).catch(() => {});

      this.logger.warn(
        { txRef, userId: user.id, code, testMode },
        'Card payment failed',
      );

      return {
        txRef,
        transactionId,
        status: BankCardPaymentStatus.FAILED,
        amount: dto.amount,
        currency: dto.currency,
        message: userMessage,
        last4: dto.cardNumber.slice(-4),
        cardBrand: undefined,
        processorReference: undefined,
      };
    }
  }

  /** Status poll — the wallet transaction row is the source of truth. */
  async verifyCardPayment(userId: string, txRef: string) {
    const status = await this.walletService.getDepositStatusByTxRef(userId, txRef);
    return { txRef, ...status };
  }

  /* ── helpers ── */

  private liveGatewayOrThrow(): MastercardGatewayService {
    if (!this.mpgs.isLive) {
      throw new ServiceUnavailableException(
        'Card payments are not yet enabled on this environment. Use Test Transaction mode, or contact support.',
      );
    }
    return this.mpgs;
  }

  /**
   * Server-side card validation (defence in depth behind the DTO regexes).
   * Rejects obviously invalid input BEFORE any gateway round-trip.
   */
  private validateCard(dto: InitiateBankCardPaymentDto): void {
    if (!this.luhnValid(dto.cardNumber)) {
      throw new BadRequestException('Card number is invalid.');
    }
    const year = dto.expiryYear.length === 2 ? 2000 + Number(dto.expiryYear) : Number(dto.expiryYear);
    const month = Number(dto.expiryMonth);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59);
    if (endOfMonth.getTime() < Date.now()) {
      throw new BadRequestException('Card has expired.');
    }
  }

  private luhnValid(num: string): boolean {
    let sum = 0;
    let dbl = false;
    for (let i = num.length - 1; i >= 0; i--) {
      let d = num.charCodeAt(i) - 48;
      if (d < 0 || d > 9) return false;
      if (dbl) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  private sanitizeKey(key: string): string {
    return key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  }

  /** Map any gateway failure to a user-safe message + stable code. */
  private describeFailure(error: unknown): { userMessage: string; code: string } {
    if (error instanceof MastercardGatewayException) {
      const code = error.gatewayCode ?? error.gatewayResult;
      const messages: Record<string, string> = {
        DECLINED: 'Your card was declined by the issuing bank. Please try another card.',
        INSUFFICIENT_FUNDS: 'The card has insufficient funds for this payment.',
        EXPIRED_CARD: 'The card has expired. Please use a different card.',
        TIMED_OUT: 'The payment gateway did not respond in time. You have not been charged — please try again.',
      };
      return { userMessage: messages[code] ?? error.message, code };
    }
    if ((error as any)?.code === 'ECONNRESET' || (error as any)?.code === 'ETIMEDOUT') {
      return {
        userMessage: 'A network error interrupted the payment. You have not been charged — please try again.',
        code: 'NETWORK_ERROR',
      };
    }
    return { userMessage: 'Payment could not be completed. Please try again.', code: 'UNKNOWN' };
  }

  private response(
    txRef: string,
    transactionId: string,
    status: 'SUCCESS' | 'FAILED',
    dto: InitiateBankCardPaymentDto,
    message: string,
  ): BankCardPaymentResponse {
    return {
      txRef,
      transactionId,
      status: status === 'SUCCESS' ? BankCardPaymentStatus.SUCCESS : BankCardPaymentStatus.FAILED,
      amount: dto.amount,
      currency: dto.currency,
      message,
      last4: dto.cardNumber.slice(-4),
    };
  }
}
