import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useClientFilter } from '../../../state/client-filter.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import {
  canonicalEngagementLocation,
  engagementDestination,
  isVNextEngagementPath,
  outreachCampaignIdFromPath,
  type EngagementDestination,
} from './engagement-route-state.js';
import type { EngagementOutreachStep } from './VNextOutreachWorkspace.js';
import { VNextOutreachPhase1Workspace } from './VNextOutreachPhase1Workspace.js';
import { VNextOutreachHome } from './VNextOutreachHome.js';
import { VNextMeetingsWorkspace } from './VNextMeetingsWorkspace.js';
import { VNextMeetingLibrary } from './VNextMeetingLibrary.js';
import { VNextReportsTracker } from './VNextReportsTracker.js';
import { EngagementToastProvider } from './engagement-toast.js';
import { useRovingFocus } from './use-roving-focus.js';
// The module's single z-index ladder. Imported FIRST so the four
// --eng-layer-* aliases are defined before any rule consumes them.
import './engagement-layers.css';
import './engagement.css';
import './engagement-ui-closeout.css';
import './engagement-tones.css';

export { isVNextEngagementPath };

interface IntegrationConnection {
  id: string;
  provider: string;
  status: string;
  accountEmail?: string | null;
  displayName?: string | null;
}

function subline(destination: EngagementDestination, outreachCampaignId?: string | null): string {
  if (destination === 'reports') return 'Auto-populated activity with explicit manual status overrides and CSV export.';
  /*
   * OWNER-scoped, and this line has now been wrong twice.
   *
   * `listMeetingLibrary` applies `ownMeetingWhere(ctx.userId)` —
   * `createdByUserId = me OR connection.createdByUserId = me`. It has never
   * shown the whole firm. Two earlier versions of this string claimed it did
   * ("Only approved or saved materials appear here. Searchable by…", then
   * "Every approved or saved material in the firm…"), because a handoff
   * document asserted tenant scoping and this string was written from the
   * document rather than the query.
   *
   * It also lagged the Library's own subline by a full deploy: that one was
   * corrected while this one shipped the old claim, so the page showed both
   * statements at once. Keep the two in agreement — see
   * VNextMeetingLibrary.tsx.
   */
  if (destination === 'library') return 'Your meetings with at least one approved prep, note or debrief. Search by subject or client; filter by client, date, artifact type and visibility.';
  if (destination === 'meetings') return 'Calendar-synced meetings with prep, notes, Meri join, and client context.';
  if (destination === 'outreach' && !outreachCampaignId) return 'Your campaigns and governed templates. Open one to continue, or start fresh.';
  return 'Governed outreach: goal, targets, delivery, context, immutable drafts, preflight, send.';
}

export function VNextEngagementRoutes() {
  const api = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const clientFilter = useClientFilter();
  const destination = engagementDestination(location.pathname);
  const outreachCampaignId = outreachCampaignIdFromPath(location.pathname);
  const [step, setStep] = useState<EngagementOutreachStep>('goal');
  /* Arrow / Home / End across Meetings | Outreach | Reports. */
  const onTabsKeyDown = useRovingFocus();

  useEffect(() => { setStep('goal'); }, [outreachCampaignId]);
  useEffect(() => {
    const canonical = canonicalEngagementLocation(location.pathname, location.search);
    if (canonical) navigate(canonical, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const integrations = useQuery<IntegrationConnection[]>({
    queryKey: ['engagement-integrations'],
    queryFn: async () => (await api.get<IntegrationConnection[]>('/api/engagement/integrations')).data,
    staleTime: 30_000,
  });
  const activeClients = useMemo(
    () => (clients.data ?? []).filter((client) => client.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name)),
    [clients.data],
  );
  const scopeLabel = activeClients.find((client) => client.id === clientFilter.selectedClientId)?.name ?? 'All clients';
  const navigateTab = (tab: 'meetings' | 'outreach' | 'reports') => {
    if (tab === 'meetings') navigate('/engagement/meetings');
    else if (tab === 'reports') navigate('/engagement/reports?period=current');
    else navigate('/engagement/outreach');
  };

  let body: ReactNode = null;
  switch (destination) {
    case 'outreach':
      body = outreachCampaignId ? (
        <VNextOutreachPhase1Workspace
          sessionId={outreachCampaignId}
          clients={activeClients}
          selectedClientId={clientFilter.selectedClientId}
          integrations={integrations.data ?? []}
          step={step}
          onStepChange={setStep}
          onExit={() => navigate('/engagement/outreach')}
        />
      ) : (
        <VNextOutreachHome
          selectedClientId={clientFilter.selectedClientId}
          onOpenCampaign={(sessionId) => navigate(`/engagement/outreach/${encodeURIComponent(sessionId)}`)}
        />
      );
      break;
    case 'meetings':
      body = (
        <VNextMeetingsWorkspace
          clientId={clientFilter.selectedClientId}
          // `scopeLabel` is already resolved here from the client list this
          // component holds; passing it avoids a second /api/clients read and
          // lets the New meeting composer name the client it inherits.
          clientLabel={clientFilter.selectedClientId ? scopeLabel : null}
        />
      );
      break;
    case 'library': body = <VNextMeetingLibrary />; break;
    case 'reports': body = <VNextReportsTracker clientId={clientFilter.selectedClientId} />; break;
  }

  return (
    <EngagementToastProvider>
      <div className="engagement-vnext" data-destination={destination}>
        <header className="uui-engagement-page-header">
          <div><h1>Engagement</h1><p>{subline(destination, outreachCampaignId)}</p></div>
          <label className="uui-client-scope">
            <span>Client</span><span className="uui-client-scope__value">{scopeLabel}</span><ChevronDown size={16} />
            <select value={clientFilter.selectedClientId ?? ''} onChange={(event) => clientFilter.setSelectedClientId(event.target.value || null)}>
              <option value="">All clients</option>
              {activeClients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
            </select>
          </label>
        </header>
        <div className="uui-engagement-tabs">
          {/*
            These navigate between routes, so they stay a <nav> with
            aria-current="page" rather than becoming a tablist — there are no
            tab panels here, the destination changes the URL. What was missing
            was any keyboard movement (three separate Tab stops, no arrows) and
            any announcement of which destination is current: `data-active` is
            a styling hook and carries no semantics.
          */}
          <nav aria-label="Engagement destinations" onKeyDown={onTabsKeyDown}>
            <button
              type="button"
              data-active={destination === 'meetings' || destination === 'library' || undefined}
              aria-current={destination === 'meetings' || destination === 'library' ? 'page' : undefined}
              onClick={() => navigateTab('meetings')}
            >
              Meetings
            </button>
            <button
              type="button"
              data-active={destination === 'outreach' || undefined}
              aria-current={destination === 'outreach' ? 'page' : undefined}
              onClick={() => navigateTab('outreach')}
            >
              Outreach
            </button>
            <button
              type="button"
              data-active={destination === 'reports' || undefined}
              aria-current={destination === 'reports' ? 'page' : undefined}
              onClick={() => navigateTab('reports')}
            >
              Reports
            </button>
          </nav>
        </div>
        {body}
      </div>
    </EngagementToastProvider>
  );
}
