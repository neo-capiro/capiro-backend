import { useMemo } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { Card, Tabs } from 'antd';
import { ROLE_RANK, type TenantRole } from '@capiro/shared';
import { useMe } from '../../lib/me.js';
import { PolicyPacksPage } from './PolicyPacksPage.js';

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

/**
 * Settings is the single home for both personal and admin configuration.
 * Tabs are filtered by the caller's role. Policy Packs is an administrator-only
 * authoring and review surface; all lifecycle and authorization decisions remain
 * enforced by the API.
 */
export function SettingsLayout() {
  const me = useMe();
  const location = useLocation();
  const visibleTabs = useMemo(
    () =>
      me.data
        ? visibleSettingsTabs({ role: me.data.role, billingAdmin: me.data.billingAdmin })
        : [],
    [me.data],
  );
  const policyPacksActive = isPolicyPacksLocation(location.pathname, location.search);
  const active =
    (policyPacksActive && visibleTabs.some((tab) => tab.key === POLICY_PACKS_TAB_KEY)
      ? POLICY_PACKS_TAB_KEY
      : visibleTabs.find((tab) => location.pathname.startsWith(tab.key))?.key) ??
    visibleTabs[0]?.key ??
    '/settings/personal';

  return (
    <section className="settings-shell">
      <Card className="settings-panel" bordered={false}>
        <Tabs
          className="settings-tabs"
          activeKey={active}
          items={visibleTabs.map((tab) => ({
            key: tab.key,
            label: <Link to={tab.key}>{tab.label}</Link>,
          }))}
        />
        <div className="settings-content">
          {policyPacksActive ? <PolicyPacksPage /> : <Outlet />}
        </div>
      </Card>
    </section>
  );
}
