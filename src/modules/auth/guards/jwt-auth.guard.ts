import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../core/decorators/public.decorator';
import { TokenService } from '../services/token.service';
import { SessionService } from '../services/session.service';
import { IdentityService } from '../services/identity.service';
import { UnauthorizedException } from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';
import type { RequestWithUser } from '../../../core/types/request-context.types';

/**
 * Global JWT authentication guard. Registered via APP_GUARD so
 * EVERY route is authenticated by default. Routes decorated with
 * `@Public()` bypass this guard.
 *
 * Guard flow:
 *   1. Check @Public() metadata → skip if present
 *   2. Extract Bearer token from Authorization header
 *   3. Verify JWT signature + claims (TokenService)
 *   4. Check access token blacklist (Redis)
 *   5. Validate session is still active (SessionService)
 *   6. Attach AuthenticatedUser to request.user
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly identityService: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check @Public() decorator
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    // Extract token
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or malformed Authorization header',
        ErrorCode.UNAUTHORIZED,
      );
    }

    const token = authHeader.slice(7);

    // Verify JWT (checks signature, expiry, blacklist)
    const payload = await this.tokenService.verifyAccessToken(token);

    // Validate session is still active
    const sessionValid = await this.sessionService.validateSession(payload.sid);
    if (!sessionValid) {
      throw new UnauthorizedException(
        'Session expired or revoked',
        ErrorCode.SESSION_REVOKED,
      );
    }

    // Fetch user to get phone/email for the request context
    const user = await this.identityService.getUserById(payload.sub);

    // Attach to request
    request.user = this.tokenService.payloadToUser(
      payload,
      user.phone,
      user.email,
    );

    return true;
  }
}
