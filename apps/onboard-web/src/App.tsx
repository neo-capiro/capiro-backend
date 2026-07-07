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
import { SetupPage } from './pages/funnel/SetupPage';

/**
 * Route map (fills in as the phases land):
 *   Flow 1 funnel:  /register /verify /plan /legal /billing /admins /clients
 *                   /org /confirm                              (this phase)
 *   Flow 2A:        /setup (placeholder), /accept-invite       (Phase 4)
 *   IT admin:       /it/:token                                 (Phase 4)
 */
export function App() {
  const config = useConfig();
  if (!config.funnelEnabled) {
    return (
      <Routes>
        <Route path="/" element={<Navigate to="/register" replace />} />
        <Route path="*" element={<ComingSoon funnelEnabled={config.funnelEnabled} />} />
      </Routes>
    );
  }
  const guarded = (route: FunnelRoute, element: ReactElement) => (
    <FunnelStepGuard route={route}>{element}</FunnelStepGuard>
  );
  return (
    <Routes>
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
      <Route path="/setup" element={<SetupPage />} />
      <Route path="*" element={<Navigate to="/register" replace />} />
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
