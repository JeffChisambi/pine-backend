import { SetMetadata } from '@nestjs/common';
import { Permission } from '../../modules/auth/constants/permissions.constant';
import { PERMISSIONS_KEY } from '../../modules/auth/guards/permissions.guard';

/**
 * Restricts a route to users whose role includes ALL of the
 * listed permissions. Enforced by `PermissionsGuard`.
 *
 * Prefer this over `@Roles()` — permissions are more granular
 * and the role→permission mapping is configurable without
 * touching any guard or controller code.
 *
 * @example
 * @RequirePermissions(Permission.KYC_APPROVE)
 * @Post('kyc/:id/approve')
 * approveKyc() { ... }
 */
export const RequirePermissions = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);
