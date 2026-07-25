import { Role } from '../../../core/constants/roles.constant';

/**
 * Fine-grained permission strings. Guards check these —
 * never raw role names — making the system extensible
 * without touching guard logic.
 *
 * Convention: `domain.action` (lowercase, dot-separated).
 */
export enum Permission {
  // Wallet
  WALLET_READ = 'wallet.read',
  WALLET_DEPOSIT = 'wallet.deposit',
  WALLET_WITHDRAW = 'wallet.withdraw',

  // Trading
  TRADE_EXECUTE = 'trade.execute',
  TRADE_CANCEL = 'trade.cancel',

  // KYC
  KYC_SUBMIT = 'kyc.submit',
  KYC_REVIEW = 'kyc.review',
  KYC_APPROVE = 'kyc.approve',

  // Users
  USERS_READ = 'users.read',
  USERS_MANAGE = 'users.manage',

  // Market
  MARKET_READ = 'market.read',
  MARKET_SYNC = 'market.sync',

  // Reports
  REPORTS_VIEW = 'reports.view',
  REPORTS_EXPORT = 'reports.export',

  // Audit
  AUDIT_VIEW = 'audit.view',

  // Admin
  ADMIN_ACCESS = 'admin.access',
}

/**
 * Role → Permission mapping. Each role is granted a set of
 * permissions. The PermissionsGuard resolves the current
 * user's role to this map and checks against the required
 * permissions on the route.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.CUSTOMER]: [
    Permission.WALLET_READ,
    Permission.WALLET_DEPOSIT,
    Permission.WALLET_WITHDRAW,
    Permission.TRADE_EXECUTE,
    Permission.TRADE_CANCEL,
    Permission.KYC_SUBMIT,
    Permission.MARKET_READ,
  ],

  [Role.CUSTOMER_SUPPORT]: [
    Permission.USERS_READ,
    Permission.WALLET_READ,
    Permission.KYC_REVIEW,
    Permission.MARKET_READ,
    Permission.ADMIN_ACCESS,
  ],

  [Role.COMPLIANCE_OFFICER]: [
    Permission.USERS_READ,
    Permission.KYC_REVIEW,
    Permission.KYC_APPROVE,
    Permission.AUDIT_VIEW,
    Permission.REPORTS_VIEW,
    Permission.ADMIN_ACCESS,
  ],

  [Role.FINANCE_OFFICER]: [
    Permission.WALLET_READ,
    Permission.REPORTS_VIEW,
    Permission.REPORTS_EXPORT,
    Permission.AUDIT_VIEW,
    Permission.ADMIN_ACCESS,
  ],

  [Role.MARKET_OPERATIONS]: [
    Permission.MARKET_READ,
    Permission.MARKET_SYNC,
    Permission.REPORTS_VIEW,
    Permission.ADMIN_ACCESS,
  ],

  [Role.AUDITOR]: [
    Permission.USERS_READ,
    Permission.WALLET_READ,
    Permission.AUDIT_VIEW,
    Permission.REPORTS_VIEW,
    Permission.REPORTS_EXPORT,
    Permission.ADMIN_ACCESS,
  ],

  [Role.BROKER]: [
    Permission.USERS_READ,
    Permission.KYC_REVIEW,
    Permission.KYC_APPROVE,
    Permission.WALLET_READ,
    Permission.TRADE_EXECUTE,
    Permission.TRADE_CANCEL,
    Permission.MARKET_READ,
    Permission.REPORTS_VIEW,
    Permission.REPORTS_EXPORT,
    Permission.AUDIT_VIEW,
    Permission.ADMIN_ACCESS,
  ],

  [Role.SUPER_ADMIN]: Object.values(Permission),
};
