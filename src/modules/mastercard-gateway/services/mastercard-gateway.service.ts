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

  constructor(private readonly config: AppConfigService) {}

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
