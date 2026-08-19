import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Optional } from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { SystemErrorService } from '../../modules/system-errors/services/system-error.service';
import { ErrorCode } from '../constants/error-codes.constant';
import type { ApiErrorResponse } from '../types/api-response.types';
import type { RequestWithContext } from '../types/request-context.types';
import { AppException } from '../exceptions/app.exception';

/**
 * Catches every exception thrown anywhere in the request lifecycle
 * (controllers, guards, interceptors, pipes) and converts it into the
 * standard `ApiErrorResponse` envelope.
 *
 * Three tiers, in priority order:
 *   1. `AppException` (and subclasses) — our own typed business errors.
 *      Carry a stable `ErrorCode` and an intentional HTTP status.
 *   2. Any other `HttpException` — thrown by Nest internals (e.g. the
 *      global `ValidationPipe`, `ThrottlerGuard`, `@nestjs/terminus`).
 *      Mapped onto the closest `ErrorCode`.
 *   3. Anything else (a genuine bug: TypeError, a driver throwing, etc).
 *      Always mapped to 500 and the message is NEVER sent to the client
 *      in production — only `INTERNAL_SERVER_ERROR` — to avoid leaking
 *      stack traces, SQL, or internal paths.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: PinoLogger,
    private readonly config: AppConfigService,
    // Optional so tests/minimal bootstraps that don't import the module
    // still construct the filter. capture() itself never throws.
    @Optional() private readonly systemErrors?: SystemErrorService,
  ) {
    this.logger.setContext(GlobalExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithContext>();
    const requestId = request.requestId ?? 'unknown';

    const { status, code, message, details } = this.resolve(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, requestId, path: request.url, method: request.method },
        'Unhandled exception',
      );
      // Surface in the admin System Errors console. Fire-and-forget: error
      // capture must never delay or fail the error response itself.
      void this.systemErrors?.capture({
        source: 'BACKEND',
        // A typed AppException reaching 5xx is a known failure path (HIGH);
        // an unknown exception is a genuine bug (CRITICAL).
        severity: exception instanceof HttpException ? 'HIGH' : 'CRITICAL',
        message: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? (exception.stack ?? null) : null,
        location: `${request.method} ${request.url?.split('?')[0] ?? ''}`,
        context: { requestId },
        userId: (request as any).user?.id ?? null,
      });
    } else {
      this.logger.warn(
        { requestId, path: request.url, method: request.method, code, status },
        message,
      );
    }

    const body: ApiErrorResponse = {
      success: false,
      error: {
        code,
        message,
        // Only surface `details` (validation field errors, etc.) for
        // client (4xx) errors. Never for 5xx — that's where stack
        // traces and internal state would otherwise leak.
        ...(status < HttpStatus.INTERNAL_SERVER_ERROR && details !== undefined ? { details } : {}),
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    };

    response.status(status).json(body);
  }

  private resolve(exception: unknown): {
    status: HttpStatus;
    code: ErrorCode | string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof AppException) {
      const response = exception.getResponse() as { message: string; details?: unknown };
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: response.message,
        details: response.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        code: this.mapHttpStatusToCode(status),
        message: Array.isArray(message) ? message.join('; ') : message,
        details: typeof response === 'object' ? response : undefined,
      };
    }

    // Unknown / unexpected error — never leak internals to the client.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: this.config.app.isProduction
        ? 'An unexpected error occurred'
        : exception instanceof Error
          ? exception.message
          : 'An unexpected error occurred',
    };
  }

  private mapHttpStatusToCode(status: HttpStatus): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return ErrorCode.INTERNAL_SERVER_ERROR;
    }
  }
}
