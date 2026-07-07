// 1.8 Client Import Preference — F1Import (prototype/02-flow1.jsx). The
// self-service copy reflects the real LDA-filings import (not CSV/CRM).
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, FunnelShell, OptionCard, ScreenTitle, Tag } from '../../ui/primitives';
import {
  useAdvanceSession,
  useFunnelApi,
  useFunnelSession,
  type FunnelSession,
  type ImportMode,
} from '../../lib/funnel';
import { ErrorText, errorMessage } from './shared';

export function ClientsPage() {
  const session = useFunnelSession();
  if (!session.data) return null;
  return <F1Import session={session.data} />;
}

function F1Import({ session }: { session: FunnelSession }) {
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();
  const [importMode, setImportMode] = React.useState<ImportMode | null>(session.importMode ?? null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!importMode || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.setImportPref(importMode);
      advanceSession({ state: 'import_pref', importMode });
      navigate('/org');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <FunnelShell step={6} maxWidth={720}>
      <ScreenTitle title="How would you like to bring in your clients?" />
      <div style={{ display: 'flex', gap: 16, alignItems: 'stretch' }}>
        <OptionCard
          selected={importMode === 'self'}
          onClick={() => setImportMode('self')}
          title="Self-service"
        >
          Import your clients straight from your firm's LDA filings — each lands with its federal
          data pre-linked. Available immediately in your setup dashboard.
        </OptionCard>
        <OptionCard
          selected={importMode === 'managed'}
          onClick={() => setImportMode('managed')}
          title="Capiro-managed"
          badge={<Tag tone="blue">White-glove</Tag>}
        >
          Our team handles it for you. We'll reach out within one business day to collect your
          portfolio.
        </OptionCard>
      </div>
      {error && <ErrorText style={{ textAlign: 'right' }}>{error}</ErrorText>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
        <Btn variant="primary" disabled={!importMode || busy} onClick={() => void submit()}>
          Continue
        </Btn>
      </div>
    </FunnelShell>
  );
}
