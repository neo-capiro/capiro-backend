// '/setup' placeholder — the firm setup dashboard replaces this in Phase 4.
import { Card, FunnelShell, ScreenTitle } from '../../ui/primitives';

export function SetupPage() {
  return (
    <FunnelShell step={null} maxWidth={460}>
      <Card style={{ textAlign: 'center', padding: '40px 36px' }}>
        <ScreenTitle
          title="Your setup dashboard is next"
          sub="The firm setup dashboard ships in the next release step."
        />
      </Card>
    </FunnelShell>
  );
}
