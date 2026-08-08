/**
 * Program Elements v2 — workspace shell.
 *
 * capiro-internal only (gated at the route level in App.tsx). Renders the five
 * v2 destinations (Explore · Movement · Congressional · Actions · Portfolio)
 * under App Shell v2's bands; per-line profiles render PeV2ProfilePage.
 *
 * URL: /program-elements?dest=explore|movement|congressional|actions|portfolio
 * (compare view + legacy params are preserved for the legacy surface only)
 */
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { getProgramElementSummary } from './api.js';
import { PeV2Explore } from './v2/PeV2Explore.js';
import { PeV2Movement } from './v2/PeV2Movement.js';
import { PeV2Congressional } from './v2/PeV2Congressional.js';
import { PeV2Actions } from './v2/PeV2Actions.js';
import { PeV2Portfolio } from './v2/PeV2Portfolio.js';
import './v2/pe-v2.css';

type Dest = 'explore' | 'movement' | 'congressional' | 'actions' | 'portfolio';

const DESTS: Array<{ key: Dest; label: string }> = [
  { key: 'explore', label: 'Explore' },
  { key: 'movement', label: 'Movement' },
  { key: 'congressional', label: 'Congressional' },
  { key: 'actions', label: 'Actions' },
  { key: 'portfolio', label: 'Portfolio' },
];

function readDest(v: string | null): Dest {
  return DESTS.some((d) => d.key === v) ? (v as Dest) : 'explore';
}

export function ProgramElementsV2Page() {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const dest = readDest(searchParams.get('dest'));

  const summary = useQuery({
    queryKey: ['pe-v2-summary'],
    queryFn: () => getProgramElementSummary(api, {}),
    staleTime: 60_000,
  });

  const monitored = summary.data?.watched;
  const openMarkups = summary.data?.openMarkups;

  const go = (d: Dest) => {
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
        {DESTS.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => go(d.key)}
            aria-current={dest === d.key ? 'page' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: 13.5,
              cursor: 'pointer',
              flex: 'none',
              borderBottom: `2px solid ${dest === d.key ? 'var(--pev2-ink)' : 'transparent'}`,
              color: dest === d.key ? 'var(--pev2-ink)' : 'var(--pev2-secondary)',
              fontWeight: dest === d.key ? 700 : 500,
            }}
          >
            {d.label}
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
        {dest === 'explore' ? <PeV2Explore /> : null}
        {dest === 'movement' ? <PeV2Movement /> : null}
        {dest === 'congressional' ? <PeV2Congressional /> : null}
        {dest === 'actions' ? <PeV2Actions /> : null}
        {dest === 'portfolio' ? <PeV2Portfolio /> : null}
      </div>
    </div>
  );
}
