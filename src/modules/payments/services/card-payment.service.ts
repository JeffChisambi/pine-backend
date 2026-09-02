import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WalletService } from '../../wallet/services/wallet.service';
import { MastercardGatewayService } from '../../mastercard-gateway/services/mastercard-gateway.service';
import { MastercardGatewayException } from '../../mastercard-gateway/exceptions/mastercard-gateway.exception';
import { MockBankCardGatewayService } from './mock-bank-card.service';
import { SavedCardService } from './saved-card.service';
import {
  InitiateBankCardPaymentDto,
  BankCardPaymentResponse,
  BankCardPaymentStatus,
  CreateCardSessionDto,
  CardSessionResponse,
  CompleteCardSessionDto,
  SavedCardPaymentDto,
} from '../dto/bank-card.dto';
import { BrokerPaymentConfigService } from '../../brokers/services/broker-payment-config.service';
import { AppConfigService } from '../../../config/app-config.service';

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
    private readonly savedCardService: SavedCardService,
    private readonly brokerPaymentConfig: BrokerPaymentConfigService,
    private readonly appConfig: AppConfigService,
  ) {}

  async initiateCardPayment(
    user: { id: string; email?: string | null },
    dto: InitiateBankCardPaymentDto,
  ): Promise<BankCardPaymentResponse> {
    // If paying with a saved card, merge decrypted card details into the DTO.
    if (dto.savedCardId) {
      const saved = await this.savedCardService.getDecryptedCard(
        user.id,
        dto.savedCardId,
      );
      dto.cardNumber = saved.cardNumber;
      dto.cardholderName = saved.cardholderName;
      dto.expiryMonth = saved.expiryMonth;
      dto.expiryYear = saved.expiryYear;
    }

    this.validateCard(dto);

    // Production guard: Test Transaction mode is a client-controlled flag
    // that charges the MOCK gateway but credits a REAL wallet. It must be
    // unreachable outside development/test/staging environments — except
    // during pre-launch testing, when ALLOW_TEST_TRANSACTIONS=true opts in
    // explicitly (remove that env var at real launch).
    if (
      dto.testScenario &&
      this.appConfig.app.isProduction &&
      !this.appConfig.app.allowTestTransactions
    ) {
      throw new BadRequestException('Test transactions are not available.');
    }
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
      method: 'CARD',
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

    // 2) Resolve the gateway — ALWAYS from the investor's own broker's
    // payment configuration (Pine never intermediates through a central
    // account). Test mode uses the mock gateway but still requires a
    // valid broker relationship (enforced in initiateDeposit above).
    const gateway = testMode ? this.mockGateway : await this.brokerGatewayOrThrow(user.id);

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

      // Best-effort: save card for future use if requested (don't fail the payment).
      if (dto.saveCard && !dto.savedCardId) {
        try {
          await this.savedCardService.saveCard(user.id, {
            cardNumber: dto.cardNumber,
            cardholderName: dto.cardholderName,
            expiryMonth: dto.expiryMonth,
            expiryYear: dto.expiryYear,
          });
        } catch (saveErr) {
          this.logger.warn(
            { txRef, userId: user.id, error: (saveErr as Error).message },
            'Failed to save card after successful payment (non-fatal)',
          );
        }
      }

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

  // ── Hosted Session deposits (card data never reaches Pine) ────────────────
  //
  //   1. POST /payments/card/session          → PENDING deposit + gateway session
  //   2. app PUTs the card straight to the gateway using the session id
  //   3. POST /payments/card/session/complete → PAY, credit wallet, tokenise
  //
  // Integrity: the amount charged is read from the PENDING deposit created in
  // step 1, never from the step 3 request body, so a client cannot alter what
  // it pays between collecting the card and capturing the money.

  /**
   * Step 1 — create the deposit and a gateway payment session for it.
   *
   * Returns the session handle the app needs to send card details directly to
   * the gateway. `merchantId` and `gatewayBaseUrl` are not secrets: they are
   * required by every client-side integration. The API password never leaves
   * this server.
   */
  async createPaymentSession(
    user: { id: string; email?: string | null },
    dto: CreateCardSessionDto,
  ): Promise<CardSessionResponse> {
    // Resolve the broker's gateway FIRST so an unconfigured broker fails
    // before we create a deposit row (503 with a clear reason).
    const { gateway } = await this.resolveBrokerGateway(user.id);

    const txRef = dto.idempotencyKey
      ? `PINE-CARD-${this.sanitizeKey(dto.idempotencyKey)}`
      : `PINE-CARD-${randomUUID()}`;
    const purpose = dto.purpose ?? 'wallet_deposit';

    this.logger.log(
      { userId: user.id, txRef, amount: dto.amount, currency: dto.currency, purpose },
      'Creating hosted payment session',
    );

    // Creates or replays the PENDING deposit. This is where the deposit fee,
    // the broker's risk limits and the broker relationship are all enforced.
    const { transactionId, status } = await this.walletService.initiateDeposit({
      userId: user.id,
      amount: dto.amount,
      idempotencyKey: txRef,
      method: 'CARD',
      metadata: {
        purpose,
        method: 'BANK_CARD',
        integration: 'HOSTED_SESSION',
        currency: dto.currency,
        ...(dto.stockSymbol ? { stockSymbol: dto.stockSymbol, quantity: dto.quantity } : {}),
      },
    });

    if (status === 'COMPLETED') {
      throw new BadRequestException(
        'This payment has already been completed. Start a new deposit.',
      );
    }
    if (status === 'FAILED') {
      throw new BadRequestException(
        'This payment reference previously failed. Start a new deposit.',
      );
    }

    // A fresh session per attempt: sessions are single-use and short-lived,
    // so a retry of the same deposit must not reuse a spent one.
    const session = await gateway.createSession();
    await this.walletService.attachDepositMetadata(txRef, {
      gatewaySessionId: session.sessionId,
      currency: dto.currency,
    });

    return {
      txRef,
      transactionId,
      sessionId: session.sessionId,
      apiVersion: session.apiVersion,
      merchantId: session.merchantId,
      gatewayBaseUrl: session.gatewayBaseUrl,
      amount: dto.amount,
      currency: dto.currency,
    };
  }

  /**
   * Step 3 — capture the payment for a session the app has populated.
   * The amount comes from the stored deposit; the request supplies only the
   * reference and whether to remember the card.
   */
  async completeSessionPayment(
    user: { id: string; email?: string | null },
    dto: CompleteCardSessionDto,
  ): Promise<BankCardPaymentResponse> {
    const deposit = await this.walletService.getDepositForUser(user.id, dto.txRef);
    if (!deposit) {
      throw new NotFoundException('Payment not found.');
    }

    const meta = (deposit.metadata ?? {}) as Record<string, any>;
    const currency = (meta.currency as 'MWK' | 'USD') ?? 'MWK';
    // GROSS is what the payer is charged; the wallet is credited NET of the
    // deposit fee by the standard pipeline.
    const grossAmount = Number(meta.grossAmount ?? deposit.amount);

    // Idempotent replays: never charge twice.
    if (deposit.status === 'COMPLETED') {
      return {
        txRef: dto.txRef,
        transactionId: deposit.id,
        status: BankCardPaymentStatus.SUCCESS,
        amount: grossAmount,
        currency,
        message: 'Payment already processed — charged exactly once.',
      };
    }
    if (deposit.status === 'FAILED') {
      return {
        txRef: dto.txRef,
        transactionId: deposit.id,
        status: BankCardPaymentStatus.FAILED,
        amount: grossAmount,
        currency,
        message: 'This payment previously failed. Start a new deposit.',
      };
    }

    const sessionId = meta.gatewaySessionId as string | undefined;
    if (!sessionId) {
      throw new BadRequestException(
        'This payment has no active card session. Start the deposit again.',
      );
    }

    const { gateway, brokerId } = await this.resolveBrokerGateway(user.id);

    try {
      const charge = await gateway.chargeSession({
        txRef: dto.txRef,
        amount: grossAmount,
        currency,
        sessionId,
        email: user.email ?? undefined,
      });

      // Credit the wallet through the standard atomic, idempotent pipeline
      // (also submits the buy order when purpose = BUY_SHARES).
      await this.walletService.processPaymentByTxRef(dto.txRef);

      // Remembering the card is best effort — never fail a settled payment.
      if (dto.saveCard) {
        try {
          const token = await gateway.createTokenFromSession(sessionId);
          await this.savedCardService.saveTokenizedCard(user.id, brokerId, {
            token: token.token,
            last4: token.last4 || charge.last4,
            cardBrand: token.cardBrand || charge.cardBrand || 'UNKNOWN',
            cardholderName: dto.cardholderName?.trim() || 'Cardholder',
            expiryMonth: token.expiryMonth,
            expiryYear: token.expiryYear,
          });
        } catch (saveErr) {
          this.logger.warn(
            { txRef: dto.txRef, userId: user.id, error: (saveErr as Error).message },
            'Card tokenisation failed after a successful payment (non-fatal)',
          );
        }
      }

      this.logger.log(
        { txRef: dto.txRef, userId: user.id, amount: grossAmount, last4: charge.last4 },
        'Hosted session payment completed and wallet credited',
      );

      return {
        txRef: dto.txRef,
        transactionId: deposit.id,
        status: BankCardPaymentStatus.SUCCESS,
        amount: grossAmount,
        currency,
        message: charge.message,
        processorReference: charge.processorReference,
        last4: charge.last4,
        cardBrand: charge.cardBrand,
      };
    } catch (error) {
      const { userMessage, code } = this.describeFailure(error);
      await this.walletService
        .markDepositFailed(dto.txRef, `${code}: ${userMessage}`)
        .catch(() => {});

      this.logger.warn(
        { txRef: dto.txRef, userId: user.id, code },
        'Hosted session payment failed',
      );

      return {
        txRef: dto.txRef,
        transactionId: deposit.id,
        status: BankCardPaymentStatus.FAILED,
        amount: grossAmount,
        currency,
        message: userMessage,
      };
    }
  }

  /**
   * Deposit with a previously saved card, charged by its card-on-file token.
   * No card data is involved on any leg of this call.
   */
  async payWithSavedCard(
    user: { id: string; email?: string | null },
    dto: SavedCardPaymentDto,
  ): Promise<BankCardPaymentResponse> {
    const { gateway, brokerId } = await this.resolveBrokerGateway(user.id);
    const card = await this.savedCardService.getChargeableToken(
      user.id,
      dto.savedCardId,
      brokerId,
    );

    const txRef = dto.idempotencyKey
      ? `PINE-CARD-${this.sanitizeKey(dto.idempotencyKey)}`
      : `PINE-CARD-${randomUUID()}`;
    const purpose = dto.purpose ?? 'wallet_deposit';

    const { transactionId, status } = await this.walletService.initiateDeposit({
      userId: user.id,
      amount: dto.amount,
      idempotencyKey: txRef,
      method: 'CARD',
      metadata: {
        purpose,
        method: 'BANK_CARD',
        integration: 'CARD_ON_FILE',
        currency: dto.currency,
        ...(dto.stockSymbol ? { stockSymbol: dto.stockSymbol, quantity: dto.quantity } : {}),
      },
    });

    if (status === 'COMPLETED') {
      return {
        txRef, transactionId, status: BankCardPaymentStatus.SUCCESS,
        amount: dto.amount, currency: dto.currency,
        message: 'Payment already processed — charged exactly once.',
      };
    }
    if (status === 'FAILED') {
      return {
        txRef, transactionId, status: BankCardPaymentStatus.FAILED,
        amount: dto.amount, currency: dto.currency,
        message: 'This payment reference previously failed. Start a new payment.',
      };
    }

    try {
      const charge = await gateway.chargeToken({
        txRef,
        amount: dto.amount,
        currency: dto.currency,
        token: card.token,
        securityCode: dto.cvv,
        email: user.email ?? undefined,
      });

      await this.walletService.processPaymentByTxRef(txRef);

      this.logger.log(
        { txRef, userId: user.id, amount: dto.amount, last4: card.last4 },
        'Card-on-file payment completed and wallet credited',
      );

      return {
        txRef,
        transactionId,
        status: BankCardPaymentStatus.SUCCESS,
        amount: dto.amount,
        currency: dto.currency,
        message: charge.message,
        processorReference: charge.processorReference,
        last4: charge.last4 || card.last4,
        cardBrand: charge.cardBrand || card.cardBrand,
      };
    } catch (error) {
      const { userMessage, code } = this.describeFailure(error);
      await this.walletService.markDepositFailed(txRef, `${code}: ${userMessage}`).catch(() => {});

      this.logger.warn({ txRef, userId: user.id, code }, 'Card-on-file payment failed');

      return {
        txRef,
        transactionId,
        status: BankCardPaymentStatus.FAILED,
        amount: dto.amount,
        currency: dto.currency,
        message: userMessage,
        last4: card.last4,
      };
    }
  }

  /**
   * Gateway bound to the investor's own broker's merchant credentials,
   * together with that broker's id (needed to scope card-on-file tokens,
   * which are only chargeable through the merchant that created them).
   */
  private async resolveBrokerGateway(
    userId: string,
  ): Promise<{ gateway: MastercardGatewayService; brokerId: string }> {
    const cfg = await this.brokerPaymentConfig.resolveGatewayConfigForUser(userId);
    const gateway = this.mpgs.scopedTo({
      merchantId: cfg.merchantId,
      apiPassword: cfg.apiPassword,
      baseUrl: cfg.baseUrl,
      apiVersion: cfg.apiVersion,
    });
    if (!gateway.isLive) {
      throw new ServiceUnavailableException(
        'Card payments are not yet enabled for your broker.',
      );
    }
    return { gateway, brokerId: cfg.brokerId };
  }

  /** Status poll — the wallet transaction row is the source of truth. */
  async verifyCardPayment(userId: string, txRef: string) {
    const status = await this.walletService.getDepositStatusByTxRef(userId, txRef);
    return { txRef, ...status };
  }

  /* ── helpers ── */

  /**
   * Build a gateway instance authenticated with the investor's broker's
   * own merchant credentials. The broker is derived server-side from the
   * authenticated user's persisted relationship; decrypted credentials
   * exist only in memory for the duration of the charge.
   */
  private async brokerGatewayOrThrow(userId: string): Promise<MastercardGatewayService> {
    const cfg = await this.brokerPaymentConfig.resolveGatewayConfigForUser(userId);
    const gateway = this.mpgs.scopedTo({
      merchantId: cfg.merchantId,
      apiPassword: cfg.apiPassword,
      baseUrl: cfg.baseUrl,
      apiVersion: cfg.apiVersion,
    });
    if (!gateway.isLive) {
      throw new ServiceUnavailableException(
        'Card payments are not yet enabled for your broker. Use Test Transaction mode, or contact support.',
      );
    }
    return gateway;
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
