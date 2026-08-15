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
  const loading =
    summary.isLoading ||
    clients.isLoading ||
    model.strategies.isLoading ||
    model.meetings.isLoading;
  const figures = useMemo(() => {
    const clientCount = clients.data?.filter((c) => (c.status ?? '').toLowerCase() !== 'archived').length;
    const s = summary.data;
    return [
      { label: 'Clients', value: clientCount ?? null },
      { label: 'Need attention', value: s?.needAttention ?? null },
      { label: 'Active strategies', value: model.strategies.data?.length ?? null },
      { label: 'Meetings this week', value: model.meetings.data?.length ?? null },
      { label: 'Tracked bills', value: s?.billsTracked ?? null },
    ];
  }, [summary.data, clients.data, model.strategies.data, model.meetings.data]);

  return (
    <section className="capiro-portfolio-pulse capiro-portfolio__surface" aria-label="Portfolio pulse">
      <div className="capiro-portfolio-pulse__head">
        <span className="capiro-portfolio__eyebrow">Portfolio pulse</span>
        <span className="capiro-portfolio-pulse__refresh"><span className="capiro-portfolio-pulse__refresh-dot" /> Refreshed 2 hours ago</span>
      </div>
      <div className="capiro-portfolio-pulse__band">
        {loading ? figures.map((f) => <div className="capiro-portfolio-pulse__stat-skel" key={f.label} />) : summary.isError ? (
          <div className="capiro-portfolio-pulse__error" role="status">Portfolio aggregates are unavailable right now; the client list below is intact.</div>
        ) : figures.map((f) => (
          <div className="capiro-portfolio-pulse__stat" key={f.label}>
            <span className={`capiro-portfolio-pulse__value${f.value == null ? ' is-missing' : ''}`}>{f.value == null ? '—' : f.value.toLocaleString()}</span>
            <span className="capiro-portfolio-pulse__label">{f.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ClientRow({ row, onOpen }: { row: PortfolioRow; onOpen: () => void }) {
  const focus = row.focusTags.slice(0, 2);
  const status = <CapiroBadge tone={STATUS_TONE[row.status]} dot={<span className="capiro-portfolio__dot" />}>{STATUS_LABEL[row.status]}</CapiroBadge>;
  return (
    <tr className="capiro-portfolio__tr" onClick={onOpen}>
      <td>
        <div className="capiro-portfolio__client">
          <span className={`capiro-portfolio__tile${row.name === 'Overland AI' ? ' is-dark' : ''}`} aria-hidden>{initialsFor(row.name)}</span>
          <div className="capiro-portfolio__client-copy">
            <div className="capiro-portfolio__client-name">{row.name}</div>
            <div className="capiro-portfolio__client-status">{status}</div>
            <div className="capiro-portfolio__meta">{[row.sector, row.location].filter(Boolean).join(' · ') || '—'}</div>
          </div>
        </div>
      </td>
      <td>{focus.length ? <div className="capiro-portfolio__tags">{focus.map((t) => <span className="capiro-portfolio__tag" key={t}>{t}</span>)}</div> : <span className="capiro-portfolio__meta">—</span>}</td>
      <td>{row.ownerName ? <div className="capiro-portfolio__owner"><span className="capiro-portfolio__avatar" aria-hidden>{initialsFor(row.ownerName)}</span><span>{row.ownerName}</span></div> : <span className="capiro-portfolio__meta">—</span>}</td>
      <td><span className="capiro-portfolio__work-value">—</span><span className="capiro-portfolio__track" aria-hidden><span /></span></td>
      <td><span className="capiro-portfolio__meta">—</span></td>
      <td><span className="capiro-portfolio__attention">—</span></td>
      <td><span className="capiro-portfolio__meta">—</span></td>
    </tr>
  );
}

function ClientCard({ row, onOpen }: { row: PortfolioRow; onOpen: () => void }) {
  const focus = row.focusTags.slice(0, 2);
  const status = <CapiroBadge tone={STATUS_TONE[row.status]} dot={<span className="capiro-portfolio__dot" />}>{STATUS_LABEL[row.status]}</CapiroBadge>;
  return (
    <button type="button" className="capiro-portfolio__clientcard" onClick={onOpen}>
      <div className="capiro-portfolio__card-main">
        <div className="capiro-portfolio__client">
          <span className={`capiro-portfolio__tile${row.name === 'Overland AI' ? ' is-dark' : ''}`} aria-hidden>{initialsFor(row.name)}</span>
          <div className="capiro-portfolio__client-copy">
            <div className="capiro-portfolio__client-name">{row.name}</div>
            <div className="capiro-portfolio__client-status">{status}</div>
            <div className="capiro-portfolio__meta">{[row.sector, row.location].filter(Boolean).join(' · ') || '—'}</div>
          </div>
        </div>
        <span className="capiro-portfolio__attention">—</span>
      </div>
      <div className="capiro-portfolio__card-focus">
        {focus.length ? focus.map((tag) => <span className="capiro-portfolio__tag" key={tag}>{tag}</span>) : <span className="capiro-portfolio__meta">—</span>}
      </div>
      <div className="capiro-portfolio__card-work"><span className="capiro-portfolio__work-value">—</span><span className="capiro-portfolio__track" aria-hidden><span /></span></div>
      <div className="capiro-portfolio__card-foot">
        {row.ownerName ? <div className="capiro-portfolio__owner"><span className="capiro-portfolio__avatar" aria-hidden>{initialsFor(row.ownerName)}</span><span>{row.ownerName}</span></div> : <span className="capiro-portfolio__meta">—</span>}
        <span className="capiro-portfolio__meta">—</span>
      </div>
    </button>
  );
}

export function PortfolioIndexPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const route = resolvePortfolioRoute(searchParams);
  const model = usePortfolioIndexModel(route);
  const [importOpen, setImportOpen] = useState(searchParams.get('modal') === 'import-lda');
  const setRoute = (patch: Parameters<typeof applyPortfolioRoute>[1]) => setSearchParams(applyPortfolioRoute(searchParams, patch), { replace: true });
  const openClient = (id: string) => navigate(`/clients?clientId=${encodeURIComponent(id)}`);
  const openImport = (open: boolean) => {
    setImportOpen(open);
    const next = new URLSearchParams(searchParams);
    if (open) next.set('modal', 'import-lda'); else next.delete('modal');
    setSearchParams(next, { replace: true });
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['clients'] });
    void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
    void queryClient.invalidateQueries({ queryKey: ['engagement-meetings-week'] });
    void queryClient.invalidateQueries({ queryKey: ['program-element-finder', 'portfolio-watch'] });
  };
  const { clients } = model;
  const showEmpty = !clients.isLoading && !clients.isError && model.visible.length === 0;
  const emptyIsFilter = (clients.data?.length ?? 0) > 0;
  const statusCounts = PORTFOLIO_STATUS_LABELS.map((s) => `${s.label} ${model.counts[s.key]}`).join(' · ');

  return (
    <div className="capiro-portfolio capiro-page">
      <header className="capiro-portfolio__head">
        <div><h1 className="capiro-portfolio__title">Portfolio</h1><p className="capiro-portfolio__sub">Every client account, the work in flight, and the outside signals moving against them.</p></div>
        <span className="capiro-portfolio__head-spacer" />
        <CapiroButton variant="secondary" size="standard" onClick={refresh}>Sources refreshed just now</CapiroButton>
        <CapiroButton variant="secondary" size="standard" onClick={() => openImport(true)}>Import with LDA</CapiroButton>
        <CapiroButton variant="primary" size="standard" onClick={() => navigate('/clients?new=1')}>New client</CapiroButton>
      </header>

      <Pulse model={model} />

      <section className="capiro-portfolio__clients capiro-portfolio__surface" aria-labelledby="capiro-portfolio-clients">
        <div className="capiro-portfolio__clients-toolbar">
          <div className="capiro-portfolio__title-row"><h2 className="capiro-portfolio__section-title" id="capiro-portfolio-clients">Clients</h2><span className="capiro-portfolio__count">{model.rows.length} accounts</span></div>
          <span className="capiro-portfolio__toolbar-spacer" />
          <input className="capiro-portfolio__search" placeholder="Search clients" aria-label="Search clients" value={route.q} onChange={(e) => setRoute({ q: e.target.value })} />
          <div className="capiro-portfolio__layout" role="group" aria-label="Layout"><button type="button" className={`capiro-portfolio__layout-btn${route.layout === 'list' ? ' is-active' : ''}`} onClick={() => setRoute({ layout: 'list' })} aria-label="List view">☰</button><button type="button" className={`capiro-portfolio__layout-btn${route.layout === 'cards' ? ' is-active' : ''}`} onClick={() => setRoute({ layout: 'cards' })} aria-label="Card view">▦</button></div>
        </div>
        <div className="capiro-portfolio__filter-row">
          <div className="capiro-portfolio__filters" role="group" aria-label={`Status filter: ${statusCounts}`}>{PORTFOLIO_STATUS_LABELS.map((s) => <button key={s.key} type="button" className={`capiro-portfolio__filter${route.status === s.key ? ' is-active' : ''}`} onClick={() => setRoute({ status: s.key })}>{s.label}<span className="capiro-portfolio__filter-count">{model.counts[s.key]}</span></button>)}</div>
          <span className="capiro-portfolio__toolbar-spacer" /><span className="capiro-portfolio__eyebrow">Sort</span>
          {PORTFOLIO_SORT_LABELS.map((s) => <button key={s.key} type="button" className={`capiro-portfolio__sort-chip${route.sort === s.key ? ' is-active' : ''}`} onClick={() => setRoute({ sort: s.key })}>{s.label}</button>)}
        </div>

        {clients.isLoading ? <div aria-busy="true"><div className="capiro-portfolio__skeleton" style={{ height: 320 }} /></div> : clients.isError ? <div className="capiro-portfolio__state capiro-portfolio__state--error" role="status"><span>Clients could not be loaded.{clients.error instanceof Error ? ` (${clients.error.message})` : ''}</span><CapiroButton variant="quiet" size="compact" onClick={() => void clients.refetch()}>Retry</CapiroButton></div> : showEmpty ? <div className="capiro-portfolio__state" role="status">{emptyIsFilter ? <><span>No clients match the current search and filters.</span><button type="button" className="capiro-portfolio__linkbtn" onClick={() => setRoute({ q: '', status: 'all' })}>Clear search and filters</button></> : 'No clients yet. Add one with New client, or import several with Import with LDA.'}</div> : route.layout === 'list' ? (
          <div className="capiro-portfolio__table-wrap"><table className="capiro-portfolio__table"><thead><tr><th>Client</th><th>Focus</th><th>Owner</th><th>Work</th><th>Intelligence</th><th>Attention</th><th>Next touch</th></tr></thead><tbody>{model.visible.map((row) => <ClientRow key={row.client.id} row={row} onOpen={() => openClient(row.client.id)} />)}</tbody></table><div className="capiro-portfolio__footer">Showing {model.visible.length} of {model.rows.length} clients · sorted by {route.sort}</div></div>
        ) : (
          <div className="capiro-portfolio__cards">{model.visible.map((row) => <ClientCard key={row.client.id} row={row} onOpen={() => openClient(row.client.id)} />)}</div>
        )}
      </section>

      <PortfolioProgramElements />
      <ImportWithLdaModal open={importOpen} onClose={() => openImport(false)} />
    </div>
  );
}
