import { SetMetadata } from '@nestjs/common';
import type { Role } from '../constants/roles.constant';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to the listed roles. Enforced by `RolesGuard`
 * (Phase 2, Admin module) which reads this metadata and compares it
 * against `request.user.role`. Used almost exclusively on Admin-module
 * endpoints — customer-facing routes are implicitly `Role.CUSTOMER`.
 *
 * @example
 * @Roles(Role.COMPLIANCE_OFFICER, Role.SUPER_ADMIN)
 * @Post('kyc/:id/approve')
 * approveKyc() { ... }
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
