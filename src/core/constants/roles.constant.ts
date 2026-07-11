/**
 * Application-wide roles. Regular customers are `CUSTOMER`; every other
 * value is an internal staff role used exclusively by the Admin module
 * (Phase 6) and enforced by `RolesGuard` (added alongside JWT auth in
 * Phase 2). Declared here in `core` because the `User` domain entity,
 * Prisma schema, and multiple modules all need to reference the same
 * closed set of values.
 */
export enum Role {
  CUSTOMER = 'CUSTOMER',
  SUPER_ADMIN = 'SUPER_ADMIN',
  COMPLIANCE_OFFICER = 'COMPLIANCE_OFFICER',
  FINANCE_OFFICER = 'FINANCE_OFFICER',
  CUSTOMER_SUPPORT = 'CUSTOMER_SUPPORT',
  MARKET_OPERATIONS = 'MARKET_OPERATIONS',
  AUDITOR = 'AUDITOR',
}

/** Roles that may authenticate through the staff/admin surface at all. */
export const STAFF_ROLES: readonly Role[] = [
  Role.SUPER_ADMIN,
  Role.COMPLIANCE_OFFICER,
  Role.FINANCE_OFFICER,
  Role.CUSTOMER_SUPPORT,
  Role.MARKET_OPERATIONS,
  Role.AUDITOR,
];

export const IS_STAFF_ROLE = (role: Role): boolean => STAFF_ROLES.includes(role);
