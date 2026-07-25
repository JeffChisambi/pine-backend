import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Error codes returned by the Mastercard Gateway in the `error.cause` field.
 * Documented at: https://test-nbm.mtf.gateway.mastercard.com
 */
export enum McgsErrorCause {
  INVALID_REQUEST = 'INVALID_REQUEST',
  REQUEST_REJECTED = 'REQUEST_REJECTED',
  SERVER_BUSY = 'SERVER_BUSY',
  SERVER_FAILED = 'SERVER_FAILED',
}

/**
 * Gateway codes returned in `response.gatewayCode` for failed transactions.
 */
export enum McgsGatewayCode {
  APPROVED = 'APPROVED',
  APPROVED_PENDING_SETTLEMENT = 'APPROVED_PENDING_SETTLEMENT',
  DECLINED = 'DECLINED',
  DECLINED_DO_NOT_CONTACT = 'DECLINED_DO_NOT_CONTACT',
  ABORTED = 'ABORTED',
  REFERRED = 'REFERRED',
  TIMED_OUT = 'TIMED_OUT',
  EXPIRED_CARD = 'EXPIRED_CARD',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  ACQUIRER_SYSTEM_ERROR = 'ACQUIRER_SYSTEM_ERROR',
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  BLOCKED = 'BLOCKED',
  INVALID_CSC = 'INVALID_CSC',
  LOCK_FAILURE = 'LOCK_FAILURE',
  SUBMITTED = 'SUBMITTED',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Thrown when the Mastercard Gateway returns a non-SUCCESS result.
 * Carries the structured error details from the API response.
 */
export class MastercardGatewayException extends HttpException {
  /** Underlying gateway result: FAILURE | ERROR | PENDING | UNKNOWN */
  readonly gatewayResult: string;

  /** Mastercard `response.gatewayCode`, e.g. DECLINED, TIMED_OUT */
  readonly gatewayCode?: string;

  /** Mastercard `error.cause` */
  readonly errorCause?: string;

  /** Mastercard `error.explanation` */
  readonly errorExplanation?: string;

  /** Mastercard `error.supportCode` (for escalating to gateway support) */
  readonly supportCode?: string;

  constructor(opts: {
    gatewayResult: string;
    gatewayCode?: string;
    errorCause?: string;
    errorExplanation?: string;
    supportCode?: string;
    message?: string;
  }) {
    const message =
      opts.message ??
      opts.errorExplanation ??
      `Mastercard Gateway: ${opts.gatewayCode ?? opts.gatewayResult}`;

    // Map gateway result to HTTP status
    const httpStatus = MastercardGatewayException.toHttpStatus(
      opts.gatewayResult,
      opts.gatewayCode,
      opts.errorCause,
    );

    super(
      {
        statusCode: httpStatus,
        error: 'PAYMENT_GATEWAY_ERROR',
        message,
        gatewayResult: opts.gatewayResult,
        gatewayCode: opts.gatewayCode,
        errorCause: opts.errorCause,
        supportCode: opts.supportCode,
      },
      httpStatus,
    );

    this.gatewayResult = opts.gatewayResult;
    this.gatewayCode = opts.gatewayCode;
    this.errorCause = opts.errorCause;
    this.errorExplanation = opts.errorExplanation;
    this.supportCode = opts.supportCode;
  }

  private static toHttpStatus(
    result: string,
    gatewayCode?: string,
    errorCause?: string,
  ): HttpStatus {
    // Gateway infrastructure errors → 502 Bad Gateway
    if (
      errorCause === McgsErrorCause.SERVER_BUSY ||
      errorCause === McgsErrorCause.SERVER_FAILED ||
      gatewayCode === McgsGatewayCode.ACQUIRER_SYSTEM_ERROR ||
      gatewayCode === McgsGatewayCode.SYSTEM_ERROR
    ) {
      return HttpStatus.BAD_GATEWAY;
    }

    // Invalid request → 422 Unprocessable Entity
    if (errorCause === McgsErrorCause.INVALID_REQUEST) {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }

    // Gateway declined the card → 402 Payment Required
    if (
      result === 'FAILURE' &&
      (gatewayCode === McgsGatewayCode.DECLINED ||
        gatewayCode === McgsGatewayCode.DECLINED_DO_NOT_CONTACT ||
        gatewayCode === McgsGatewayCode.INSUFFICIENT_FUNDS ||
        gatewayCode === McgsGatewayCode.EXPIRED_CARD ||
        gatewayCode === McgsGatewayCode.INVALID_CSC ||
        gatewayCode === McgsGatewayCode.BLOCKED)
    ) {
      return HttpStatus.PAYMENT_REQUIRED;
    }

    // Timed out → 504 Gateway Timeout
    if (gatewayCode === McgsGatewayCode.TIMED_OUT) {
      return HttpStatus.GATEWAY_TIMEOUT;
    }

    return HttpStatus.BAD_GATEWAY;
  }
}

/**
 * Thrown when required Mastercard Gateway credentials are missing from config.
 */
export class MastercardGatewayNotConfiguredException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'GATEWAY_NOT_CONFIGURED',
        message:
          'Mastercard Gateway credentials are not configured. ' +
          'Set MCGS_MERCHANT_ID and MCGS_API_PASSWORD in the environment.',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
