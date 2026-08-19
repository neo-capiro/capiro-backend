/**
 * Settings vNext — module router + layout (purge Phase 2).
 *
 * Claims the whole `/settings` prefix in VNextRouter and reproduces the
 * canonical SettingsLayout contract exactly:
 *   - tabs are role-filtered client-side via the SAME `visibleSettingsTabs`
 *     the canonical layout uses (extracted to pages/settings/settings-shared.ts);
 *     the API's RolesGuard on every endpoint remains the security boundary;
 *   - `/settings` index-redirects to `/settings/personal`;
 *   - Policy Packs stays a query-param tab (`/settings/skills?view=policy-packs`)
 *     rendered in place of the outlet, exactly like canonical;
 *   - an unknown `/settings/<x>` renders the canonical 404 copy (the canonical
 *     tree resolves those to the top-level PlaceholderPage 404).
 *
 * The legacy `/admin`, `/admin/*` and `/capiro-admin` redirects stay canonical
 * `<Navigate>`s in App.tsx — they land on `/settings/...`, which this module
 * then claims, so they need no port.
 */
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { useMe } from '../../../lib/me.js';
import {
  POLICY_PACKS_TAB_KEY,
  isPolicyPacksLocation,
  visibleSettingsTabs,
} from '../../../pages/settings/settings-shared.js';
import { CapiroTabs } from '../../components/menus/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { VNextPersonalPage } from './VNextPersonalPage.js';
import { VNextContactInfoPage } from './VNextContactInfoPage.js';
import { VNextMemorySettingsPage } from './VNextMemorySettingsPage.js';
import { VNextTeamPage } from './VNextTeamPage.js';
import { VNextBrandingPage } from './VNextBrandingPage.js';
import { VNextClientsPage } from './VNextClientsPage.js';
import { VNextIntegrationsPage } from './VNextIntegrationsPage.js';
import { VNextBillingPage } from './VNextBillingPage.js';
import { VNextCustomersPage } from './VNextCustomersPage.js';
import { VNextAiUsagePage } from './VNextAiUsagePage.js';
import { VNextIntelligenceMappingsPage } from './VNextIntelligenceMappingsPage.js';
import { VNextSkillsPage } from './VNextSkillsPage.js';
import { VNextPolicyPacksPage } from './VNextPolicyPacksPage.js';
import { VNextCapiroAdminPage } from './VNextCapiroAdminPage.js';
import './settings-vnext.css';

// Path predicate lives in its own UI-free module (settings-route.ts) so
// VNextRouter can consult the claim without eagerly importing this page tree;
// re-exported here for callers that want both.
export { isVNextSettingsPath } from './settings-route.js';

function VNextSettingsLayout() {
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();

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
    <div className="settings-vnext">
      <header className="stv-header">
        <div>
          <h1>Settings</h1>
          <p>Personal, workspace, and administration preferences.</p>
        </div>
      </header>
      <div className="stv-tabstrip">
        {me.data ? (
          <CapiroTabs
            label="Settings sections"
            items={visibleTabs.map((tab) => ({ id: tab.key, label: tab.label }))}
            activeId={active}
            onChange={(key) => navigate(key)}
          />
        ) : (
          <div className="stv-row" style={{ paddingBottom: 12 }} aria-label="Loading settings tabs">
            <CapiroSkeleton width={72} height={20} />
            <CapiroSkeleton width={88} height={20} />
            <CapiroSkeleton width={72} height={20} />
            <CapiroSkeleton width={64} height={20} />
          </div>
        )}
      </div>
      <div className="stv-body">{policyPacksActive ? <VNextPolicyPacksPage /> : <Outlet />}</div>
    </div>
  );
}

/** Canonical 404 copy (PlaceholderPage) for unknown /settings sub-paths, which
 *  the canonical route tree resolves to the top-level 404. */
function VNextSettingsNotFound() {
  return (
    <div className="settings-vnext">
      <div className="stv-body">
        <CapiroEmptyState title="Not found" description="404 - this page doesn't exist." />
      </div>
    </div>
  );
}

export function VNextSettingsRoutes() {
  return (
    <Routes>
      <Route path="/settings" element={<VNextSettingsLayout />}>
        <Route index element={<Navigate to="/settings/personal" replace />} />
        <Route path="personal" element={<VNextPersonalPage />} />
        <Route path="contact" element={<VNextContactInfoPage />} />
        <Route path="memory" element={<VNextMemorySettingsPage />} />
        <Route path="team" element={<VNextTeamPage />} />
        <Route path="branding" element={<VNextBrandingPage />} />
        <Route path="clients" element={<VNextClientsPage />} />
        <Route path="integrations" element={<VNextIntegrationsPage />} />
        <Route path="billing" element={<VNextBillingPage />} />
        <Route path="customers" element={<VNextCustomersPage />} />
        <Route path="ai-usage" element={<VNextAiUsagePage />} />
        <Route path="intelligence-mappings" element={<VNextIntelligenceMappingsPage />} />
        <Route path="skills" element={<VNextSkillsPage />} />
        <Route path="tenants" element={<VNextCapiroAdminPage />} />
      </Route>
      <Route path="*" element={<VNextSettingsNotFound />} />
    </Routes>
  );
}
