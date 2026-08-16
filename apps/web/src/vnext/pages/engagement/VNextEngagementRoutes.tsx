/**
 * vNext Engagement module router — STAGED ROLLOUT (foundations phase,
 * 2026-08-16).
 *
 * Adapted from `origin/agent/engagement-complete-gpt56`'s
 * `VNextEngagementRoutes.tsx` (`git show origin/agent/engagement-complete-gpt56:apps/web/src/vnext/pages/engagement/VNextEngagementRoutes.tsx`),
 * which rendered a fully-forked alternate Engagement shell (its own New
 * Meeting modal, a hidden Overview, and a debug "State Inspector") over four
 * destinations that all already had native vNext bodies. On this branch only
 * Outreach does — Meetings/Meeting Library/Reports keep their real work for
 * later phases of this reskin, and per this phase's scope this component
 * only needs to host the one destination that's actually ready today.
 * Deliberately NOT ported from the reference:
 *   - The New Meeting modal and hidden Overview reference — Meetings-only
 *     concerns with nothing to attach to until VNextMeetingsWorkspace exists.
 *   - The "State Inspector" — a debug/prototype affordance (its own eyebrow
 *     read "Engagement · prototype"), not part of the production surface.
 *   - The mailbox-connection banner — meeting-notetaking-specific messaging,
 *     not needed for Outreach alone.
 * What IS kept: the module-level header (title + client scope) and the
 * Meetings/Outreach/Reports tab strip, using the `uui-engagement-page-header`
 * / `uui-client-scope` / `uui-engagement-tabs` classes engagement.css already
 * defines for exactly this purpose. Without them, a user landing on the vNext
 * Outreach view would have no way back to Meetings/Reports or to change the
 * client scope — dropping them would be a real regression, not a
 * simplification.
 *
 * `VNextRouter` only mounts this component when `isVNextEngagementPath`
 * returns true (currently: Outreach paths only — see
 * `ENGAGEMENT_DESTINATION_READY` in engagement-route-state.ts), so the
 * `meetings` / `library` / `reports` cases below are unreachable today. They
 * exist so the render switch stays exhaustive and so promoting a destination
 * later is additive: build the real component, import it here, add its case,
 * flip its flag in engagement-route-state.ts. No other routing change, and
 * no change to VNextRouter.tsx, is required.
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
  type EngagementDestination,
} from './engagement-route-state.js';
import { VNextOutreachWorkspace, type EngagementOutreachStep } from './VNextOutreachWorkspace.js';
import './engagement.css';
import './engagement-ui-closeout.css';

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

function subline(destination: EngagementDestination): string {
  if (destination === 'reports') {
    return 'Auto-populated activity with explicit manual status overrides and CSV export.';
  }
  if (destination === 'library') {
    return 'Approved prep, notes, debriefs, and shared attachments across clients.';
  }
  if (destination === 'meetings') {
    return 'Calendar-synced meetings with prep, notes, Meri join, and client context.';
  }
  return 'Governed outreach: goal, targets, delivery, context, immutable drafts, preflight, send.';
}

export function VNextEngagementRoutes() {
  const api = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const clientFilter = useClientFilter();
  const destination = engagementDestination(location.pathname);
  const [step, setStep] = useState<EngagementOutreachStep>('goal');

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

  const navigateTab = (tab: 'meetings' | 'outreach' | 'reports') => {
    if (tab === 'meetings') navigate('/engagement/meetings');
    else if (tab === 'reports') navigate('/engagement/reports?period=current');
    else navigate('/engagement/outreach');
  };

  let body: ReactNode = null;
  switch (destination) {
    case 'outreach':
      body = (
        <VNextOutreachWorkspace
          clients={activeClients}
          selectedClientId={clientFilter.selectedClientId}
          integrations={integrations.data ?? []}
          step={step}
          onStepChange={setStep}
        />
      );
      break;
    case 'meetings':
    case 'library':
    case 'reports':
      // Pending — see the staged-rollout comment above and
      // ENGAGEMENT_DESTINATION_READY in engagement-route-state.ts.
      // Unreachable today: isVNextEngagementPath only claims 'outreach', so
      // VNextRouter falls through to the canonical EngagementPage (still
      // inside this same vNext shell) for these three destinations.
      body = null;
      break;
  }

  return (
    <div className="engagement-vnext" data-destination={destination}>
      <header className="uui-engagement-page-header">
        <div>
          <h1>Engagement</h1>
          <p>{subline(destination)}</p>
        </div>
        <label className="uui-client-scope">
          <span>Client</span>
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
          <ChevronDown size={15} />
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
  );
}
