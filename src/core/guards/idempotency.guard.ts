import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode } from '../constants/error-codes.constant';
import { ValidationException } from '../exceptions/app.exception';
import { IDEMPOTENCY_KEY_HEADER } from '../decorators/idempotency-key.decorator';

export const REQUIRE_IDEMPOTENCY_KEY = 'requireIdempotencyKey';

/**
 * Marks a mutating endpoint as requiring an `Idempotency-Key` header.
 * Pair with `IdempotencyGuard`. The guard only checks *presence and
 * shape* here — actual "have we already processed this key" dedup logic
 * lives in `IdempotencyService` (Phase 3, `shared/idempotency`), which
 * wraps the handler body in a Redis-backed lock + result cache.
 *
 * @example
 * @RequireIdempotencyKey()
 * @UseGuards(IdempotencyGuard)
 * @Post('deposits')
 * createDeposit(@IdempotencyKey() key: string, @Body() dto: CreateDepositDto) { ... }
 */
export const RequireIdempotencyKey = (): MethodDecorator =>
  SetMetadata(REQUIRE_IDEMPOTENCY_KEY, true);

@Injectable()
export class IdempotencyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_IDEMPOTENCY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const key = request.headers[IDEMPOTENCY_KEY_HEADER];

    if (!key || Array.isArray(key) || key.trim().length < 8) {
      throw new ValidationException(
        `A valid '${IDEMPOTENCY_KEY_HEADER}' header (min 8 characters) is required for this operation`,
        { code: ErrorCode.IDEMPOTENCY_KEY_MISSING },
      );
    }

    return true;
  }
}
