import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import { ImportWithLdaModal } from './ImportWithLdaModal.js';
import { PortfolioProgramElements } from './PortfolioProgramElements.js';
import {
  PORTFOLIO_SORT_LABELS,
  PORTFOLIO_STATUS_LABELS,
  applyPortfolioRoute,
  resolvePortfolioRoute,
} from './portfolio-routing.js';
import { usePortfolioIndexModel, type PortfolioRow } from './usePortfolioIndexModel.js';
import './portfolio.css';

/**
 * Portfolio index (PORTFOLIO-HANDOFF §7.1). Four bands:
 *   1. Page header — title, description, Sources refreshed / Import with LDA /
 *      New client.
 *   2. Portfolio pulse — deep-surface aggregate band.
 *   3. Clients — search, status filters, sort, list ⇄ cards, the table.
 *   4. Program elements — portfolio-wide budget lines.
 *
 * ⚠ NEW DESIGN — not present in screens 01–18; requires product sign-off
 * (§7.1, DoD). Built here against real endpoints. Readiness / attention-per-row
 * columns that would need N+1 per-client calls are omitted and logged in
 * GAPS.md (G3) rather than assembled with eight requests per page load.
 */

const STATUS_TONE: Record<PortfolioRow['status'], 'success' | 'warning' | 'info'> = {
  active: 'success',
  'at-risk': 'warning',
  prospect: 'info',
};
const STATUS_LABEL: Record<PortfolioRow['status'], string> = {
  active: 'Active',
  'at-risk': 'At risk',
  prospect: 'Prospect',
};

function Pulse({ model }: { model: ReturnType<typeof usePortfolioIndexModel> }) {
  const { summary, clients } = model;
  const loading = summary.isLoading || clients.isLoading;
  const figures = useMemo(() => {
    const clientCount = clients.data?.filter((c) => (c.status ?? '').toLowerCase() !== 'archived').length;
    const s = summary.data;
    return [
      { label: 'Clients', value: clientCount ?? null },
      { label: 'Need attention', value: s?.needAttention ?? null },
      { label: 'Tracked bills', value: s?.billsTracked ?? null },
      { label: 'Active regulations', value: s?.activeRegulations ?? null },
    ];
  }, [summary.data, clients.data]);

  return (
    <section className="capiro-portfolio-pulse" aria-label="Portfolio pulse">
      <div className="capiro-portfolio-pulse__band">
        {loading ? (
          <>
            <div className="capiro-portfolio-pulse__stat-skel" />
            <div className="capiro-portfolio-pulse__stat-skel" />
            <div className="capiro-portfolio-pulse__stat-skel" />
            <div className="capiro-portfolio-pulse__stat-skel" />
          </>
        ) : summary.isError ? (
          <div className="capiro-portfolio-pulse__error" role="status">
            Portfolio aggregates are unavailable right now; the client list below is intact.
          </div>
        ) : (
          figures.map((f) => (
            <div className="capiro-portfolio-pulse__stat" key={f.label}>
              <span className="capiro-portfolio-pulse__value">
                {f.value == null ? '—' : f.value.toLocaleString()}
              </span>
              <span className="capiro-portfolio-pulse__label">{f.label}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function ClientRow({ row, onOpen }: { row: PortfolioRow; onOpen: () => void }) {
  return (
    <tr className="capiro-portfolio__tr" onClick={onOpen}>
      <td>
        <div className="capiro-portfolio__client">
          <span className="capiro-portfolio__tile" aria-hidden>
            {initialsFor(row.name)}
          </span>
          <div>
            <div className="capiro-portfolio__client-name">{row.name}</div>
            <div className="capiro-portfolio__meta">
              {[row.sector, row.location].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
        </div>
      </td>
      <td>
        <CapiroBadge tone={STATUS_TONE[row.status]} dot={<span className="capiro-portfolio__dot" />}>
          {STATUS_LABEL[row.status]}
        </CapiroBadge>
      </td>
      <td>
        {row.focusTags.length ? (
          <div className="capiro-portfolio__tags">
            {row.focusTags.map((t) => (
              <span className="capiro-portfolio__tag" key={t}>
                {t}
              </span>
            ))}
          </div>
        ) : (
          <span className="capiro-portfolio__meta">—</span>
        )}
      </td>
      <td>
        {row.ownerName ? (
          <div className="capiro-portfolio__owner">
            <span className="capiro-portfolio__avatar" aria-hidden>
              {initialsFor(row.ownerName)}
            </span>
            <span>{row.ownerName}</span>
          </div>
        ) : (
          <span className="capiro-portfolio__meta">—</span>
        )}
      </td>
    </tr>
  );
}

export function PortfolioIndexPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const route = resolvePortfolioRoute(searchParams);
  const model = usePortfolioIndexModel(route);
  const [importOpen, setImportOpen] = useState(searchParams.get('modal') === 'import-lda');

  const setRoute = (patch: Parameters<typeof applyPortfolioRoute>[1]) =>
    setSearchParams(applyPortfolioRoute(searchParams, patch), { replace: true });

  const openClient = (id: string) => navigate(`/clients?clientId=${encodeURIComponent(id)}`);
  const openImport = (open: boolean) => {
    setImportOpen(open);
    const next = new URLSearchParams(searchParams);
    if (open) next.set('modal', 'import-lda');
    else next.delete('modal');
    setSearchParams(next, { replace: true });
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['clients'] });
    void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['program-element-finder', 'portfolio-watch'] });
  };

  const { clients } = model;
  const showEmpty = !clients.isLoading && !clients.isError && model.visible.length === 0;
  const emptyIsFilter = (clients.data?.length ?? 0) > 0;

  return (
    <div className="capiro-portfolio capiro-page">
      {/* 1 · Page header */}
      <header className="capiro-portfolio__head">
        <div>
          <h1 className="capiro-portfolio__title">Portfolio</h1>
          <p className="capiro-portfolio__sub">
            Every client, its work and its intelligence in one place.
          </p>
        </div>
        <span className="capiro-portfolio__head-spacer" />
        <CapiroButton variant="secondary" size="standard" onClick={refresh}>
          Sources refreshed just now
        </CapiroButton>
        <CapiroButton variant="secondary" size="standard" onClick={() => openImport(true)}>
          Import with LDA
        </CapiroButton>
        <CapiroButton variant="primary" size="standard" onClick={() => navigate('/clients?new=1')}>
          New client
        </CapiroButton>
      </header>

      {/* 2 · Portfolio pulse */}
      <Pulse model={model} />

      {/* 3 · Clients */}
      <section className="capiro-portfolio__clients" aria-labelledby="capiro-portfolio-clients">
        <div className="capiro-portfolio__clients-toolbar">
          <h2 className="capiro-portfolio__section-title" id="capiro-portfolio-clients">
            Clients
          </h2>
          <input
            className="capiro-portfolio__search"
            placeholder="Search clients"
            aria-label="Search clients"
            value={route.q}
            onChange={(e) => setRoute({ q: e.target.value })}
          />
          <div className="capiro-portfolio__filters" role="group" aria-label="Status filter">
            {PORTFOLIO_STATUS_LABELS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`capiro-portfolio__filter${
                  route.status === s.key ? ' is-active' : ''
                }`}
                onClick={() => setRoute({ status: s.key })}
              >
                {s.label}
                <span className="capiro-portfolio__filter-count">{model.counts[s.key]}</span>
              </button>
            ))}
          </div>
          <label className="capiro-portfolio__sort">
            <span className="capiro-portfolio__meta">Sort</span>
            <select
              value={route.sort}
              onChange={(e) => setRoute({ sort: e.target.value as typeof route.sort })}
              aria-label="Sort clients"
            >
              {PORTFOLIO_SORT_LABELS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <div className="capiro-portfolio__layout" role="group" aria-label="Layout">
            <button
              type="button"
              className={`capiro-portfolio__layout-btn${route.layout === 'list' ? ' is-active' : ''}`}
              onClick={() => setRoute({ layout: 'list' })}
              aria-label="List layout"
            >
              ☰
            </button>
            <button
              type="button"
              className={`capiro-portfolio__layout-btn${route.layout === 'cards' ? ' is-active' : ''}`}
              onClick={() => setRoute({ layout: 'cards' })}
              aria-label="Card layout"
            >
              ▦
            </button>
          </div>
        </div>

        {clients.isLoading ? (
          <div aria-busy="true">
            <div className="capiro-portfolio__skeleton" style={{ height: 320 }} />
          </div>
        ) : clients.isError ? (
          <div className="capiro-portfolio__state capiro-portfolio__state--error" role="status">
            <span>
              Clients could not be loaded.
              {clients.error instanceof Error ? ` (${clients.error.message})` : ''}
            </span>
            <CapiroButton variant="quiet" size="compact" onClick={() => void clients.refetch()}>
              Retry
            </CapiroButton>
          </div>
        ) : showEmpty ? (
          <div className="capiro-portfolio__state" role="status">
            {emptyIsFilter ? (
              <>
                No clients match the current search and filters.{' '}
                <button
                  type="button"
                  className="capiro-portfolio__linkbtn"
                  onClick={() => setRoute({ q: '', status: 'all' })}
                >
                  Clear search and filters
                </button>
              </>
            ) : (
              'No clients yet. Add one with New client, or import several with Import with LDA.'
            )}
          </div>
        ) : route.layout === 'list' ? (
          <div className="capiro-portfolio__table-wrap">
            <table className="capiro-portfolio__table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Focus</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {model.visible.map((row) => (
                  <ClientRow key={row.client.id} row={row} onOpen={() => openClient(row.client.id)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="capiro-portfolio__cards">
            {model.visible.map((row) => (
              <button
                key={row.client.id}
                type="button"
                className="capiro-portfolio__clientcard capiro-elevation-widget"
                onClick={() => openClient(row.client.id)}
              >
                <div className="capiro-portfolio__client">
                  <span className="capiro-portfolio__tile" aria-hidden>
                    {initialsFor(row.name)}
                  </span>
                  <div>
                    <div className="capiro-portfolio__client-name">{row.name}</div>
                    <div className="capiro-portfolio__meta">
                      {[row.sector, row.location].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                </div>
                <CapiroBadge tone={STATUS_TONE[row.status]} dot={<span className="capiro-portfolio__dot" />}>
                  {STATUS_LABEL[row.status]}
                </CapiroBadge>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 4 · Program elements */}
      <PortfolioProgramElements />

      <ImportWithLdaModal open={importOpen} onClose={() => openImport(false)} />
    </div>
  );
}
