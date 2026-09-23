/**
 * Program Elements vNext — Portfolio surface (native port of
 * src/pages/program-element/v2/PeV2Portfolio.tsx).
 * Monitored budget lines + the clients they touch: 4 metric cells, then cards.
 * Data: watched list + summary aggregates + per-card client relevance.
 *
 * Phase 4 polish: vNext card chrome, `CapiroSelect` filters, `CapiroBadge`
 * classification chips and `CapiroButton` actions. Same queries, same sort and
 * client-filter semantics, same metric definitions and copy.
 */
import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { getProgramElementsList } from '../../../pages/program-element/api.js';
import { getRelevantClientsForPe } from '../../../pages/clients/relevance-api.js';
import { useActionsList } from '../../../pages/actions/actions-api.js';
import { money, spct, stageLabelShort, toLineRow } from '../../../pages/program-element/v2/pe-v2-model.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { FilterControl, PeSkeletonBlock } from './pe-primitives.js';
import { familyById, serviceToApiParam, useDefenseBudgetContext } from './defense-budget-context.js';
import { DefenseBudgetFamilyCoverageNote } from './defense-budget-coverage.js';
import { useMe } from '../../../lib/me.js';

const SORT_OPTIONS = ['MOVEMENT', 'CURRENT', 'CODE'];
const CLOSED = new Set(['dismissed', 'archived']);

export function PePortfolioView() {
  const me = useMe();
  const api = useApi();
  const navigate = useNavigate();
  const ctx = useDefenseBudgetContext();
  const family = familyById(ctx.family);
  const [sort, setSort] = useState('MOVEMENT');
  const [clientFilter, setClientFilter] = useState('ALL');

  const familyQueryable = family.id === 'All' || !!family.lineType;
  const watched = useQuery({
    queryKey: ['pe-v2-portfolio', family.lineType, serviceToApiParam(ctx.service)],
    queryFn: () =>
      getProgramElementsList(api, {
        watched: 'true',
        line_type: family.lineType,
        service: serviceToApiParam(ctx.service),
        page: 1,
        limit: 100,
      }),
    enabled: familyQueryable,
    staleTime: 60_000,
  });
  const actions = useActionsList({ page: 1, limit: 100 });

  const lines = useMemo(
    () => (familyQueryable ? (watched.data?.data ?? []).map(toLineRow) : []),
    [familyQueryable, watched.data],
  );

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
    <div data-screen-label="Portfolio" className="pe-ws-view">
      <div className="pe-v2-page-head">
        <div className="pe-ws-head__text">
          <div className="pe-v2-page-title">Portfolio</div>
          <div className="pe-v2-page-sub">Monitored budget lines and the clients they touch.</div>
        </div>
        <div className="pe-ws-head__actions pe-ws-head__actions--fields">
          <FilterControl label="Client" value={clientFilter} options={clientNames} onChange={setClientFilter} />
          <FilterControl label="Sort" value={sort} options={SORT_OPTIONS} onChange={setSort} />
        </div>
      </div>

      <div className="pe-ws-body">
        {me.data?.tenant.slug === 'capiro-internal' && family.id !== 'All' ? (
          <DefenseBudgetFamilyCoverageNote familyId={family.id} fy={ctx.fy} />
        ) : null}

        <section className="pe-v2-card pe-ws-metrics">
          {metrics.map((m) => (
            <div key={m.k} className="pe-ws-metric">
              <div className="pe-ws-cap pe-ws-cap--strong">{m.k}</div>
              <div className="pe-ws-metric__value">{watched.isLoading ? '…' : m.v}</div>
              {m.sub ? <div className="pe-ws-cap">{m.sub}</div> : null}
            </div>
          ))}
        </section>

        {!familyQueryable ? null : watched.isLoading ? (
          <section className="pe-v2-card">
            <div className="pe-ws-pad">
              <PeSkeletonBlock rows={4} />
            </div>
          </section>
        ) : cards.length === 0 ? (
          <section className="pe-v2-card">
            <div className="pe-ws-pad pe-ws-pad--tall">
              <CapiroEmptyState
                title={
                  clientFilter === 'ALL'
                    ? 'No monitored budget lines yet. Monitor a line from Explore to pin it here.'
                    : `No monitored lines linked to ${clientFilter}.`
                }
              />
            </div>
          </section>
        ) : (
          <div className="pe-v2-pf-grid">
            {cards.map(({ line, clients: cls, openActions: open }) => (
              <article key={line.code} className="pe-v2-pf-card">
                <div className="pe-ws-cap pe-ws-cap--strong">{line.code}</div>
                <button
                  type="button"
                  className="pe-ws-pf-title"
                  onClick={() => navigate(`/program-elements/${encodeURIComponent(line.code)}`)}
                >
                  {line.title}
                </button>
                <div className="pe-ws-cap">
                  {(line.service ?? '').toUpperCase()}
                  {line.lineType ? ` · ${line.lineType.replace('RDTE_PE', 'RDT&E').replace('PROCUREMENT_BLIN', 'PROC').replace('OM_BLI', 'O&M')}` : ''}
                  {line.budgetActivity ? ` · ${line.budgetActivity}` : ''}
                </div>
                <div className="pe-ws-pf-stats">
                  <div>
                    <div className="pe-ws-cap">Current</div>
                    <div className="pe-ws-pf-stat">{money(line.current)}</div>
                  </div>
                  <div>
                    <div className="pe-ws-cap">Δ request</div>
                    <div
                      className={`pe-ws-pf-stat${
                        line.delta == null
                          ? ' is-missing'
                          : line.delta > 0
                            ? ' is-up'
                            : line.delta < 0
                              ? ' is-down'
                              : ' is-flat'
                      }`}
                    >
                      {line.pct == null ? '—' : line.pct === 0 ? 'NO CHANGE' : spct(line.pct)}
                    </div>
                  </div>
                  <div>
                    <div className="pe-ws-cap">Stage</div>
                    <div className="pe-ws-pf-stat pe-ws-pf-stat--mono">{stageLabelShort(line.currentStage)}</div>
                  </div>
                </div>
                <p className="pe-ws-pf-clients">
                  {cls.length
                    ? `${cls.length} client${cls.length === 1 ? '' : 's'} · ${open || 'no'} open action${open === 1 ? '' : 's'}`
                    : 'No client linked'}
                  {cls.length && cls[0] ? ` — ${cls[0].clientName}${cls.length > 1 ? ` +${cls.length - 1}` : ''}` : ''}
                </p>
                <div className="pe-ws-pf-foot">
                  <CapiroBadge tone={line.delta != null && line.delta !== 0 ? 'info' : 'neutral'}>
                    {line.delta != null && line.delta !== 0 ? 'OFFICIAL CHANGE' : 'NO MATERIAL CHANGE'}
                  </CapiroBadge>
                  <span className="pe-ws-spacer" />
                  <CapiroButton
                    size="compact"
                    onClick={() => navigate(`/program-elements/${encodeURIComponent(line.code)}`)}
                  >
                    Open
                  </CapiroButton>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
