import { useMemo } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { Card, Tabs } from 'antd';
import { useMe } from '../../lib/me.js';
import { PolicyPacksPage } from './PolicyPacksPage.js';
import {
  POLICY_PACKS_TAB_KEY,
  isPolicyPacksLocation,
  visibleSettingsTabs,
} from './settings-shared.js';

// Tab model + role filtering extracted to settings-shared.ts (UI-free) so the
// vNext Settings module shares the exact same logic. Re-exported here to keep
// this file's public API unchanged.
export {
  POLICY_PACKS_TAB_KEY,
  SETTINGS_TABS,
  isPolicyPacksLocation,
  visibleSettingsTabs,
  type SettingsTab,
} from './settings-shared.js';

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
