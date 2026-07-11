import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '../../../core/exceptions/app.exception';
import type { RequestWithUser } from '../../../core/types/request-context.types';
import type { Role } from '../../../core/constants/roles.constant';
import {
  Permission,
  ROLE_PERMISSIONS,
} from '../constants/permissions.constant';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Permission-based access control guard. More granular than RolesGuard —
 * checks `@RequirePermissions()` metadata against the role→permission
 * mapping defined in `permissions.constant.ts`.
 *
 * This is the recommended guard for production use. Guards check
 * permissions, not role names — making the system extensible without
 * touching guard logic.
 *
 * @example
 * @RequirePermissions(Permission.KYC_APPROVE)
 * @Post('kyc/:id/approve')
 * approveKyc() { ... }
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @RequirePermissions() → allow
    if (!requiredPermissions || requiredPermissions.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userRole = request.user?.role as Role | undefined;

    if (!userRole) {
      throw new ForbiddenException('No role assigned');
    }

    const userPermissions = ROLE_PERMISSIONS[userRole] ?? [];

    const hasAll = requiredPermissions.every((perm) =>
      userPermissions.includes(perm),
    );

    if (!hasAll) {
      throw new ForbiddenException(
        'You do not have the required permissions to access this resource',
      );
    }

    return true;
  }
}
