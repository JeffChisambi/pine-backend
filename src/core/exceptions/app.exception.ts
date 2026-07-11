import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../constants/error-codes.constant';

/**
 * Base class for every hand-thrown business exception in the codebase.
 * Never throw a raw `HttpException` or generic `Error` from a service —
 * throw a subclass of `AppException` (or one of the concrete classes
 * below) so `GlobalExceptionFilter` can map it to a stable `ErrorCode`
 * and consistent envelope.
 */
export class AppException extends HttpException {
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status: HttpStatus, details?: unknown) {
    super({ code, message, details }, status);
    this.code = code;
    this.details = details;
  }
}

export class ValidationException extends AppException {
  constructor(message = 'Validation failed', details?: unknown) {
    super(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }
}

export class ResourceNotFoundException extends AppException {
  constructor(resource: string, identifier?: string) {
    super(
      ErrorCode.NOT_FOUND,
      identifier ? `${resource} not found: ${identifier}` : `${resource} not found`,
      HttpStatus.NOT_FOUND,
    );
  }
}

export class UnauthorizedException extends AppException {
  constructor(message = 'Unauthorized', code: ErrorCode = ErrorCode.UNAUTHORIZED) {
    super(code, message, HttpStatus.UNAUTHORIZED);
  }
}

export class ForbiddenException extends AppException {
  constructor(message = 'Forbidden') {
    super(ErrorCode.FORBIDDEN, message, HttpStatus.FORBIDDEN);
  }
}

export class ConflictException extends AppException {
  constructor(message = 'Conflict', code: ErrorCode = ErrorCode.CONFLICT, details?: unknown) {
    super(code, message, HttpStatus.CONFLICT, details);
  }
}

export class RateLimitedException extends AppException {
  constructor(message = 'Too many requests', retryAfterSeconds?: number) {
    super(ErrorCode.RATE_LIMITED, message, HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds });
  }
}

export class InsufficientFundsException extends AppException {
  constructor(message = 'Insufficient funds') {
    super(ErrorCode.INSUFFICIENT_FUNDS, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export class IdempotencyConflictException extends AppException {
  constructor(message = 'This idempotency key was already used with a different payload') {
    super(ErrorCode.IDEMPOTENCY_KEY_REUSED, message, HttpStatus.CONFLICT);
  }
}

export class ServiceUnavailableException extends AppException {
  constructor(message = 'Service temporarily unavailable') {
    super(ErrorCode.SERVICE_UNAVAILABLE, message, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
