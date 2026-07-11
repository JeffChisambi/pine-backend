import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Extracts the `Idempotency-Key` header. Required on every endpoint that
 * moves money or places an order (deposits, withdrawals, buy/sell
 * orders, dividend reinvestment) — see `IdempotencyGuard`
 * (`core/guards`), which enforces its presence, and the `IdempotencyService`
 * (Phase 3, `shared`), which enforces exactly-once execution per key.
 */
export const IdempotencyKey = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const header = request.headers[IDEMPOTENCY_KEY_HEADER];
    return Array.isArray(header) ? header[0] : header;
  },
);
