/**
 * Defense Budget vNext — native workspace shell (evolved from the Program
 * Elements v2 workspace; port of src/pages/program-element/ProgramElementsV2Page.tsx).
 *
 * capiro-internal only (gated in VNextProgramElementsRoutes, reproducing the
 * canonical App.tsx ProgramElementFinderGate). Renders the five destinations
 * (Explore · Movement · Congressional · Actions · Portfolio) under the shared
 * Defense Budget context bar (FY · family · service · search · watched —
 * `defense-budget-context.tsx`); per-line profiles render via the routes
 * module. Program Element is now one budget-line family inside Defense
 * Budget, not the whole product — see
 * `docs/prototypes/defense-budget-vnext-design.md` §1.
 *
 * URL: /program-elements?dest=explore|movement|congressional|actions|portfolio
 * — destination and context-bar scope are URL (query) state, never component
 * state, so deep links and back/forward behave identically to the canonical
 * app. Route path is unchanged from Program Elements — no URL churn for a
 * label/scope change (task-level instruction: preserve the canonical URL).
 *
 * Non-internal tenants are unaffected: they never reach this component (see
 * `VNextProgramElementsRoutes.tsx`'s `isInternal` branch).
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { getProgramElementSummary } from '../../../pages/program-element/api.js';
import { PE_DESTINATIONS, resolvePeDestination, type PeDestination } from './pe-routes.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroTabs } from '../../components/menus/index.js';
import { DefenseBudgetContextBar, DefenseBudgetContextProvider } from './defense-budget-context.js';
import { PeExploreView } from './PeExploreView.js';
import { PeMovementView } from './PeMovementView.js';
import { PeCongressionalView } from './PeCongressionalView.js';
import { PeActionsView } from './PeActionsView.js';
import { PePortfolioView } from './PePortfolioView.js';
import './pe-workspace.css';

const DEST_LABEL: Record<PeDestination, string> = {
  explore: 'Explore',
  movement: 'Movement',
  congressional: 'Congressional',
  actions: 'Actions',
  portfolio: 'Portfolio',
};

export function PeWorkspacePage() {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const dest = resolvePeDestination(searchParams.get('dest'));

  const summary = useQuery({
    queryKey: ['pe-v2-summary'],
    queryFn: () => getProgramElementSummary(api, {}),
    staleTime: 60_000,
  });

  const monitored = summary.data?.watched;
  const openMarkups = summary.data?.openMarkups;

  const go = (d: PeDestination) => {
    const params = new URLSearchParams(searchParams);
    if (d === 'explore') params.delete('dest');
    else params.set('dest', d);
    setSearchParams(params, { replace: true });
  };

  const tabItems = useMemo(
    () => PE_DESTINATIONS.map((d) => ({ id: d, label: DEST_LABEL[d] })),
    [],
  );

  return (
    <DefenseBudgetContextProvider>
      <div className="pe-v2 pe-ws">
        <header className="pe-ws-bar">
          <span className="pe-ws-bar__eyebrow">Defense Budget</span>
          <span className="pe-ws-bar__rule" aria-hidden />
          <CapiroTabs
            items={tabItems}
            activeId={dest}
            onChange={(id) => go(resolvePeDestination(id))}
            label="Defense Budget destinations"
          />
          <span className="pe-ws-spacer" />
          <span className="pe-ws-bar__meta">
            {monitored != null ? <CapiroBadge>{`MONITORED · ${monitored}`}</CapiroBadge> : null}
            {openMarkups ? (
              <CapiroBadge tone="warning">
                {`${openMarkups} OPEN MARKUP${openMarkups === 1 ? '' : 'S'}`}
              </CapiroBadge>
            ) : null}
          </span>
        </header>
        <div className="pe-ws-ctxbar-wrap">
          <DefenseBudgetContextBar />
        </div>
        <div className="pe-ws-panel">
          {dest === 'explore' ? <PeExploreView /> : null}
          {dest === 'movement' ? <PeMovementView /> : null}
          {dest === 'congressional' ? <PeCongressionalView /> : null}
          {dest === 'actions' ? <PeActionsView /> : null}
          {dest === 'portfolio' ? <PePortfolioView /> : null}
        </div>
      </div>
    </DefenseBudgetContextProvider>
  );
}
