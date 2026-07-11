import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { TokenService } from '../services/token.service';
import { UnauthorizedException } from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';
import type { RequestWithUser } from '../../../core/types/request-context.types';

/**
 * PIN verification guard for financial actions. Apply to any
 * endpoint that requires a valid PIN verification before proceeding
 * (buy, sell, withdraw, change bank, update KYC, etc.).
 *
 * The user must first call `POST /auth/pin/verify` to get a
 * short-lived `pinToken` (5-minute JWT), then include it in the
 * `x-pin-token` header on the protected request.
 *
 * @example
 * @UseGuards(PinGuard)
 * @Post('withdraw')
 * withdraw() { ... }
 */
@Injectable()
export class PinGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const pinToken = request.headers['x-pin-token'] as string | undefined;

    if (!pinToken) {
      throw new UnauthorizedException(
        'PIN verification required. Call POST /auth/pin/verify first.',
        ErrorCode.PIN_NOT_SET,
      );
    }

    const userId = request.user?.id;
    if (!userId) {
      throw new UnauthorizedException('Not authenticated');
    }

    const valid = this.tokenService.verifyPinToken(pinToken, userId);
    if (!valid) {
      throw new UnauthorizedException(
        'PIN token expired or invalid. Please verify your PIN again.',
        ErrorCode.PIN_INVALID,
      );
    }

    return true;
  }
}
