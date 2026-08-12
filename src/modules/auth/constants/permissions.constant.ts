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

  // Platform-wide administration (Super Admin only): mobile themes,
  // news CMS, treasury catalogue, broadcast notifications, platform
  // settings. A Broker Admin must never hold this permission — the
  // backend enforces the separation regardless of frontend state.
  PLATFORM_ADMIN = 'platform.admin',

  // Broker tenant management (Super Admin only): create/edit brokers,
  // broker admins, broker payment/API configuration.
  BROKERS_MANAGE = 'brokers.manage',
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

  // BROKER = Broker Admin: operational access scoped to their own
  // broker's investors only (enforced server-side by BrokerScopeService
  // on every admin query). Deliberately omitted:
  //   - KYC_APPROVE       (compliance decision stays with the platform)
  //   - AUDIT_VIEW        (platform-wide audit is Super Admin only)
  //   - PLATFORM_ADMIN    (themes, news, treasury, broadcasts)
  //   - BROKERS_MANAGE    (tenant management)
  [Role.BROKER]: [
    Permission.USERS_READ,
    Permission.KYC_REVIEW,
    Permission.WALLET_READ,
    Permission.TRADE_EXECUTE,
    Permission.TRADE_CANCEL,
    Permission.MARKET_READ,
    Permission.REPORTS_VIEW,
    Permission.REPORTS_EXPORT,
    Permission.ADMIN_ACCESS,
  ],

  [Role.SUPER_ADMIN]: Object.values(Permission),
};
