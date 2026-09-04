/**
 * The broker dashboard, as a list of sections a staff member can be granted.
 *
 * This is the vocabulary the whole permission system speaks: the checkboxes
 * a broker ticks, the array stored on the user, the sidebar filter in the
 * dashboard, and the API guard that decides whether a request is allowed.
 * Keeping it to sidebar-level sections is deliberate — it is what a broker
 * can reason about today. Finer grains (e.g. "approve KYC" vs "view KYC")
 * can be added later as more keys without changing the shape of anything.
 *
 * Mirrored in the dashboard at src/lib/sections.ts — keep the two in step.
 */
export const DASHBOARD_SECTIONS = [
  'overview',
  'users',
  'kyc',
  'withdrawals',
  'support',
  'orders',
  'notifications',
  'settings',
] as const;

export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];

export function isDashboardSection(value: unknown): value is DashboardSection {
  return typeof value === 'string' && (DASHBOARD_SECTIONS as readonly string[]).includes(value);
}

/**
 * Which section an admin API route belongs to, by its first path segment
 * after /admin. Routes not listed here are either always allowed for any
 * signed-in staff member (their own profile, auth) or platform-only and
 * already refused to every broker user by PermissionsGuard.
 */
export const ROUTE_SECTIONS: Record<string, DashboardSection> = {
  dashboard: 'overview',
  users: 'users',
  kyc: 'kyc',
  wallets: 'withdrawals',
  support: 'support',
  trading: 'orders',
  notifications: 'notifications',
  fees: 'settings',
  risk: 'settings',
  migration: 'settings',
  staff: 'settings',
};

/** Admin routes every staff member may use regardless of sections. */
export const UNGATED_ADMIN_ROUTES = new Set(['me', 'auth']);
