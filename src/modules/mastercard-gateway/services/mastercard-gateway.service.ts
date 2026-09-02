import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import type {
  BankCardChargeParams,
  BankCardChargeResult,
  BankCardRefundResult,
  BankCardVerifyResult,
} from '../../payments/interfaces/bank-card-gateway.interface';
import { BankCardPaymentStatus } from '../../payments/dto/bank-card.dto';
import type {
  IMastercardGateway,
  McgsAuthorizeParams,
  McgsCaptureParams,
  McgsOperationResult,
  McgsPayRequest,
  McgsCaptureRequest,
  McgsRefundRequest,
  McgsTransactionResponse,
  McgsVerifyCardParams,
  McgsVoidParams,
  McgsVoidRequest,
  McgsSessionHandle,
  McgsSessionResponse,
  McgsChargeSessionParams,
  McgsChargeTokenParams,
  McgsCardToken,
  McgsTokenResponse,
  McgsDeviceDetails,
  McgsInitiateAuthParams,
  McgsAuthenticatePayerParams,
  McgsAuthInitResult,
  McgsAuthOutcome,
  McgsAuthResult,
  McgsAuthResponse,
} from '../interfaces/mastercard-gateway.interface';
import {
  MastercardGatewayException,
  MastercardGatewayNotConfiguredException,
  McgsGatewayCode,
} from '../exceptions/mastercard-gateway.exception';

/**
 * MastercardGatewayService
 *
 * Implements the Mastercard Gateway REST API (Direct Payment model).
 *
 * Integration guide: https://test-nbm.mtf.gateway.mastercard.com/api/documentation/
 *
 * ─── API contract ────────────────────────────────────────────────────────────
 * Base URL  : {MCGS_BASE_URL}/api/rest/version/{MCGS_API_VERSION}/merchant/{merchantId}
 * Auth      : HTTP Basic — username: `merchant.{merchantId}`, password: API password
 * PAY       : PUT .../order/{orderId}/transaction/{transactionId}  { apiOperation: "PAY", ... }
 * AUTHORIZE : PUT ...  { apiOperation: "AUTHORIZE", ... }
 * CAPTURE   : PUT ...  { apiOperation: "CAPTURE", ... }
 * REFUND    : PUT ...  { apiOperation: "REFUND", ... }
 * VOID      : PUT ...  { apiOperation: "VOID", ... }
 * VERIFY    : PUT ...  { apiOperation: "VERIFY", ... }
 * RETRIEVE  : GET .../order/{orderId}/transaction/{transactionId}
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─── ID convention ───────────────────────────────────────────────────────────
 * Pine txRef  →  Mastercard orderId  (1-to-1; max 40 chars)
 * Each operation on an order gets a deterministic transaction ID:
 *   PAY       : {txRef}-pay-1
 *   AUTHORIZE : {txRef}-auth-1
 *   CAPTURE   : {txRef}-cap-1
 *   REFUND    : {txRef}-ref-{n}   (n = timestamp suffix for uniqueness)
 *   VOID      : {txRef}-void-1
 *   VERIFY    : {txRef}-ver-1
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─── PCI-DSS notes ───────────────────────────────────────────────────────────
 * - Raw card data (PAN, CVV) is NEVER logged or persisted at any point.
 * - Only the masked PAN (last 4 digits) returned by the gateway is stored.
 * - All requests are made over TLS (enforced by the gateway's HTTPS endpoint).
 * - Consider migrating to Hosted Session for lower PCI scope when a frontend
 *   SDK is available (the JS SDK tokenises card data client-side before it
 *   reaches this server).
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class MastercardGatewayService implements IMastercardGateway, OnModuleInit {
  private readonly logger = new Logger(MastercardGatewayService.name);

  private merchantId: string;
  private apiPassword: string;
  private baseUrl: string;
  private apiVersion: number;
  private isConfigured: boolean = false;

  /** True once live MPGS credentials (merchantId + apiPassword) are configured. */
  get isLive(): boolean {
    return this.isConfigured;
  }

  constructor(private readonly config: AppConfigService) {}

  /**
   * Multi-broker support: build a gateway instance bound to a specific
   * broker's credentials (resolved server-side from the investor's broker
   * relationship + the broker's encrypted payment configuration). The
   * returned instance shares all request/parsing logic but authenticates
   * as THAT broker's merchant — investor deposits land directly in the
   * broker's configured account, never a central Pine account.
   */
  scopedTo(cfg: {
    merchantId: string;
    apiPassword: string;
    baseUrl: string;
    apiVersion: number;
  }): MastercardGatewayService {
    const scoped = new MastercardGatewayService(this.config);
    scoped.merchantId = cfg.merchantId;
    scoped.apiPassword = cfg.apiPassword;
    scoped.baseUrl = cfg.baseUrl;
    scoped.apiVersion = cfg.apiVersion;
    scoped.isConfigured = Boolean(cfg.merchantId && cfg.apiPassword);
    return scoped;
  }

  onModuleInit(): void {
    const mcgs = this.config.mastercardGateway;
    this.merchantId = mcgs.merchantId ?? '';
    this.apiPassword = mcgs.apiPassword ?? '';
    this.baseUrl = mcgs.baseUrl;
    this.apiVersion = mcgs.apiVersion;
    this.isConfigured = Boolean(this.merchantId && this.apiPassword);

    if (!this.isConfigured) {
      this.logger.warn(
        'MastercardGatewayService: MCGS_MERCHANT_ID or MCGS_API_PASSWORD is not set. ' +
          'All gateway calls will throw MastercardGatewayNotConfiguredException until credentials are provided.',
      );
    } else {
      this.logger.log(
        { merchantId: this.merchantId, baseUrl: this.baseUrl, apiVersion: this.apiVersion },
        'MastercardGatewayService initialised',
      );
    }
  }

  // ── IBankCardGateway ────────────────────────────────────────────────────────

  /**
   * Charge a card using a single PAY operation (authorize + capture in one step).
   * This is the standard flow for stock purchases and wallet top-ups.
   */
  async chargeCard(params: BankCardChargeParams): Promise<BankCardChargeResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(params.txRef);
    const transactionId = `${orderId}-pay-1`;

    this.logger.log(
      { orderId, transactionId, amount: params.amount, currency: params.currency },
      'Initiating PAY transaction',
    );

    const body: McgsPayRequest = {
      apiOperation: 'PAY',
      order: {
        amount: this.formatAmount(params.amount),
        currency: params.currency,
        description: `Pine payment — ${params.txRef}`,
      },
      transaction: {
        reference: params.txRef,
      },
      sourceOfFunds: {
        type: 'CARD',
        provided: {
          card: {
            number: params.cardNumber,
            expiry: {
              month: params.expiryMonth.padStart(2, '0'),
              year: this.normalizeYear(params.expiryYear),
            },
            securityCode: params.cvv,
            nameOnCard: params.cardholderName,
          },
        },
      },
      ...(params.email ? { customer: { email: params.email } } : {}),
    };

    const response = await this.putTransaction(orderId, transactionId, body);
    this.assertSuccess(response);

    const last4 = this.extractLast4(response);
    const cardBrand = response.sourceOfFunds?.provided?.card?.brand ?? 'UNKNOWN';

    return {
      processorReference: response.transaction?.id ?? transactionId,
      txRef: params.txRef,
      status: BankCardPaymentStatus.SUCCESS,
      amount: params.amount,
      currency: params.currency,
      last4,
      cardBrand,
      message:
        response.response?.gatewayCode ?? McgsGatewayCode.APPROVED,
      chargedAt: new Date().toISOString(),
    };
  }

  /**
   * Retrieve the current status of a PAY transaction by Pine txRef.
   */
  async verifyTransaction(txRef: string): Promise<BankCardVerifyResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(txRef);
    const transactionId = `${orderId}-pay-1`;

    const response = await this.getTransaction(orderId, transactionId);

    const status = this.mapResultToStatus(
      response.result,
      response.response?.gatewayCode,
    );

    return {
      processorReference: response.transaction?.id ?? transactionId,
      txRef,
      status,
      amount: response.transaction?.amount ?? 0,
      currency: response.transaction?.currency ?? '',
      updatedAt: new Date().toISOString(),
      failureReason:
        status === BankCardPaymentStatus.FAILED
          ? response.error?.explanation ?? response.response?.gatewayCode
          : undefined,
    };
  }

  /**
   * Refund a PAY transaction. Supports partial refunds.
   */
  async refundTransaction(
    txRef: string,
    amount?: number,
  ): Promise<BankCardRefundResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(txRef);
    // Each refund on an order gets a unique transaction ID
    const refundTransactionId = `${orderId}-ref-${Date.now()}`;

    this.logger.log(
      { orderId, refundTransactionId, amount },
      'Initiating REFUND transaction',
    );

    const body: McgsRefundRequest = {
      apiOperation: 'REFUND',
      transaction: {
        ...(amount !== undefined ? { amount: this.formatAmount(amount) } : {}),
      },
    };

    const response = await this.putTransaction(orderId, refundTransactionId, body);
    this.assertSuccess(response);

    const refundedAmount = response.transaction?.amount ?? amount ?? 0;
    const currency = response.transaction?.currency ?? '';

    return {
      refundReference: response.transaction?.id ?? refundTransactionId,
      originalTxRef: txRef,
      refundedAmount,
      currency,
      status: 'SUCCESS',
      initiatedAt: new Date().toISOString(),
    };
  }

  // ── IMastercardGateway (extended operations) ────────────────────────────────

  /**
   * Authorize-only — reserves funds without settling.
   * Call captureAuthorization() later to trigger the money movement.
   */
  async authorizeCard(params: McgsAuthorizeParams): Promise<McgsOperationResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(params.txRef);
    const transactionId = `${orderId}-auth-1`;

    this.logger.log(
      { orderId, transactionId, amount: params.amount, currency: params.currency },
      'Initiating AUTHORIZE transaction',
    );

    const body: McgsPayRequest = {
      apiOperation: 'AUTHORIZE',
      order: {
        amount: this.formatAmount(params.amount),
        currency: params.currency,
        description: params.description ?? `Pine authorize — ${params.txRef}`,
      },
      transaction: { reference: params.txRef },
      sourceOfFunds: {
        type: 'CARD',
        provided: {
          card: {
            number: params.cardNumber,
            expiry: {
              month: params.expiryMonth.padStart(2, '0'),
              year: this.normalizeYear(params.expiryYear),
            },
            securityCode: params.cvv,
            nameOnCard: params.cardholderName,
          },
        },
      },
      ...(params.email ? { customer: { email: params.email } } : {}),
    };

    const response = await this.putTransaction(orderId, transactionId, body);
    this.assertSuccess(response);

    return this.toOperationResult(orderId, transactionId, response);
  }

  /**
   * Capture a previously authorized amount.
   */
  async captureAuthorization(params: McgsCaptureParams): Promise<McgsOperationResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(params.orderId);
    const captureTransactionId = `${orderId}-cap-1`;

    this.logger.log(
      { orderId, captureTransactionId, amount: params.amount },
      'Initiating CAPTURE transaction',
    );

    const body: McgsCaptureRequest = {
      apiOperation: 'CAPTURE',
      transaction: {
        amount: this.formatAmount(params.amount),
        currency: params.currency,
      },
    };

    const response = await this.putTransaction(orderId, captureTransactionId, body);
    this.assertSuccess(response);

    return this.toOperationResult(orderId, captureTransactionId, response);
  }

  /**
   * Void an un-settled transaction.
   */
  async voidTransaction(params: McgsVoidParams): Promise<McgsOperationResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(params.orderId);
    const voidTransactionId = `${orderId}-void-1`;

    this.logger.log(
      { orderId, targetTransactionId: params.transactionId },
      'Initiating VOID transaction',
    );

    const body: McgsVoidRequest = {
      apiOperation: 'VOID',
      transaction: {
        targetTransactionId: params.transactionId,
      },
    };

    const response = await this.putTransaction(orderId, voidTransactionId, body);
    this.assertSuccess(response);

    return this.toOperationResult(orderId, voidTransactionId, response);
  }

  /**
   * Verify card details without charging.
   * Returns SUCCESS if the card is valid and the cardholder is authenticated.
   */
  async verifyCard(params: McgsVerifyCardParams): Promise<McgsOperationResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(params.txRef);
    const verifyTransactionId = `${orderId}-ver-1`;

    this.logger.log({ orderId }, 'Initiating VERIFY transaction');

    const body = {
      apiOperation: 'VERIFY' as const,
      order: {
        currency: params.currency ?? 'MWK',
      },
      sourceOfFunds: {
        type: 'CARD' as const,
        provided: {
          card: {
            number: params.cardNumber,
            expiry: {
              month: params.expiryMonth.padStart(2, '0'),
              year: this.normalizeYear(params.expiryYear),
            },
            securityCode: params.cvv,
            nameOnCard: params.cardholderName,
          },
        },
      },
    };

    const response = await this.putTransaction(orderId, verifyTransactionId, body);
    this.assertSuccess(response);

    return this.toOperationResult(orderId, verifyTransactionId, response);
  }

  /**
   * Check that the gateway is reachable and operational.
   * Calls the gateway's /information endpoint which returns {"status":"OPERATING"}.
   */
  async checkGatewayHealth(): Promise<{ status: 'OPERATING' | 'UNREACHABLE'; latencyMs: number }> {
    const url = `${this.baseUrl}/api/rest/version/${this.apiVersion}/information`;
    const start = Date.now();

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        return { status: 'UNREACHABLE', latencyMs };
      }

      const body = await res.json() as { status?: string };
      return {
        status: body.status === 'OPERATING' ? 'OPERATING' : 'UNREACHABLE',
        latencyMs,
      };
    } catch {
      return { status: 'UNREACHABLE', latencyMs: Date.now() - start };
    }
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  /**
   * PUT /api/rest/version/{v}/merchant/{mid}/order/{orderId}/transaction/{txnId}
   * Used for PAY, AUTHORIZE, CAPTURE, REFUND, VOID, VERIFY.
   */
  private async putTransaction(
    orderId: string,
    transactionId: string,
    body: object,
  ): Promise<McgsTransactionResponse> {
    const url = this.buildTransactionUrl(orderId, transactionId);

    let response: Response;
    let rawText: string;

    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      rawText = await response.text();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { orderId, transactionId, error: message },
        'Mastercard Gateway network error',
      );
      throw new MastercardGatewayException({
        gatewayResult: 'ERROR',
        gatewayCode: McgsGatewayCode.TIMED_OUT,
        errorCause: 'SERVER_FAILED',
        errorExplanation: `Network error reaching gateway: ${message}`,
      });
    }

    return this.parseAndValidateResponse(rawText, orderId, transactionId);
  }

  /**
   * GET /api/rest/version/{v}/merchant/{mid}/order/{orderId}/transaction/{txnId}
   * Used for RETRIEVE TRANSACTION.
   */
  private async getTransaction(
    orderId: string,
    transactionId: string,
  ): Promise<McgsTransactionResponse> {
    const url = this.buildTransactionUrl(orderId, transactionId);

    let response: Response;
    let rawText: string;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
      rawText = await response.text();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { orderId, transactionId, error: message },
        'Mastercard Gateway network error on RETRIEVE',
      );
      throw new MastercardGatewayException({
        gatewayResult: 'ERROR',
        gatewayCode: McgsGatewayCode.TIMED_OUT,
        errorCause: 'SERVER_FAILED',
        errorExplanation: `Network error: ${message}`,
      });
    }

    return this.parseAndValidateResponse(rawText, orderId, transactionId);
  }

  // ── 3-D Secure (EMV 3DS) ───────────────────────────────────────────────────
  //
  //   1. initiateAuthentication()  is this card enrolled?
  //   2. authenticatePayer()       frictionless, or a challenge to render
  //   3. (payer completes the challenge in a WebView)
  //   4. retrieveAuthentication()  VERIFY SERVER-SIDE — never trust the return
  //   5. chargeSession({ authenticationTransactionId })
  //
  // The authentication uses its own transaction id on the same order, which
  // the later PAY references.

  /** Deterministic id for the authentication leg of an order. */
  private authTransactionId(orderId: string): string {
    return `${orderId}-3ds-1`;
  }

  /**
   * INITIATE_AUTHENTICATION — asks the gateway which 3DS versions this card
   * supports. Safe to call before the amount is final.
   */
  async initiateAuthentication(
    params: McgsInitiateAuthParams,
  ): Promise<McgsAuthInitResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(params.txRef);
    const authTxnId = this.authTransactionId(orderId);

    const body = {
      apiOperation: 'INITIATE_AUTHENTICATION',
      order: { currency: params.currency },
      session: { id: params.sessionId },
      authentication: {
        channel: 'PAYER_BROWSER',
        purpose: 'PAYMENT_TRANSACTION',
      },
    };

    const response = (await this.putTransaction(
      orderId,
      authTxnId,
      body,
    )) as McgsAuthResponse;

    const version = response.authentication?.version ?? 'NONE';
    const recommendation = response.response?.gatewayRecommendation ?? 'PROCEED';
    const available =
      version !== 'NONE' &&
      response.transaction?.authenticationStatus === 'AUTHENTICATION_AVAILABLE';

    this.logger.log(
      { orderId, version, recommendation, available },
      '3DS enrolment checked',
    );

    return { version, available, recommendation, authTransactionId: authTxnId };
  }

  /**
   * AUTHENTICATE_PAYER — either the issuer approves silently (frictionless)
   * or it returns HTML that must be rendered so the payer can be challenged.
   */
  async authenticatePayer(
    params: McgsAuthenticatePayerParams,
  ): Promise<McgsAuthResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(params.txRef);
    const authTxnId = this.authTransactionId(orderId);
    const d = params.device ?? {};

    const body = {
      apiOperation: 'AUTHENTICATE_PAYER',
      order: {
        amount: this.formatAmount(params.amount),
        currency: params.currency,
      },
      session: { id: params.sessionId },
      authentication: { redirectResponseUrl: params.redirectResponseUrl },
      device: {
        ...(d.ipAddress ? { ipAddress: d.ipAddress } : {}),
        ...(d.browser ? { browser: d.browser } : {}),
        browserDetails: {
          '3DSecureChallengeWindowSize': 'FULL_SCREEN',
          acceptHeaders: d.acceptHeaders ?? 'application/json',
          colorDepth: d.colorDepth ?? 24,
          javaEnabled: false,
          language: d.language ?? 'en-GB',
          screenHeight: d.screenHeight ?? 900,
          screenWidth: d.screenWidth ?? 400,
          timeZone: d.timeZone ?? 0,
        },
      },
      ...(params.email ? { customer: { email: params.email } } : {}),
    };

    const response = (await this.putTransaction(
      orderId,
      authTxnId,
      body,
    )) as McgsAuthResponse;

    const status = response.transaction?.authenticationStatus;
    const recommendation = response.response?.gatewayRecommendation;
    const redirectHtml = response.authentication?.redirect?.html;

    let outcome: McgsAuthOutcome;
    if (recommendation === 'DO_NOT_PROCEED') {
      outcome = 'REJECTED';
    } else if (status === 'AUTHENTICATION_SUCCESSFUL') {
      outcome = 'FRICTIONLESS';
    } else if (redirectHtml) {
      outcome = 'CHALLENGE';
    } else if (status === 'AUTHENTICATION_NOT_SUPPORTED' || !status) {
      outcome = 'NOT_AVAILABLE';
    } else {
      // AUTHENTICATION_PENDING without HTML is unusable — treat as failure
      // rather than silently charging an unauthenticated card.
      outcome = 'REJECTED';
    }

    this.logger.log(
      { orderId, outcome, status, recommendation },
      '3DS payer authentication result',
    );

    return {
      outcome,
      authTransactionId: authTxnId,
      redirectHtml,
      status,
      recommendation,
    };
  }

  /**
   * Re-read the authentication straight from the gateway after a challenge.
   *
   * The payer's device reports the outcome too, but a device is not a source
   * of truth — this is the check that decides whether the card is charged.
   */
  async retrieveAuthentication(txRef: string): Promise<{
    authenticated: boolean;
    status?: string;
    recommendation?: string;
  }> {
    this.assertConfigured();

    const orderId = this.sanitizeId(txRef);
    const response = (await this.getTransaction(
      orderId,
      this.authTransactionId(orderId),
    )) as McgsAuthResponse;

    const status = response.transaction?.authenticationStatus;
    const recommendation = response.response?.gatewayRecommendation;

    return {
      authenticated:
        status === 'AUTHENTICATION_SUCCESSFUL' && recommendation !== 'DO_NOT_PROCEED',
      status,
      recommendation,
    };
  }

  // ── Hosted Session (PCI scope reduction) ───────────────────────────────────
  //
  // Flow:
  //   1. createSession()            server, authenticated  → session id
  //   2. app PUTs card to gateway   device → gateway       (Pine not involved)
  //   3. chargeSession()            server, authenticated  → PAY
  //   4. createTokenFromSession()   server, authenticated  → card-on-file token
  //
  // Card data never reaches Pine's servers, logs, or database in this flow.

  /**
   * CREATE SESSION — POST .../merchant/{mid}/session
   *
   * Returns everything the app needs to send card details straight to the
   * gateway. merchantId and the gateway host are NOT secrets (they appear in
   * every client-side integration); the API password never leaves this server.
   */
  async createSession(): Promise<McgsSessionHandle> {
    this.assertConfigured();

    const url =
      `${this.baseUrl}/api/rest/version/${this.apiVersion}` +
      `/merchant/${encodeURIComponent(this.merchantId)}/session`;

    const parsed = await this.requestJson<McgsSessionResponse>('POST', url, {}, 15_000);

    const sessionId = parsed.session?.id;
    if (!sessionId) {
      this.logger.error(
        { cause: parsed.error?.cause, explanation: parsed.error?.explanation },
        'CREATE SESSION returned no session id',
      );
      throw new MastercardGatewayException({
        gatewayResult: 'ERROR',
        gatewayCode: McgsGatewayCode.SYSTEM_ERROR,
        errorCause: parsed.error?.cause ?? 'SERVER_FAILED',
        errorExplanation:
          parsed.error?.explanation ?? 'Gateway did not return a payment session.',
      });
    }

    this.logger.log({ sessionId, merchantId: this.merchantId }, 'Payment session created');

    return {
      sessionId,
      // The session must be updated with the SAME version that created it.
      apiVersion: this.apiVersion,
      merchantId: this.merchantId,
      gatewayBaseUrl: this.baseUrl,
    };
  }

  /**
   * PAY using a session the app has already populated with card details.
   * Identical to chargeCard() except the card fields are replaced by a
   * session reference — Pine never holds the PAN.
   */
  async chargeSession(params: McgsChargeSessionParams): Promise<BankCardChargeResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(params.txRef);
    const transactionId = `${orderId}-pay-1`;

    this.logger.log(
      { orderId, transactionId, amount: params.amount, currency: params.currency },
      'Initiating PAY transaction (hosted session)',
    );

    const body = {
      apiOperation: 'PAY',
      order: {
        amount: this.formatAmount(params.amount),
        currency: params.currency,
        description: `Pine payment — ${params.txRef}`,
      },
      transaction: { reference: params.txRef },
      session: { id: params.sessionId },
      ...(params.authenticationTransactionId
        ? { authentication: { transactionId: params.authenticationTransactionId } }
        : {}),
      ...(params.email ? { customer: { email: params.email } } : {}),
    };

    const response = await this.putTransaction(orderId, transactionId, body);
    this.assertSuccess(response);

    return {
      processorReference: response.transaction?.id ?? transactionId,
      txRef: params.txRef,
      status: BankCardPaymentStatus.SUCCESS,
      amount: params.amount,
      currency: params.currency,
      last4: this.extractLast4(response),
      cardBrand: response.sourceOfFunds?.provided?.card?.brand ?? 'UNKNOWN',
      message: response.response?.gatewayCode ?? McgsGatewayCode.APPROVED,
      chargedAt: new Date().toISOString(),
    };
  }

  /**
   * CREATE TOKEN — POST .../merchant/{mid}/token
   *
   * Turns a session into a durable card-on-file token. Pine stores the token
   * (useless outside this merchant) instead of the card number.
   */
  async createTokenFromSession(sessionId: string): Promise<McgsCardToken> {
    this.assertConfigured();

    const url =
      `${this.baseUrl}/api/rest/version/${this.apiVersion}` +
      `/merchant/${encodeURIComponent(this.merchantId)}/token`;

    const parsed = await this.requestJson<McgsTokenResponse>(
      'POST',
      url,
      { session: { id: sessionId } },
      15_000,
    );

    const token = parsed.token;
    if (!token) {
      throw new MastercardGatewayException({
        gatewayResult: 'ERROR',
        gatewayCode: McgsGatewayCode.SYSTEM_ERROR,
        errorCause: parsed.error?.cause ?? 'SERVER_FAILED',
        errorExplanation:
          parsed.error?.explanation ?? 'Gateway did not return a card token.',
      });
    }

    const card = parsed.sourceOfFunds?.provided?.card;
    // The gateway returns a MASKED pan (e.g. 512345xxxxxx0008) — never the PAN.
    const masked = card?.number ?? '';
    const last4 = masked.slice(-4) || '0000';

    this.logger.log({ last4, brand: card?.brand }, 'Card tokenised (card-on-file)');

    return {
      token,
      last4,
      cardBrand: card?.brand ?? card?.scheme ?? 'UNKNOWN',
      expiryMonth: card?.expiry?.month ?? '',
      expiryYear: card?.expiry?.year ?? '',
    };
  }

  /** PAY using a stored card-on-file token (saved card). */
  async chargeToken(params: McgsChargeTokenParams): Promise<BankCardChargeResult> {
    this.assertConfigured();

    const orderId = this.sanitizeId(params.txRef);
    const transactionId = `${orderId}-pay-1`;

    this.logger.log(
      { orderId, transactionId, amount: params.amount },
      'Initiating PAY transaction (card-on-file token)',
    );

    const body = {
      apiOperation: 'PAY',
      order: {
        amount: this.formatAmount(params.amount),
        currency: params.currency,
        description: `Pine payment — ${params.txRef}`,
      },
      transaction: { reference: params.txRef },
      sourceOfFunds: {
        type: 'CARD',
        token: params.token,
        ...(params.securityCode
          ? { provided: { card: { securityCode: params.securityCode } } }
          : {}),
      },
      ...(params.email ? { customer: { email: params.email } } : {}),
    };

    const response = await this.putTransaction(orderId, transactionId, body);
    this.assertSuccess(response);

    return {
      processorReference: response.transaction?.id ?? transactionId,
      txRef: params.txRef,
      status: BankCardPaymentStatus.SUCCESS,
      amount: params.amount,
      currency: params.currency,
      last4: this.extractLast4(response),
      cardBrand: response.sourceOfFunds?.provided?.card?.brand ?? 'UNKNOWN',
      message: response.response?.gatewayCode ?? McgsGatewayCode.APPROVED,
      chargedAt: new Date().toISOString(),
    };
  }

  /**
   * Authenticated JSON call to a non-transaction gateway resource
   * (session, token). Network failures and non-JSON bodies are normalised
   * into MastercardGatewayException like the transaction path.
   */
  private async requestJson<T>(
    method: 'POST' | 'PUT' | 'GET',
    url: string,
    body: object | undefined,
    timeoutMs: number,
  ): Promise<T> {
    let rawText: string;
    try {
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      rawText = await response.text();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ url, error: message }, 'Mastercard Gateway network error');
      throw new MastercardGatewayException({
        gatewayResult: 'ERROR',
        gatewayCode: McgsGatewayCode.TIMED_OUT,
        errorCause: 'SERVER_FAILED',
        errorExplanation: `Network error reaching gateway: ${message}`,
      });
    }

    try {
      return JSON.parse(rawText) as T;
    } catch {
      this.logger.error(
        { url, bodyPreview: rawText.slice(0, 200) },
        'Mastercard Gateway returned a non-JSON response',
      );
      throw new MastercardGatewayException({
        gatewayResult: 'ERROR',
        gatewayCode: McgsGatewayCode.SYSTEM_ERROR,
        errorCause: 'SERVER_FAILED',
        errorExplanation: 'Gateway returned an unreadable response.',
      });
    }
  }

  // ── Internal utilities ──────────────────────────────────────────────────────

  private buildTransactionUrl(orderId: string, transactionId: string): string {
    return (
      `${this.baseUrl}/api/rest/version/${this.apiVersion}` +
      `/merchant/${encodeURIComponent(this.merchantId)}` +
      `/order/${encodeURIComponent(orderId)}` +
      `/transaction/${encodeURIComponent(transactionId)}`
    );
  }

  private buildHeaders(): Record<string, string> {
    const credentials = Buffer.from(
      `merchant.${this.merchantId}:${this.apiPassword}`,
    ).toString('base64');

    return {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  private parseAndValidateResponse(
    rawText: string,
    orderId: string,
    transactionId: string,
  ): McgsTransactionResponse {
    let parsed: McgsTransactionResponse;

    try {
      parsed = JSON.parse(rawText) as McgsTransactionResponse;
    } catch {
      this.logger.error(
        { orderId, transactionId, rawText: rawText.slice(0, 500) },
        'Mastercard Gateway returned non-JSON response',
      );
      throw new MastercardGatewayException({
        gatewayResult: 'ERROR',
        errorCause: 'SERVER_FAILED',
        errorExplanation: 'Gateway returned a non-JSON response',
      });
    }

    // Log at debug level — NEVER log sourceOfFunds (contains card data)
    this.logger.debug(
      {
        orderId,
        transactionId,
        result: parsed.result,
        gatewayCode: parsed.response?.gatewayCode,
      },
      'Mastercard Gateway response received',
    );

    return parsed;
  }

  /**
   * Throws MastercardGatewayException if the response is not SUCCESS.
   */
  private assertSuccess(response: McgsTransactionResponse): void {
    if (response.result !== 'SUCCESS') {
      this.logger.warn(
        {
          result: response.result,
          gatewayCode: response.response?.gatewayCode,
          errorCause: response.error?.cause,
          explanation: response.error?.explanation,
          supportCode: response.error?.supportCode,
        },
        'Mastercard Gateway transaction did not succeed',
      );

      throw new MastercardGatewayException({
        gatewayResult: response.result,
        gatewayCode: response.response?.gatewayCode,
        errorCause: response.error?.cause,
        errorExplanation: response.error?.explanation,
        supportCode: response.error?.supportCode,
      });
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new MastercardGatewayNotConfiguredException();
    }
  }

  /**
   * Format a numeric amount to a 2-decimal-place string as required by the gateway.
   * The gateway rejects amounts like "100" — it must be "100.00".
   */
  private formatAmount(amount: number): string {
    return amount.toFixed(2);
  }

  /**
   * Normalise expiry year to 2-digit format expected by the gateway ("YY").
   */
  private normalizeYear(year: string): string {
    if (year.length === 4) return year.slice(-2);
    return year;
  }

  /**
   * Extract the last 4 digits from the masked PAN returned by the gateway.
   * Masked format: "xxxxxxxxxxxxxxx1234"
   */
  private extractLast4(response: McgsTransactionResponse): string {
    const masked = response.sourceOfFunds?.provided?.card?.number ?? '';
    return masked.replace(/x/gi, '').slice(-4) || '0000';
  }

  /**
   * Map gateway result + gatewayCode to our internal BankCardPaymentStatus enum.
   */
  private mapResultToStatus(
    result: string,
    gatewayCode?: string,
  ): BankCardPaymentStatus {
    if (result === 'SUCCESS') return BankCardPaymentStatus.SUCCESS;
    if (result === 'PENDING') return BankCardPaymentStatus.PENDING;
    if (result === 'FAILURE') {
      // Determine if it's retriable
      if (
        gatewayCode === McgsGatewayCode.TIMED_OUT ||
        gatewayCode === McgsGatewayCode.ACQUIRER_SYSTEM_ERROR ||
        gatewayCode === McgsGatewayCode.SYSTEM_ERROR
      ) {
        return BankCardPaymentStatus.PENDING;
      }
      return BankCardPaymentStatus.FAILED;
    }
    return BankCardPaymentStatus.FAILED;
  }

  /**
   * Enforce the gateway's 40-char orderId limit.
   * Pine txRefs are formatted as "PINE-{uuid}" which can be 41 chars.
   * We hash-truncate if necessary.
   */
  private sanitizeId(id: string): string {
    if (id.length <= 40) return id;
    // Truncate from the right, keeping a recognisable prefix
    return id.slice(0, 40);
  }

  /**
   * Map a raw McgsTransactionResponse into the normalised McgsOperationResult.
   */
  private toOperationResult(
    orderId: string,
    transactionId: string,
    response: McgsTransactionResponse,
  ): McgsOperationResult {
    return {
      success: response.result === 'SUCCESS',
      orderId,
      transactionId: response.transaction?.id ?? transactionId,
      gatewayCode: response.response?.gatewayCode,
      authorizationCode: response.transaction?.authorizationCode,
      cardLast4: this.extractLast4(response),
      cardBrand: response.sourceOfFunds?.provided?.card?.brand,
      amount: response.transaction?.amount,
      currency: response.transaction?.currency,
      rawResponse: response,
    };
  }
}
