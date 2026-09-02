import type { IBankCardGateway } from '../../payments/interfaces/bank-card-gateway.interface';

// ─── Raw Mastercard REST API types ───────────────────────────────────────────

/** Operations supported by the Mastercard Gateway REST API (Direct Payment model) */
export type McgsApiOperation =
  | 'PAY'
  | 'AUTHORIZE'
  | 'CAPTURE'
  | 'REFUND'
  | 'VOID'
  | 'VERIFY';

/** Top-level result field on every gateway response */
export type McgsResult = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'UNKNOWN';

// ─── Request bodies ───────────────────────────────────────────────────────────

/** Card data sent for PAY / AUTHORIZE / VERIFY */
export interface McgsCardSource {
  type: 'CARD';
  provided: {
    card: {
      /** Full PAN — never logged or persisted after forwarding to gateway */
      number: string;
      expiry: {
        /** Zero-padded 2-digit month, e.g. "05" */
        month: string;
        /** 2-digit year, e.g. "25" */
        year: string;
      };
      /** CVV / CVC / CID */
      securityCode: string;
      /** Cardholder name as it appears on the card */
      nameOnCard?: string;
    };
  };
}

/** Request body for PAY and AUTHORIZE operations */
export interface McgsPayRequest {
  apiOperation: 'PAY' | 'AUTHORIZE';
  order: {
    /** Amount formatted as a decimal string, e.g. "100.00" */
    amount: string;
    currency: string;
    description?: string;
  };
  transaction?: {
    /** Merchant-supplied reference echoed back in the response */
    reference?: string;
  };
  sourceOfFunds: McgsCardSource;
  /** Optional payer details */
  customer?: {
    email?: string;
    firstName?: string;
    lastName?: string;
  };
  /** 3-D Secure authentication parameters — required for 3DS flows */
  '3DSecure'?: {
    authenticationRedirect?: {
      /** URL the ACS will POST the payer back to after authentication */
      responseUrl: string;
    };
  };
}

/** Request body for CAPTURE operation (captures a previously AUTHORIZED amount) */
export interface McgsCaptureRequest {
  apiOperation: 'CAPTURE';
  transaction: {
    /** Amount to capture, formatted as a decimal string */
    amount: string;
    currency: string;
  };
}

/** Request body for REFUND operation */
export interface McgsRefundRequest {
  apiOperation: 'REFUND';
  transaction: {
    /** Amount to refund (partial refund). Omit field for full refund. */
    amount?: string;
    currency?: string;
  };
  order?: {
    currency?: string;
  };
}

/** Request body for VOID operation */
export interface McgsVoidRequest {
  apiOperation: 'VOID';
  transaction: {
    /** Transaction ID on this order that is being voided */
    targetTransactionId: string;
  };
}

// ─── Response bodies ──────────────────────────────────────────────────────────

/** Full transaction response returned by the gateway for any operation */
export interface McgsTransactionResponse {
  result: McgsResult;

  response?: {
    /** Acquirer-specific approval code */
    acquirerCode?: string;
    acquirerMessage?: string;
    /** Gateway-level result code — the primary field to inspect on FAILURE */
    gatewayCode?: string;
    gatewayRecommendation?: string;
  };

  order?: {
    id: string;
    amount?: number;
    currency?: string;
    /** Overall order status: CAPTURED, CANCELLED, REFUNDED, etc. */
    status?: string;
    creationTime?: string;
  };

  transaction?: {
    id: string;
    /** Transaction type: PAYMENT, REFUND, VOID, VERIFICATION, etc. */
    type?: string;
    amount?: number;
    currency?: string;
    /** Authorisation code returned by the issuer */
    authorizationCode?: string;
    /** Merchant-supplied reference echoed from the request */
    reference?: string;
  };

  sourceOfFunds?: {
    provided?: {
      card?: {
        /** Masked PAN — last 4 digits visible, rest replaced with 'x' */
        number?: string;
        /** Card scheme: MASTERCARD, VISA, AMEX, DINERS, DISCOVER, JCB */
        brand?: string;
        expiry?: {
          month?: string;
          year?: string;
        };
        fundingMethod?: string;
      };
    };
  };

  /** Present when result is ERROR or FAILURE due to a request problem */
  error?: {
    /** INVALID_REQUEST | REQUEST_REJECTED | SERVER_BUSY | SERVER_FAILED */
    cause?: string;
    /** Human-readable explanation */
    explanation?: string;
    /** Field name that caused the validation error (INVALID_REQUEST only) */
    field?: string;
    /** Reference code for gateway support escalation */
    supportCode?: string;
  };

  /** 3-D Secure authentication result (present in 3DS flows) */
  '3DSecure'?: {
    acsEci?: string;
    authenticationToken?: string;
    authorizationCode?: string;
    paResStatus?: string;
    /** Status of 3DS enrollment check */
    veResEnrolled?: string;
  };
}

// ─── Extended Mastercard-specific interface ───────────────────────────────────

/**
 * IMastercardGateway — extends the base IBankCardGateway with Mastercard-
 * specific operations not covered by the generic interface.
 *
 * Implementations: MastercardGatewayService
 */
export interface IMastercardGateway extends IBankCardGateway {
  /**
   * Authorize-only — reserves funds without capturing them.
   * Follow up with captureAuthorization() when ready to settle.
   */
  authorizeCard(params: McgsAuthorizeParams): Promise<McgsOperationResult>;

  /**
   * Capture a previously authorized amount.
   * Triggers the actual fund transfer.
   */
  captureAuthorization(params: McgsCaptureParams): Promise<McgsOperationResult>;

  /**
   * Void an un-settled transaction (authorization or captured payment).
   * Cannot void a transaction that has already settled.
   */
  voidTransaction(params: McgsVoidParams): Promise<McgsOperationResult>;

  /**
   * Verify card details without charging — confirms the card is valid
   * and the cardholder is authentic. Useful for on-file card validation.
   */
  verifyCard(params: McgsVerifyCardParams): Promise<McgsOperationResult>;

  /**
   * Health check — confirms the gateway is reachable and operating.
   */
  checkGatewayHealth(): Promise<{ status: 'OPERATING' | 'UNREACHABLE'; latencyMs: number }>;
}

// ─── Parameter types for extended operations ──────────────────────────────────

export interface McgsAuthorizeParams {
  /** Internal Pine transaction reference (used as orderId) */
  txRef: string;
  amount: number;
  currency: 'MWK' | 'USD';
  cardholderName: string;
  cardNumber: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  email?: string;
  description?: string;
}

export interface McgsCaptureParams {
  /** Pine order reference (matches the txRef used in authorizeCard) */
  orderId: string;
  /** Transaction ID of the original AUTHORIZE transaction */
  authorizeTransactionId: string;
  /** Amount to capture — must be ≤ the authorized amount */
  amount: number;
  currency: 'MWK' | 'USD';
}

export interface McgsVoidParams {
  /** Pine order reference */
  orderId: string;
  /** Transaction ID to void */
  transactionId: string;
}

export interface McgsVerifyCardParams {
  txRef: string;
  cardholderName: string;
  cardNumber: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  currency?: 'MWK' | 'USD';
}

/** Normalised result returned by extended gateway operations */
export interface McgsOperationResult {
  success: boolean;
  orderId: string;
  transactionId: string;
  gatewayCode?: string;
  authorizationCode?: string;
  /** Masked card number (last 4 visible) */
  cardLast4?: string;
  cardBrand?: string;
  amount?: number;
  currency?: string;
  rawResponse: McgsTransactionResponse;
}

// ── Hosted Session (PCI scope reduction) ──────────────────────────────────────
// The app never sends card data to Pine. Pine creates a SESSION with the
// broker's credentials, the app PUTs the card straight to the gateway using
// only the session id (an unauthenticated call by design), then Pine performs
// PAY against that session. Card data never touches Pine's servers or logs.

/** What the mobile app needs to update a session with card details itself. */
export interface McgsSessionHandle {
  sessionId: string;
  /**
   * The gateway API version that CREATED the session. Updating the session
   * must use this exact version — a mismatch is rejected by the gateway.
   */
  apiVersion: number;
  /** Merchant the session belongs to. Not a secret: required to build the URL. */
  merchantId: string;
  /** Gateway host the app PUTs card details to. Not a secret. */
  gatewayBaseUrl: string;
}

/** Raw CREATE SESSION / session response envelope. */
export interface McgsSessionResponse {
  session?: {
    id?: string;
    updateStatus?: string;
    version?: string;
  };
  result?: McgsResult;
  successIndicator?: string;
  error?: {
    cause?: string;
    explanation?: string;
    field?: string;
    validationType?: string;
  };
}

/** PAY against a session the app has already populated with card details. */
export interface McgsChargeSessionParams {
  txRef: string;
  amount: number;
  currency: 'MWK' | 'USD';
  sessionId: string;
  email?: string;
}

/** PAY against a stored card-on-file token. */
export interface McgsChargeTokenParams {
  txRef: string;
  amount: number;
  currency: 'MWK' | 'USD';
  token: string;
  /** Optional CVV re-verification for card-on-file transactions. */
  securityCode?: string;
  email?: string;
}

/** A card-on-file token created from a session — replaces storing the PAN. */
export interface McgsCardToken {
  /** Gateway token. Safe to store: it is useless outside this merchant. */
  token: string;
  last4: string;
  cardBrand: string;
  expiryMonth: string;
  expiryYear: string;
}

/** Raw CREATE TOKEN response envelope. */
export interface McgsTokenResponse {
  token?: string;
  status?: string;
  result?: McgsResult;
  sourceOfFunds?: {
    provided?: {
      card?: {
        number?: string;
        brand?: string;
        scheme?: string;
        expiry?: { month?: string; year?: string };
      };
    };
  };
  error?: {
    cause?: string;
    explanation?: string;
  };
}
