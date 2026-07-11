import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../../core/decorators/roles.decorator';
import { ForbiddenException } from '../../../core/exceptions/app.exception';
import type { RequestWithUser } from '../../../core/types/request-context.types';
import type { Role } from '../../../core/constants/roles.constant';

/**
 * Role-based access control guard. Checks `@Roles()` metadata
 * against `request.user.role`. If no roles are specified on the
 * handler, access is allowed (role check is opt-in).
 *
 * Use `@Roles(Role.COMPLIANCE_OFFICER, Role.SUPER_ADMIN)` on
 * admin endpoints. For more granular control, use PermissionsGuard.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator → allow
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userRole = request.user?.role;

    if (!userRole || !requiredRoles.includes(userRole)) {
      throw new ForbiddenException(
        'You do not have the required role to access this resource',
      );
    }

    return true;
  }
}
