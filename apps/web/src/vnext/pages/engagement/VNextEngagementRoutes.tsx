import { useEffect, useMemo, useRef } from 'react';
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
  type EngagementDestination,
} from './engagement-route-state.js';
import { VNextOutreachClassic } from './VNextOutreachClassic.js';
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

function subline(destination: EngagementDestination): string {
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
  /*
   * One subline for the whole Outreach destination, list and wizard alike.
   * Outreach on this surface is Classic Outreach (the V2 wizard) as of
   * 2026-09-03 — see VNextOutreachClassic.tsx. The copy names what the
   * landing actually shows: the draft and sent record list.
   */
  return 'Your draft and sent campaigns. Open one to continue, or start a new campaign.';
}

export function VNextEngagementRoutes() {
  const api = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const clientFilter = useClientFilter();
  const destination = engagementDestination(location.pathname);
  const previousScope = useRef<{ locationKey: string; clientId: string | null } | null>(null);
  const libraryParams = new URLSearchParams(location.search);
  // Explicit links and browser history restore their scope. A change from the
  // shared shell selector on the same URL takes precedence until serialized.
  const globalScopeChanged = previousScope.current !== null
    && previousScope.current.clientId !== clientFilter.selectedClientId
    && previousScope.current.locationKey === location.key;
  const selectedClientId = destination === 'library' && libraryParams.has('client') && !globalScopeChanged
    ? libraryParams.get('client') || null
    : clientFilter.selectedClientId;
  /* Arrow / Home / End across Meetings | Outreach | Reports. */
  const onTabsKeyDown = useRovingFocus();

  useEffect(() => {
    const canonical = canonicalEngagementLocation(location.pathname, location.search);
    if (canonical) navigate(canonical, { replace: true });
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    previousScope.current = { locationKey: location.key, clientId: selectedClientId };
    if (destination !== 'library') return;
    if (clientFilter.selectedClientId !== selectedClientId) {
      clientFilter.setSelectedClientId(selectedClientId);
    }
    const params = new URLSearchParams(location.search);
    if (params.has('client') && (params.get('client') || null) === selectedClientId) return;
    // Keep an explicit empty value for All clients; an absent parameter means
    // entering Library should inherit the current global scope.
    if (params.has('client')) params.delete('page');
    params.set('client', selectedClientId ?? '');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [destination, location.key, location.pathname, location.search, selectedClientId,
    clientFilter.selectedClientId, clientFilter.setSelectedClientId, navigate]);

  function selectClient(clientId: string | null) {
    clientFilter.setSelectedClientId(clientId);
    if (destination !== 'library') return;
    const params = new URLSearchParams(location.search);
    params.set('client', clientId ?? '');
    params.delete('page');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const activeClients = useMemo(
    () => (clients.data ?? []).filter((client) => client.status !== 'archived' || client.id === selectedClientId).sort((a, b) => a.name.localeCompare(b.name)),
    [clients.data, selectedClientId],
  );
  const scopeLabel = activeClients.find((client) => client.id === selectedClientId)?.name ?? (selectedClientId ? 'Selected client' : 'All clients');
  const navigateTab = (tab: 'meetings' | 'outreach' | 'reports') => {
    if (tab === 'meetings') navigate('/engagement/meetings');
    else if (tab === 'reports') navigate('/engagement/reports?period=current');
    else navigate('/engagement/outreach');
  };

  let body: ReactNode = null;
  switch (destination) {
    case 'outreach':
      /*
       * Classic Outreach (V2) — owner decision 2026-09-03. The whole
       * `/engagement/outreach/*` subtree (landing list, `/new/wizard`,
       * `/draft/:id`, `/draft-v3/:id`) is one component that reads and
       * writes its own mode from the URL, exactly as on app.capiro.ai. The
       * V3 builder (`VNextOutreachCampaignBuilder` / `VNextOutreachHome`)
       * stays in the tree but is no longer mounted here.
       */
      body = (
        <VNextOutreachClassic
          clients={activeClients}
          selectedClientId={clientFilter.selectedClientId}
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
    case 'library': body = <VNextMeetingLibrary clientId={selectedClientId} clientLabel={scopeLabel} onClientChange={selectClient} />; break;
    case 'reports': body = <VNextReportsTracker clientId={clientFilter.selectedClientId} />; break;
  }

  return (
    <EngagementToastProvider>
      <div className="engagement-vnext" data-destination={destination}>
        <header className="uui-engagement-page-header">
          <div><h1>Engagement</h1><p>{subline(destination)}</p></div>
          <label className="uui-client-scope">
            <span>Client</span><span className="uui-client-scope__value">{scopeLabel}</span><ChevronDown size={16} />
            <select value={selectedClientId ?? ''} onChange={(event) => selectClient(event.target.value || null)}>
              <option value="">All clients</option>
              {selectedClientId && !activeClients.some((client) => client.id === selectedClientId) && <option value={selectedClientId}>{scopeLabel}</option>}
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
