import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthenticatedUser, RequestWithUser } from '../types/request-context.types';

/**
 * Injects the authenticated user attached by the JWT auth guard.
 *
 * @example
 * getProfile(@CurrentUser() user: AuthenticatedUser) { ... }
 * getProfileId(@CurrentUser('id') userId: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    return field ? request.user?.[field] : request.user;
  },
);
