import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * The default `ThrottlerGuard` keys off `req.ip`, which — behind a load
 * balancer / reverse proxy (ALB, Cloudflare, nginx) — is the proxy's own
 * address unless Express's `trust proxy` setting is honoured. We also
 * prefer the authenticated user id when available (set by the JWT guard
 * in Phase 2) so a single user can't dodge limits by rotating IPs on a
 * mobile network, while unauthenticated routes (login, OTP) still fall
 * back to IP.
 */
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  protected getTracker(req: Request): Promise<string> {
    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    if (userId) {
      return Promise.resolve(`user:${userId}`);
    }
    return Promise.resolve(req.ips?.length ? req.ips[0] : req.ip || 'unknown');
  }
}
