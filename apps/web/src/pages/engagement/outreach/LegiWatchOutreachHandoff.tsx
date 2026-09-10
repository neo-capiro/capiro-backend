import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button } from 'antd';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useAuth } from '@clerk/clerk-react';
import { useImpersonation } from '../../../state/impersonation.js';
import type { Client } from '../../clients/clientTypes.js';
import { NewOutreachWizard, type OutreachSenderInbox } from './v2/NewOutreachWizard.js';
import {
  clearLegiWatchHandoff,
  prefillToWizardState,
  readLegiWatchHandoff,
  validateLegiWatchPrefill,
} from './legiwatch-prefill.js';

/** Review a fresh, tenant-authorized hearing before opening an unsaved V2 campaign. */
export function LegiWatchOutreachHandoff({ clients, aiConfigured }: {
  clients: Client[];
  aiConfigured: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const api = useApi();
  const { isLoaded, userId, orgId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const qc = useQueryClient();
  const { modal } = App.useApp();
  const [startedIdentity, setStartedIdentity] = useState<string | null>(null);
  const [handoff] = useState(() => {
    const params = new URLSearchParams(location.search);
    return readLegiWatchHandoff(params.get('client'), params.get('hearingId'), params.get('contextId'));
  });
  const staged = handoff.ok ? handoff.handoff : null;
  const clientId = staged?.prefill.clientId;
  const hearingId = staged?.prefill.context.hearing.id;
  const insightId = staged?.prefill.context.finding?.id;
  const segmentId = staged?.prefill.context.transcriptMoment?.id;
  const identity = JSON.stringify([userId, orgId, actAsTenantSlug]);

  const hearing = useQuery({
    queryKey: ['legiwatch-outreach-review', identity, clientId, hearingId, insightId, segmentId, staged?.id],
    enabled: Boolean(staged && isLoaded && userId),
    queryFn: async ({ signal }) => {
      // Never promote cached browser text into campaign evidence. This existing
      // endpoint rechecks client tenancy and hearing/finding/segment membership.
      const { data } = await api.post<unknown>(
        `/api/legiwatch/live-hearings/events/${encodeURIComponent(hearingId!)}/actions/outreach-prefill`,
        { clientId, ...(insightId ? { insightId } : {}), ...(segmentId ? { segmentId } : {}) },
        { signal },
      );
      if (!validateLegiWatchPrefill(data, clientId!, hearingId!) ||
          data.context.finding?.id !== insightId || data.context.transcriptMoment?.id !== segmentId) {
        throw new Error('The hearing details do not match the selected hearing and client.');
      }
      return data;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const integrations = useQuery({
    queryKey: ['engagement-integrations', 'legiwatch-review', identity],
    enabled: Boolean(isLoaded && userId),
    queryFn: async () => (await api.get<Array<OutreachSenderInbox & { status: string }>>('/api/engagement/integrations')).data,
  });
  const inboxes = (integrations.data ?? []).filter((row) => row.status === 'connected' &&
    ['microsoft_365', 'google_workspace'].includes(row.provider));
  const prefill = useMemo(() => hearing.data ? prefillToWizardState(hearing.data) : null, [hearing.data]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('capiro:workflow-lock', { detail: { locked: true } }));
    return () => { window.dispatchEvent(new CustomEvent('capiro:workflow-lock', { detail: { locked: false } })); };
  }, []);

  const exit = () => {
    if (staged) clearLegiWatchHandoff(staged.id);
    navigate('/engagement/outreach', { replace: true });
  };
  if (!handoff.ok || hearing.isError) {
    return <section role="alert">
      <h2>Hearing outreach could not be opened</h2>
      <p>{!handoff.ok ? handoff.message : 'The hearing or selected client could not be verified. Return to LegiWatch and stage outreach again.'}</p>
      {handoff.ok && isLoaded && userId ? <Button onClick={() => { void hearing.refetch(); }}>Try again</Button> : null}
      <Link to={hearingId ? `/legiwatch/hearings/${encodeURIComponent(hearingId)}` : '/legiwatch'}>Return to LegiWatch</Link>
    </section>;
  }
  if (!prefill || !hearing.data || hearing.isFetching) return <p role="status">Checking the hearing and selected client…</p>;

  if (startedIdentity === identity) {
    return <NewOutreachWizard
      key={identity}
      clients={clients}
      selectedClientId={prefill.clientId}
      initialPrefill={prefill}
      aiConfigured={aiConfigured}
      emailConnected={inboxes.length > 0}
      sendFrom={inboxes.find((row) => row.accountEmail)?.accountEmail ?? null}
      sendableInboxes={inboxes}
      onCancel={() => modal.confirm({ title: 'Discard this unsaved campaign?', content: 'Your unsaved edits will be discarded.', onOk: exit })}
      onComplete={() => { void qc.invalidateQueries({ queryKey: ['engagement-outreach'] }); exit(); }}
      onDraftSaved={(id) => {
        clearLegiWatchHandoff(staged!.id);
        navigate(`/engagement/outreach/draft/${encodeURIComponent(id)}`, { replace: true });
      }}
    />;
  }
  return <section aria-labelledby="legiwatch-outreach-review-title">
    <h2 id="legiwatch-outreach-review-title">Review hearing outreach</h2>
    <p>For {hearing.data.clientName}</p>
    <h3>{hearing.data.context.hearing.title}</h3>
    <p style={{ whiteSpace: 'pre-wrap' }}>{prefill.contextItems[0].note}</p>
    <p>Continue to an unsaved campaign with this client and hearing context attached. Nothing has been created or sent. Save as draft in the campaign to keep your edits.</p>
    <Button type="primary" onClick={() => setStartedIdentity(identity)}>Continue to campaign</Button>
    <Button onClick={exit}>Cancel</Button>
  </section>;
}
