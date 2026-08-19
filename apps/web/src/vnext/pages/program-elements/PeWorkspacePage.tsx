/**
 * Program Elements vNext — native workspace shell (port of
 * src/pages/program-element/ProgramElementsV2Page.tsx).
 *
 * capiro-internal only (gated in VNextProgramElementsRoutes, reproducing the
 * canonical App.tsx ProgramElementFinderGate). Renders the five v2
 * destinations (Explore · Movement · Congressional · Actions · Portfolio);
 * per-line profiles render via the routes module.
 *
 * URL: /program-elements?dest=explore|movement|congressional|actions|portfolio
 * — destination is URL (query) state, never component state, so deep links and
 * back/forward behave identically to the canonical app.
 *
 * NOTE the destination bar stays an UNCLASSED inline-styled first child of
 * `.pe-v2`: pe-vnext.css's responsive layer targets
 * `.pe-v2 > div:first-child:not([class])` to let it wrap on narrow viewports.
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { getProgramElementSummary } from '../../../pages/program-element/api.js';
import { PE_DESTINATIONS, resolvePeDestination, type PeDestination } from './pe-routes.js';
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

  const destBar = useMemo(
    () => (
      <div
        style={{
          height: 44,
          flex: 'none',
          background: 'var(--pev2-canvas)',
          borderBottom: '1px solid var(--pev2-border-strong)',
          display: 'flex',
          alignItems: 'stretch',
          padding: '0 20px',
          gap: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
          <span className="pe-v2-eyebrow" style={{ letterSpacing: '0.1em' }}>
            Program elements
          </span>
          <span style={{ width: 1, height: 16, background: 'var(--pev2-control)' }} />
        </div>
        {PE_DESTINATIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => go(d)}
            aria-current={dest === d ? 'page' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: 13.5,
              cursor: 'pointer',
              flex: 'none',
              borderBottom: `2px solid ${dest === d ? 'var(--pev2-ink)' : 'transparent'}`,
              color: dest === d ? 'var(--pev2-ink)' : 'var(--pev2-secondary)',
              fontWeight: dest === d ? 700 : 500,
            }}
          >
            {DEST_LABEL[d]}
          </button>
        ))}
        <div style={{ flex: 1, minWidth: 8 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>
            {monitored != null ? `MONITORED · ${monitored}` : ''}
            {openMarkups ? ` · ${openMarkups} OPEN MARKUP${openMarkups === 1 ? '' : 'S'}` : ''}
          </span>
        </div>
      </div>
    ),
    [dest, monitored, openMarkups],
  );

  return (
    <div className="pe-v2" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {destBar}
      <div style={{ flex: 1, minHeight: 0 }}>
        {dest === 'explore' ? <PeExploreView /> : null}
        {dest === 'movement' ? <PeMovementView /> : null}
        {dest === 'congressional' ? <PeCongressionalView /> : null}
        {dest === 'actions' ? <PeActionsView /> : null}
        {dest === 'portfolio' ? <PePortfolioView /> : null}
      </div>
    </div>
  );
}
