import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { FunnelShell, ScreenTitle, Card } from './ui/primitives';
import { useConfig } from './useConfig';
import { FunnelStepGuard, type FunnelRoute } from './pages/funnel/FunnelStepGuard';
import { RegisterPage } from './pages/funnel/RegisterPage';
import { VerifyPage } from './pages/funnel/VerifyPage';
import { PlanPage } from './pages/funnel/PlanPage';
import { LegalPage } from './pages/funnel/LegalPage';
import { BillingPage } from './pages/funnel/BillingPage';
import { AdminsPage } from './pages/funnel/AdminsPage';
import { ClientsPage } from './pages/funnel/ClientsPage';
import { OrgPage } from './pages/funnel/OrgPage';
import { ConfirmPage } from './pages/funnel/ConfirmPage';
import { SetupDashboardPage } from './pages/setup/SetupDashboardPage';
import { AcceptInvitePage } from './pages/setup/AcceptInvitePage';
import { ItAdminPage } from './pages/it/ItAdminPage';
import { ItDonePage } from './pages/it/ItDonePage';
import { ItErrorPage } from './pages/it/ItErrorPage';

/**
 * Route map:
 *   Flow 1 funnel:  /register /verify /plan /legal /billing /admins /clients
 *                   /org /confirm                     (gated by funnelEnabled)
 *   Flow 2A:        /setup (dashboard), /accept-invite
 *   IT admin:       /it/done /it/error /it/:token (unauthenticated; must work
 *                   even when funnelEnabled is false — live tenants' IT links
 *                   and invited admins never touch the Flow-1 funnel)
 */
export function App() {
  const config = useConfig();
  const guarded = (route: FunnelRoute, element: ReactElement) => (
    <FunnelStepGuard route={route}>{element}</FunnelStepGuard>
  );
  return (
    <Routes>
      {/* Flow-2A + IT routes render regardless of funnelEnabled. */}
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route path="/setup" element={<SetupDashboardPage />} />
      {/* Terminal pages first so they match before the :token catch. */}
      <Route path="/it/done" element={<ItDonePage />} />
      <Route path="/it/error" element={<ItErrorPage />} />
      <Route path="/it/:token" element={<ItAdminPage />} />
      {config.funnelEnabled ? (
        <>
          <Route path="/" element={<Navigate to="/register" replace />} />
          <Route path="/register" element={guarded('/register', <RegisterPage />)} />
          <Route path="/verify" element={guarded('/verify', <VerifyPage />)} />
          <Route path="/plan" element={guarded('/plan', <PlanPage />)} />
          <Route path="/legal" element={guarded('/legal', <LegalPage />)} />
          <Route path="/billing" element={guarded('/billing', <BillingPage />)} />
          <Route path="/admins" element={guarded('/admins', <AdminsPage />)} />
          <Route path="/clients" element={guarded('/clients', <ClientsPage />)} />
          <Route path="/org" element={guarded('/org', <OrgPage />)} />
          <Route path="/confirm" element={guarded('/confirm', <ConfirmPage />)} />
          <Route path="*" element={<Navigate to="/register" replace />} />
        </>
      ) : (
        <>
          <Route path="/" element={<Navigate to="/register" replace />} />
          <Route path="*" element={<ComingSoon funnelEnabled={config.funnelEnabled} />} />
        </>
      )}
    </Routes>
  );
}

function ComingSoon({ funnelEnabled }: { funnelEnabled: boolean }) {
  return (
    <FunnelShell step={null} maxWidth={460}>
      <Card style={{ textAlign: 'center', padding: '40px 36px' }}>
        <ScreenTitle
          title="Self-service onboarding is almost here"
          sub={
            funnelEnabled
              ? 'This step of the onboarding experience ships in the next release.'
              : 'Onboarding is not yet open. Reach us at sales@capiro.ai for a guided setup.'
          }
        />
      </Card>
    </FunnelShell>
  );
}
