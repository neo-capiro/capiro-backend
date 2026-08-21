/**
 * vNext Engagement module router — STAGED ROLLOUT (Library phase,
 * 2026-08-16).
 *
 * Adapted from `origin/agent/engagement-complete-gpt56`'s
 * `VNextEngagementRoutes.tsx` (`git show origin/agent/engagement-complete-gpt56:apps/web/src/vnext/pages/engagement/VNextEngagementRoutes.tsx`),
 * which rendered a fully-forked alternate Engagement shell (its own New
 * Meeting modal, a hidden Overview, and a debug "State Inspector") over four
 * destinations that all already had native vNext bodies. On this branch,
 * Outreach, Meetings and now Library do — Reports keeps its real work for a
 * later phase of this reskin.
 * Deliberately NOT ported from the reference:
 *   - The reference's own New Meeting modal / hidden Overview — this phase's
 *     VNextMeetingsWorkspace brings its own minimal New Meeting composer
 *     (EngagementDialog-based) instead; the hidden Overview stays unbuilt.
 *   - The "State Inspector" — a debug/prototype affordance (its own eyebrow
 *     read "Engagement · prototype"), not part of the production surface.
 *   - The mailbox-connection banner — meeting-notetaking-specific messaging;
 *     still not wired at the router level even though Meetings now exists,
 *     since it's a self-contained banner with no dependency on this file.
 * What IS kept: the module-level header (title + client scope) and the
 * Meetings/Outreach/Reports tab strip, using the `uui-engagement-page-header`
 * / `uui-client-scope` / `uui-engagement-tabs` classes engagement.css already
 * defines for exactly this purpose. Without them, a user landing on any vNext
 * destination would have no way to switch tabs or change the client scope —
 * dropping them would be a real regression, not a simplification.
 *
 * `VNextRouter` only mounts this component when `isVNextEngagementPath`
 * returns true (currently: Outreach, Meetings and Library — see
 * `ENGAGEMENT_DESTINATION_READY` in engagement-route-state.ts), so the
 * `reports` case below is unreachable today. It exists so the render switch
 * stays exhaustive and so promoting Reports later is additive: build the
 * real component, import it here, add its case, flip its flag in
 * engagement-route-state.ts. No other routing change, and no change to
 * VNextRouter.tsx, is required.
 */
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
import { VNextOutreachOperatorWorkspace } from './VNextOutreachOperatorWorkspace.js';
import { VNextOutreachHome } from './VNextOutreachHome.js';
import { VNextMeetingsWorkspace } from './VNextMeetingsWorkspace.js';
import { VNextMeetingLibrary } from './VNextMeetingLibrary.js';
import { VNextReportsTracker } from './VNextReportsTracker.js';
import { EngagementToastProvider } from './engagement-toast.js';
import './engagement.css';
import './engagement-ui-closeout.css';
// Tone table (eng-pill classes) — established in the foundations commit but
// never actually imported anywhere until this phase's Meetings status pills
// became its first consumer. Loaded once here (router level) rather than
// per-destination, matching how engagement.css itself is loaded here — later
// Library/Reports/drawer phases share this same import, per this file's own
// header comment about its scope.
import './engagement-tones.css';

export { isVNextEngagementPath };

/** Same shape IntegrationsPage / AppShell / VNextOutreachWorkspace read from
 *  /api/engagement/integrations. */
interface IntegrationConnection {
  id: string;
  provider: string;
  status: string;
  accountEmail?: string | null;
  displayName?: string | null;
}

function subline(destination: EngagementDestination, outreachCampaignId?: string | null): string {
  if (destination === 'reports') {
    return 'Auto-populated activity with explicit manual status overrides and CSV export.';
  }
  if (destination === 'library') {
    // Literal design-doc copy (design README §8 / the mockup's own per-route
    // paragraph) — NOT the same text `heroSubs.library` uses in
    // `Capiro Engagement - Untitled UI.dc.html`, which is stale/wrong (it
    // still reads "Approved prep, notes, debriefs, and shared attachments
    // across clients.", not this route's own real subline).
    return 'Only approved or saved materials appear here. Searchable by client, date, artifact type, and visibility.';
  }
  if (destination === 'meetings') {
    return 'Calendar-synced meetings with prep, notes, Meri join, and client context.';
  }
  if (destination === 'outreach' && !outreachCampaignId) {
    return 'Your draft and sent campaigns. Open one to continue, or start a new campaign.';
  }
  return 'Governed outreach: goal, targets, delivery, context, immutable drafts, preflight, send.';
}

export function VNextEngagementRoutes() {
  const api = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const clientFilter = useClientFilter();
  const destination = engagementDestination(location.pathname);
  // null → the Outreach home (campaign list); an id → that campaign's builder.
  const outreachCampaignId = outreachCampaignIdFromPath(location.pathname);
  const [step, setStep] = useState<EngagementOutreachStep>('goal');

  // Entering a different campaign must not inherit the step the previous one
  // was left on — `step` is per-campaign UI state living in this shell.
  useEffect(() => {
    setStep('goal');
  }, [outreachCampaignId]);

  // Ported from the reference implementation (see engagement-route-state.ts
  // for why this is currently a no-op for every URL this component actually
  // mounts for): normalizes legacy query-string/path shapes without any
  // per-destination special-casing here.
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
    queryFn: async () =>
      (await api.get<IntegrationConnection[]>('/api/engagement/integrations')).data,
    staleTime: 30_000,
  });

  const activeClients = useMemo(
    () =>
      (clients.data ?? [])
        .filter((client) => client.status !== 'archived')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [clients.data],
  );

  const scopeLabel =
    activeClients.find((client) => client.id === clientFilter.selectedClientId)?.name ??
    'All clients';

  const navigateTab = (tab: 'meetings' | 'outreach' | 'reports') => {
    if (tab === 'meetings') navigate('/engagement/meetings');
    else if (tab === 'reports') navigate('/engagement/reports?period=current');
    else navigate('/engagement/outreach');
  };

  let body: ReactNode = null;
  switch (destination) {
    case 'outreach':
      body = outreachCampaignId ? (
        <VNextOutreachOperatorWorkspace
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
          onOpenCampaign={(sessionId) =>
            navigate(`/engagement/outreach/${encodeURIComponent(sessionId)}`)
          }
        />
      );
      break;
    case 'meetings':
      body = <VNextMeetingsWorkspace clientId={clientFilter.selectedClientId} />;
      break;
    case 'library':
      // Library owns its own client/type/visibility filters (each with a
      // real dropdown-button + URL-persisted state — see
      // VNextMeetingLibrary.tsx), independent of the shell's client-scope
      // selector above, so it takes no props.
      body = <VNextMeetingLibrary />;
      break;
    case 'reports':
      body = <VNextReportsTracker clientId={clientFilter.selectedClientId} />;
      break;
  }

  return (
    <EngagementToastProvider>
      <div className="engagement-vnext" data-destination={destination}>
        <header className="uui-engagement-page-header">
          <div>
            <h1>Engagement</h1>
            <p>{subline(destination, outreachCampaignId)}</p>
          </div>
          {/* Content-width scope control (UI-parity §3.1). The visible value
              is painted by the span so the box hugs its content; the real
              <select> is laid over the control at zero opacity and still
              owns keyboard/AT behaviour. */}
          <label className="uui-client-scope">
            <span>Client</span>
            <span className="uui-client-scope__value">{scopeLabel}</span>
            <ChevronDown size={16} />
            <select
              value={clientFilter.selectedClientId ?? ''}
              onChange={(event) => clientFilter.setSelectedClientId(event.target.value || null)}
            >
              <option value="">All clients</option>
              {activeClients.map((client) => (
                <option value={client.id} key={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
        </header>
        <div className="uui-engagement-tabs">
          <nav aria-label="Engagement destinations">
            <button
              type="button"
              data-active={destination === 'meetings' || destination === 'library' || undefined}
              onClick={() => navigateTab('meetings')}
            >
              Meetings
            </button>
            <button
              type="button"
              data-active={destination === 'outreach' || undefined}
              onClick={() => navigateTab('outreach')}
            >
              Outreach
            </button>
            <button
              type="button"
              data-active={destination === 'reports' || undefined}
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
