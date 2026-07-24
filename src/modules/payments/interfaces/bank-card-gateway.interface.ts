import { BankCardPaymentStatus } from '../dto/bank-card.dto';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface BankCardChargeResult {
  /** Processor-specific transaction reference */
  processorReference: string;

  /** Internal Pine tx ref (echo back) */
  txRef: string;

  /** Payment status returned by the processor */
  status: BankCardPaymentStatus;

  /** Amount that was charged */
  amount: number;

  /** Currency */
  currency: string;

  /** Last 4 digits of the card (safe to log/store) */
  last4: string;

  /** Card brand as identified by the processor */
  cardBrand: string;

  /** Human-readable message from processor */
  message: string;

  /** ISO timestamp of the charge attempt */
  chargedAt: string;
}

export interface BankCardVerifyResult {
  /** Processor-specific transaction reference */
  processorReference: string;

  /** Internal Pine tx ref */
  txRef: string;

  /** Current status of the transaction */
  status: BankCardPaymentStatus;

  /** Amount */
  amount: number;

  /** Currency */
  currency: string;

  /** ISO timestamp when the transaction last changed status */
  updatedAt: string;

  /** Failure reason (if status === FAILED) */
  failureReason?: string;
}

export interface BankCardRefundResult {
  /** Processor-specific refund reference */
  refundReference: string;

  /** Original transaction reference */
  originalTxRef: string;

  /** Amount refunded */
  refundedAmount: number;

  /** Currency */
  currency: string;

  /** Status of the refund */
  status: 'PENDING' | 'SUCCESS' | 'FAILED';

  /** ISO timestamp of refund initiation */
  initiatedAt: string;
}

// ─── Card parameters passed to the gateway ───────────────────────────────────

export interface BankCardChargeParams {
  /** Internal Pine transaction reference */
  txRef: string;

  /** Amount to charge */
  amount: number;

  /** Currency */
  currency: 'MWK' | 'USD';

  /** Cardholder full name */
  cardholderName: string;

  /**
   * Raw card number OR processor token.
   * In production: tokenise on the client before sending to avoid PCI scope.
   */
  cardNumber: string;

  /** Expiry month (MM) */
  expiryMonth: string;

  /** Expiry year (YY or YYYY) */
  expiryYear: string;

  /** CVV / CVC */
  cvv: string;

  /** Payer email (optional, for receipt) */
  email?: string;

  /** Additional metadata */
  meta?: Record<string, any>;
}

// ─── Gateway interface ────────────────────────────────────────────────────────

/**
 * IBankCardGateway — contract that any bank card processor must satisfy.
 *
 * Implementations:
 *   - BankCardService (current skeleton — TODO: wire up real processor)
 *
 * Swap processors by providing a different implementation token via DI.
 */
export interface IBankCardGateway {
  /**
   * Charge a bank card.
   *
   * @param params  Card and amount details
   * @returns       Charge result from the processor
   * @throws        If the charge fails or the processor is unreachable
   */
  chargeCard(params: BankCardChargeParams): Promise<BankCardChargeResult>;

  /**
   * Verify / poll the status of a previously initiated card transaction.
   *
   * @param txRef  Pine internal transaction reference
   * @returns      Current status from the processor
   * @throws       If the reference is unknown or the processor is unreachable
   */
  verifyTransaction(txRef: string): Promise<BankCardVerifyResult>;

  /**
   * Initiate a refund for a completed card transaction.
   *
   * @param txRef   Pine internal transaction reference of the original charge
   * @param amount  Amount to refund (partial refund). Omit for full refund.
   * @returns       Refund result
   * @throws        If the original transaction is not refundable
   */
  refundTransaction(txRef: string, amount?: number): Promise<BankCardRefundResult>;
}

/** DI injection token for IBankCardGateway */
export const BANK_CARD_GATEWAY = 'BANK_CARD_GATEWAY';
