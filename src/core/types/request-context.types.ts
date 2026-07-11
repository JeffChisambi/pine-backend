import type { Request } from 'express';
import type { Role } from '../constants/roles.constant';

/**
 * Shape attached to `request.user` by the JWT auth guard (Phase 2).
 * Kept in `core` — rather than the `auth` module — because controllers
 * and guards across many modules need to reference it without creating
 * a dependency on the auth module's internals.
 */
export interface AuthenticatedUser {
  id: string;
  phone: string;
  email: string | null;
  role: Role;
  sessionId: string;
  deviceId: string;
  kycStatus: 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
}

export interface RequestWithUser extends Request {
  user: AuthenticatedUser;
  requestId: string;
}

export interface RequestWithContext extends Request {
  user?: AuthenticatedUser;
  requestId: string;
}
