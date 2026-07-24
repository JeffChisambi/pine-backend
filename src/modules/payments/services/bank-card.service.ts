import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import {
  BankCardChargeParams,
  BankCardChargeResult,
  BankCardRefundResult,
  BankCardVerifyResult,
  IBankCardGateway,
} from '../interfaces/bank-card-gateway.interface';
import { BankCardPaymentStatus } from '../dto/bank-card.dto';

/**
 * BankCardService — skeleton implementation of IBankCardGateway.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  INTEGRATION TODO                                                │
 * │                                                                  │
 * │  Choose a card processor and fill in the three methods below:   │
 * │                                                                  │
 * │  Popular options for Malawi / Africa:                            │
 * │    • Flutterwave  (https://developer.flutterwave.com)            │
 * │    • Paystack     (https://paystack.com/docs)                    │
 * │    • Stripe       (https://stripe.com/docs)                      │
 * │    • PayChangu    (already integrated via PaychanguService)       │
 * │                                                                  │
 * │  Required env vars (add to .env / config):                       │
 * │    BANK_CARD_PROCESSOR_BASE_URL                                  │
 * │    BANK_CARD_PROCESSOR_SECRET_KEY                                │
 * │    BANK_CARD_PROCESSOR_PUBLIC_KEY                                │
 * │    BANK_CARD_ENCRYPTION_KEY   (for card data encryption)         │
 * │                                                                  │
 * │  PCI-DSS note:                                                   │
 * │    Never log or persist raw card numbers or CVVs.                │
 * │    Consider using the processor's JS SDK to tokenise on the      │
 * │    client before the token reaches this server.                  │
 * └──────────────────────────────────────────────────────────────────┘
 */
@Injectable()
export class BankCardService implements IBankCardGateway {
  private readonly logger = new Logger(BankCardService.name);

  // TODO: replace with the chosen processor's base URL from config
  // private readonly baseUrl: string;
  // private readonly secretKey: string;
  // private readonly publicKey: string;

  constructor(
    private readonly config: AppConfigService,
  ) {
    // TODO: pull processor credentials from config once added
    // this.baseUrl    = config.bankCard.baseUrl;
    // this.secretKey  = config.bankCard.secretKey;
    // this.publicKey  = config.bankCard.publicKey;
  }

  // ── chargeCard ──────────────────────────────────────────────────────────────

  /**
   * Charge a bank card.
   *
   * TODO: Implement using chosen processor SDK / REST API.
   *
   * Typical flow (Flutterwave example):
   *   1. Encrypt card payload with processor public key
   *   2. POST /v3/charges?type=card  with encrypted payload + headers
   *   3. Handle auth mode: 'pin' | 'avs_noauth' | 'redirect' | 'otp'
   *   4. If auth_mode === 'otp' → prompt user for OTP via mobile
   *   5. POST /v3/validate-charge  with OTP
   *   6. Return BankCardChargeResult
   */
  async chargeCard(params: BankCardChargeParams): Promise<BankCardChargeResult> {
    this.logger.warn(
      { txRef: params.txRef, amount: params.amount, currency: params.currency },
      '[BankCardService] chargeCard — NOT YET IMPLEMENTED. Returning stub.',
    );

    // TODO: Remove this stub and replace with real processor call
    throw new NotImplementedException(
      'Bank card payment processing is not yet configured. ' +
      'Please wire up a card processor in BankCardService.chargeCard().',
    );

    /*
     * ── IMPLEMENTATION TEMPLATE (Flutterwave) ──────────────────────────────
     *
     * const encryptedCard = this.encryptCard({
     *   card_number:  params.cardNumber,
     *   cvv:          params.cvv,
     *   expiry_month: params.expiryMonth,
     *   expiry_year:  params.expiryYear,
     *   currency:     params.currency,
     *   amount:       params.amount,
     *   email:        params.email ?? 'noemail@pineapp.mw',
     *   fullname:     params.cardholderName,
     *   tx_ref:       params.txRef,
     * });
     *
     * const response = await fetch(`${this.baseUrl}/v3/charges?type=card`, {
     *   method: 'POST',
     *   headers: {
     *     'Content-Type': 'application/json',
     *     Authorization: `Bearer ${this.secretKey}`,
     *   },
     *   body: JSON.stringify({ client: encryptedCard }),
     * });
     *
     * const result = await response.json();
     *
     * return {
     *   processorReference: result.data?.flw_ref,
     *   txRef:              params.txRef,
     *   status:             this.mapProcessorStatus(result.data?.status),
     *   amount:             params.amount,
     *   currency:           params.currency,
     *   last4:              result.data?.card?.last_4digits ?? '****',
     *   cardBrand:          result.data?.card?.type ?? 'UNKNOWN',
     *   message:            result.message ?? 'Charge initiated',
     *   chargedAt:          new Date().toISOString(),
     * };
     * ─────────────────────────────────────────────────────────────────────── */
  }

  // ── verifyTransaction ────────────────────────────────────────────────────────

  /**
   * Poll the processor for the current status of a card transaction.
   *
   * TODO: Implement using chosen processor's verify / retrieve endpoint.
   *
   * Flutterwave: GET /v3/transactions?tx_ref={txRef}
   * Paystack:    GET /v1/transaction/verify/{reference}
   */
  async verifyTransaction(txRef: string): Promise<BankCardVerifyResult> {
    this.logger.warn(
      { txRef },
      '[BankCardService] verifyTransaction — NOT YET IMPLEMENTED. Returning stub.',
    );

    // TODO: Remove this stub and replace with real processor call
    throw new NotImplementedException(
      'Bank card payment verification is not yet configured. ' +
      'Please wire up a card processor in BankCardService.verifyTransaction().',
    );

    /*
     * ── IMPLEMENTATION TEMPLATE ────────────────────────────────────────────
     *
     * const response = await fetch(
     *   `${this.baseUrl}/v3/transactions?tx_ref=${txRef}`,
     *   { headers: { Authorization: `Bearer ${this.secretKey}` } },
     * );
     * const result = await response.json();
     * const tx = result.data?.[0];
     *
     * return {
     *   processorReference: tx?.flw_ref,
     *   txRef,
     *   status:    this.mapProcessorStatus(tx?.status),
     *   amount:    tx?.amount,
     *   currency:  tx?.currency,
     *   updatedAt: tx?.updated_at ?? new Date().toISOString(),
     * };
     * ─────────────────────────────────────────────────────────────────────── */
  }

  // ── refundTransaction ────────────────────────────────────────────────────────

  /**
   * Initiate a refund for a completed card transaction.
   *
   * TODO: Implement using chosen processor's refund endpoint.
   *
   * Flutterwave: POST /v3/transactions/{id}/refund
   * Paystack:    POST /v1/refund
   */
  async refundTransaction(txRef: string, amount?: number): Promise<BankCardRefundResult> {
    this.logger.warn(
      { txRef, amount },
      '[BankCardService] refundTransaction — NOT YET IMPLEMENTED. Returning stub.',
    );

    // TODO: Remove this stub and replace with real processor call
    throw new NotImplementedException(
      'Bank card refund is not yet configured. ' +
      'Please wire up a card processor in BankCardService.refundTransaction().',
    );
  }

  // ── Private helpers (kept for when implementation is added) ─────────────────

  /**
   * Map a processor-specific status string to our internal enum.
   * TODO: Expand once the real processor is integrated.
   */
  private mapProcessorStatus(raw?: string): BankCardPaymentStatus {
    switch ((raw ?? '').toLowerCase()) {
      case 'successful':
      case 'success':
      case 'completed':
        return BankCardPaymentStatus.SUCCESS;
      case 'pending':
      case 'processing':
        return BankCardPaymentStatus.PROCESSING;
      case 'failed':
      case 'error':
        return BankCardPaymentStatus.FAILED;
      case 'cancelled':
        return BankCardPaymentStatus.CANCELLED;
      case 'refunded':
        return BankCardPaymentStatus.REFUNDED;
      default:
        return BankCardPaymentStatus.PENDING;
    }
  }
}
