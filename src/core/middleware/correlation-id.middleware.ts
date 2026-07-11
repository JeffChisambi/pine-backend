import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { RequestWithContext } from '../types/request-context.types';

export const CORRELATION_ID_HEADER = 'x-request-id';

/**
 * Every request gets a request ID: reused from the incoming
 * `x-request-id` header if the mobile app / an upstream gateway already
 * set one (so a single user action can be traced end-to-end across
 * services), otherwise generated fresh. Echoed back in the response
 * header and in every log line and error envelope for that request.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: RequestWithContext, res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_ID_HEADER];
    const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();

    req.requestId = requestId;
    res.setHeader(CORRELATION_ID_HEADER, requestId);
    next();
  }
}
