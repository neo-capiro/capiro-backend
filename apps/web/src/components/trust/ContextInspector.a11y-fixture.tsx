import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ContextInspector, type TrustContextPacket } from './ContextInspector.js';

const standardPacket: TrustContextPacket = {
  packetId: '11111111-2222-4333-8444-555555555555',
  persisted: true,
  compiledAt: '2026-07-31T18:00:00.000Z',
  items: [
    {
      id: 'firm-compass',
      label: 'Firm Compass',
      type: 'firm-compass',
      scope: 'firm',
      authority: 'firm_approved',
      status: 'active',
      selection: 'automatic',
      rationale: 'Approved firm guidance applies to this response.',
    },
    {
      id: 'unknown-authority',
      label: 'Future authority fixture',
      type: 'client-compass',
      scope: 'client',
      clientName: 'Accessibility Test Client',
      authority: 'future_internal_authority',
      status: 'future_internal_state',
      selection: 'explicit',
    },
  ],
  exclusions: [
    {
      id: 'visible-superseded',
      label: 'Superseded playbook',
      type: 'playbook',
      reason: 'superseded',
    },
    {
      id: 'restricted-identity-must-not-render',
      label: 'Restricted identity must not render',
      type: 'client-compass',
      reason: 'unauthorized',
    },
  ],
};

const degradedPacket: TrustContextPacket = {
  persisted: false,
  persistenceErrorCode: 'context_packet_error',
  compiledAt: '2026-07-31T18:01:00.000Z',
  items: [],
  exclusions: [],
  degraded: true,
  degradedReason: 'A required context source could not be loaded for this fixture.',
};

function Fixture() {
  return (
    <div
      style={{
        maxWidth: 760,
        margin: '40px auto',
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        color: '#15161a',
      }}
    >
      <h1>Context Inspector accessibility fixture</h1>
      <p>
        Tab to each disclosure. Verify visible focus, Enter and Space toggling, unique headings,
        aggregate-only restricted exclusions, and screen-reader announcements.
      </p>

      <ContextInspector
        packet={standardPacket}
        label="Primary response context"
        onReviewContext={() => window.alert('Review context fixture action')}
      />

      <ContextInspector packet={degradedPacket} label="Degraded response context" />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Context Inspector accessibility fixture root is missing.');

createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
