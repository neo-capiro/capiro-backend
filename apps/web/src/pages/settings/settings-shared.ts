/**
 * UI-free Settings tab model — extracted from SettingsLayout.tsx (which stays
 * antd) so the vNext Settings module can share the EXACT same role-filtering
 * logic without a runtime antd edge (extraction pattern, purge Phase 2).
 * SettingsLayout re-exports everything here; its public API is unchanged.
 *
 * Tabs are role-filtered client-side for presentation only — the API's
 * RolesGuard on every endpoint is the real security boundary.
 */
import { ROLE_RANK, type TenantRole } from '@capiro/shared';

export interface SettingsTab {
  key: string;
  label: string;
  minRole?: TenantRole;
  /** Onboarding v1: billing detail is visible ONLY to billing admins. */
  billingAdminOnly?: boolean;
}

export const POLICY_PACKS_TAB_KEY = '/settings/skills?view=policy-packs';

export const SETTINGS_TABS: SettingsTab[] = [
  { key: '/settings/personal', label: 'Personal' },
  { key: '/settings/contact', label: 'Contact Info' },
  { key: '/settings/memory', label: 'Memory' },
  { key: '/settings/team', label: 'Team', minRole: 'user_admin' },
  { key: '/settings/branding', label: 'Branding', minRole: 'user_admin' },
  { key: '/settings/clients', label: 'Clients', minRole: 'user_admin' },
  { key: '/settings/integrations', label: 'Integrations' },
  { key: '/settings/billing', label: 'Billing', minRole: 'user_admin', billingAdminOnly: true },
  { key: '/settings/ai-usage', label: 'AI Usage', minRole: 'user_admin', billingAdminOnly: true },
  { key: '/settings/intelligence-mappings', label: 'Intelligence', minRole: 'user_admin' },
  { key: '/settings/skills', label: 'Skills', minRole: 'user_admin' },
  { key: POLICY_PACKS_TAB_KEY, label: 'Policy Packs', minRole: 'user_admin' },
  { key: '/settings/tenants', label: 'Tenants', minRole: 'capiro_admin' },
  { key: '/settings/customers', label: 'Customers', minRole: 'capiro_admin' },
  { key: '/settings/broadcasts', label: 'Broadcasts', minRole: 'capiro_admin' },
];

export function visibleSettingsTabs(input: {
  role: TenantRole;
  billingAdmin: boolean;
}): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => {
    if (tab.billingAdminOnly && !input.billingAdmin) return false;
    if (!tab.minRole) return true;
    return ROLE_RANK[input.role] >= ROLE_RANK[tab.minRole];
  });
}

export function isPolicyPacksLocation(pathname: string, search: string): boolean {
  return (
    pathname === '/settings/skills' &&
    new URLSearchParams(search).get('view') === 'policy-packs'
  );
}
