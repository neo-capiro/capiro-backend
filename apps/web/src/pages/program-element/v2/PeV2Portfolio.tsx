/**
 * Program Elements v2 — Portfolio surface.
 * Monitored budget lines + the clients they touch: 4 metric cells, then cards.
 * Data: watched list + summary aggregates + per-card client relevance.
 */
import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Skeleton } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { getProgramElementsList } from '../api.js';
import { getRelevantClientsForPe } from '../../clients/relevance-api.js';
import { useActionsList } from '../../actions/actions-api.js';
import { money, spct, stageLabelShort, toLineRow } from './pe-v2-model.js';
import { FilterControl } from './pe-v2-primitives.js';

const SORT_OPTIONS = ['MOVEMENT', 'CURRENT', 'CODE'];
const CLOSED = new Set(['dismissed', 'archived']);

export function PeV2Portfolio() {
  const api = useApi();
  const navigate = useNavigate();
  const [sort, setSort] = useState('MOVEMENT');
  const [clientFilter, setClientFilter] = useState('ALL');

  const watched = useQuery({
    queryKey: ['pe-v2-portfolio'],
    queryFn: () =>
      getProgramElementsList(api, { watched: 'true', page: 1, limit: 100 }),
    staleTime: 60_000,
  });
  const actions = useActionsList({ page: 1, limit: 100 });

  const lines = useMemo(() => (watched.data?.data ?? []).map(toLineRow), [watched.data]);

  const clientQueries = useQueries({
    queries: lines.map((l) => ({
      queryKey: ['pe-v2-row-clients', l.code],
      queryFn: () => getRelevantClientsForPe(api, l.code),
      staleTime: 5 * 60_000,
    })),
  });

  const openActionsByPe = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of actions.data?.data ?? []) {
      if (a.peCode && !CLOSED.has(a.status)) map.set(a.peCode, (map.get(a.peCode) ?? 0) + 1);
    }
    return map;
  }, [actions.data]);

  const cards = useMemo(() => {
    let out = lines.map((l, i) => ({
      line: l,
      clients: clientQueries[i]?.data ?? [],
      openActions: openActionsByPe.get(l.code) ?? 0,
    }));
    if (clientFilter !== 'ALL') {
      out = out.filter((c) => c.clients.some((cl) => cl.clientName === clientFilter));
    }
    if (sort === 'MOVEMENT') {
      out = [...out].sort((a, b) => Math.abs(b.line.delta ?? 0) - Math.abs(a.line.delta ?? 0));
    } else if (sort === 'CURRENT') {
      out = [...out].sort((a, b) => (b.line.current ?? 0) - (a.line.current ?? 0));
    } else {
      out = [...out].sort((a, b) => a.line.code.localeCompare(b.line.code));
    }
    return out;
  }, [lines, clientQueries, openActionsByPe, sort, clientFilter]);

  const clientNames = useMemo(() => {
    const set = new Set<string>();
    for (const cq of clientQueries) for (const c of cq.data ?? []) set.add(c.clientName);
    return ['ALL', ...[...set].sort()];
  }, [clientQueries]);

  const totalCurrent = lines.reduce((a, l) => a + (l.current ?? 0), 0);
  const moved = lines.filter((l) => l.delta != null && l.delta !== 0).length;
  const noPos = lines.filter((l) => l.current == null).length;
  const openTotal = [...openActionsByPe.values()].reduce((a, b) => a + b, 0);

  const metrics = [
    { k: 'MONITORED LINES', v: String(lines.length), sub: '' },
    {
      k: 'FY CURRENT POSITION',
      v: money(totalCurrent),
      sub: noPos ? `${noPos} LINE${noPos === 1 ? '' : 'S'} WITH NO ASSERTED POSITION` : 'ALL LINES ASSERTED',
    },
    { k: 'MATERIAL MOVEMENT', v: String(moved), sub: 'LINES CHANGED VS REQUEST' },
    {
      k: 'CLIENTS AFFECTED',
      v: String(clientNames.length - 1),
      sub: `${openTotal} OPEN ACTION${openTotal === 1 ? '' : 'S'}`,
    },
  ];

  return (
    <div data-screen-label="Portfolio">
      <div className="pe-v2-page-head">
        <div style={{ flex: 1, minWidth: 340 }}>
          <div className="pe-v2-page-title">Portfolio</div>
          <div className="pe-v2-page-sub">Monitored budget lines and the clients they touch.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none', paddingTop: 6 }}>
          <FilterControl label="Client" value={clientFilter} options={clientNames} onChange={setClientFilter} />
          <FilterControl label="Sort" value={sort} options={SORT_OPTIONS} onChange={setSort} />
        </div>
      </div>

      <div style={{ padding: '20px 24px 0' }}>
        <div
          className="pe-v2-card"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))' }}
        >
          {metrics.map((m, i) => (
            <div
              key={m.k}
              style={{
                padding: '15px 18px',
                borderRight: i < metrics.length - 1 ? '1px solid var(--pev2-border)' : 'none',
              }}
            >
              <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.08em' }}>
                {m.k}
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.015em', marginTop: 7 }}>
                {watched.isLoading ? '…' : m.v}
              </div>
              {m.sub ? (
                <div className="pe-v2-mono" style={{ fontSize: 11, color: 'var(--pev2-secondary)', marginTop: 5 }}>
                  {m.sub}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: '20px 24px 28px' }}>
        {watched.isLoading ? (
          <div className="pe-v2-card" style={{ padding: 24 }}>
            <Skeleton active paragraph={{ rows: 4 }} />
          </div>
        ) : cards.length === 0 ? (
          <div className="pe-v2-card pe-v2-empty" style={{ padding: '32px 24px' }}>
            {clientFilter === 'ALL'
              ? 'No monitored budget lines yet. Monitor a line from Explore to pin it here.'
              : `No monitored lines linked to ${clientFilter}.`}
          </div>
        ) : (
          <div className="pe-v2-pf-grid">
            {cards.map(({ line, clients: cls, openActions: open }) => (
              <div key={line.code} className="pe-v2-pf-card">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span
                    className="pe-v2-mono"
                    style={{
                      fontSize: 11.5,
                      letterSpacing: '0.05em',
                      color: 'var(--pev2-secondary)',
                      flex: 1,
                    }}
                  >
                    {line.code}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(`/program-elements/${encodeURIComponent(line.code)}`)}
                  style={{
                    fontSize: 15.5,
                    fontWeight: 700,
                    lineHeight: 1.28,
                    color: 'var(--pev2-ink)',
                    marginTop: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {line.title}
                </button>
                <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)', marginTop: 5 }}>
                  {(line.service ?? '').toUpperCase()}
                  {line.lineType ? ` · ${line.lineType.replace('RDTE_PE', 'RDT&E').replace('PROCUREMENT_BLIN', 'PROC').replace('OM_BLI', 'O&M')}` : ''}
                  {line.budgetActivity ? ` · ${line.budgetActivity}` : ''}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3,minmax(0,1fr))',
                    gap: 12,
                    marginTop: 14,
                    paddingTop: 12,
                    borderTop: '1px solid var(--pev2-hairline)',
                  }}
                >
                  <div>
                    <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>Current</div>
                    <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{money(line.current)}</div>
                  </div>
                  <div>
                    <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>Δ request</div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        marginTop: 4,
                        color:
                          line.delta == null
                            ? 'var(--pev2-warning)'
                            : line.delta > 0
                              ? 'var(--pev2-success)'
                              : line.delta < 0
                                ? 'var(--pev2-ink)'
                                : 'var(--pev2-secondary)',
                      }}
                    >
                      {line.pct == null ? '—' : line.pct === 0 ? 'NO CHANGE' : spct(line.pct)}
                    </div>
                  </div>
                  <div>
                    <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>Stage</div>
                    <div className="pe-v2-mono" style={{ fontSize: 12, fontWeight: 600, marginTop: 5, color: 'var(--pev2-ink)' }}>
                      {stageLabelShort(line.currentStage)}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--pev2-body)', marginTop: 12 }}>
                  {cls.length
                    ? `${cls.length} client${cls.length === 1 ? '' : 's'} · ${open || 'no'} open action${open === 1 ? '' : 's'}`
                    : 'No client linked'}
                  {cls.length && cls[0] ? ` — ${cls[0].clientName}${cls.length > 1 ? ` +${cls.length - 1}` : ''}` : ''}
                </div>
                <div style={{ flex: 1, minHeight: 10 }} />
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    marginTop: 13,
                    paddingTop: 12,
                    borderTop: '1px solid var(--pev2-hairline)',
                    flexWrap: 'wrap',
                  }}
                >
                  <span className={`pe-v2-cls ${line.delta != null && line.delta !== 0 ? 'official' : ''}`}>
                    {line.delta != null && line.delta !== 0 ? 'OFFICIAL CHANGE' : 'NO MATERIAL CHANGE'}
                  </span>
                  <span style={{ flex: 1, minWidth: 6 }} />
                  <button
                    type="button"
                    className="pe-v2-btn pe-v2-btn-sm"
                    onClick={() => navigate(`/program-elements/${encodeURIComponent(line.code)}`)}
                  >
                    Open
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}