import { Navigate, Route, Routes } from 'react-router-dom';
import { FunnelShell, ScreenTitle, Card } from './ui/primitives';
import { useConfig } from './useConfig';

/**
 * Route map (fills in as the phases land):
 *   Flow 1 funnel:  /register /verify /plan /legal /billing /admins /clients
 *                   /org /confirm                              (Phase 3)
 *   Flow 2A:        /setup (external dashboard), /accept-invite (Phase 4)
 *   IT admin:       /it/:token                                 (Phase 4)
 */
export function App() {
  const config = useConfig();
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/register" replace />} />
      <Route path="*" element={<ComingSoon funnelEnabled={config.funnelEnabled} />} />
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
