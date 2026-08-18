import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { hasAtLeast } from '@capiro/shared';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import { useApi } from '../../../lib/use-api.js';
import type { MeResponse } from '../../../lib/me.js';
import type { AxiosInstance } from 'axios';
import type { Client, ClientFormSubmit } from '../../../pages/clients/clientTypes.js';
import { ClientFormDialogVNext } from '../client-crm/ClientFormDialogVNext.js';
import { ImportWithLdaModal } from './ImportWithLdaModal.js';
import { PortfolioProgramElements } from './PortfolioProgramElements.js';
import {
  PORTFOLIO_SORT_LABELS,
  PORTFOLIO_STATUS_LABELS,
  applyPortfolioRoute,
  resolvePortfolioRoute,
} from './portfolio-routing.js';
import { usePortfolioIndexModel, type PortfolioRow } from './usePortfolioIndexModel.js';
import { formatDateShort, formatMoney, formatNumber } from '../../lib/labels.js';
import './portfolio.css';

/* ── S3 upload helpers (mirror ClientWorkspacePage exactly) ───────────────── */

async function uploadToS3(presigned: { url: string; fields: Record<string, string> }, file: File) {
  const form = new FormData();
  for (const [key, value] of Object.entries(presigned.fields)) form.append(key, value);
  form.append('file', file);
  const response = await fetch(presigned.url, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
}

async function uploadClientLogo(api: AxiosInstance, clientId: string, file: File) {
  const presigned = (
    await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
      `/api/clients/${clientId}/logo/upload-url`,
      { contentType: file.type, contentLength: file.size },
    )
  ).data;
  await uploadToS3(presigned, file);
  await api.post(`/api/clients/${clientId}/logo/confirm`, {
    s3Key: presigned.s3Key,
    contentType: file.type,
  });
}

async function uploadClientDocuments(api: AxiosInstance, clientId: string, files: File[]) {
  for (const file of files) {
    const presigned = (
      await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
        '/api/engagement/attachments/upload-url',
        { clientId, contentType: file.type, contentLength: file.size },
      )
    ).data;
    await uploadToS3(presigned, file);
    await api.post('/api/engagement/attachments/confirm', {
      s3Key: presigned.s3Key,
      clientId,
      contentType: file.type,
      filename: file.name,
    });
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}

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

/**
 * Freshest dataUpdatedAt across the queries the pulse band reads.
 * `dataUpdatedAt` is 0 until a query first resolves — that zero means
 * "never", not the epoch, so it is skipped rather than fed to the max.
 * Returns 0 when nothing has resolved yet.
 */
function freshestUpdatedAt(model: ReturnType<typeof usePortfolioIndexModel>): number {
  const stamps = [
    model.summary.dataUpdatedAt,
    model.clients.dataUpdatedAt,
    model.strategies.dataUpdatedAt,
    model.meetings.dataUpdatedAt,
    model.accountOwners.dataUpdatedAt,
    model.rollup.dataUpdatedAt,
    model.peSummary.dataUpdatedAt,
  ].filter((t) => t > 0);
  return stamps.length ? Math.max(...stamps) : 0;
}

/** Human "Xh ago" / "Xm ago" label from a epoch-ms timestamp. */
function refreshedAgo(updatedAt: number): string {
  const elapsed = Date.now() - updatedAt;
  if (elapsed < 0) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function Pulse({ model }: { model: ReturnType<typeof usePortfolioIndexModel> }) {
  const { summary, clients } = model;
  const loading =
    summary.isLoading ||
    clients.isLoading ||
    model.meetings.isLoading ||
    model.accountOwners.isLoading;
  const figures = useMemo<{ label: string; value: number | null; money?: boolean }[]>(() => {
    const clientCount = clients.data?.filter((c) => (c.status ?? '').toLowerCase() !== 'archived').length;
    const s = summary.data;
    return [
      { label: 'Clients', value: clientCount ?? null },
      { label: 'Active strategies', value: s?.activeStrategies ?? null },
      { label: 'Meetings this week', value: s?.meetingsThisWeek ?? null },
      { label: 'Tracked bills', value: s?.billsTracked ?? null },
      { label: 'Active regulations', value: s?.activeRegulations ?? null },
      // LDA spend is a dollar amount — rendered via the shared null-safe
      // compact-money helper ($1.8M), not '$' + toLocaleString.
      { label: 'LDA spend QTD', value: s?.ldaSpendQtd ?? null, money: true },
    ];
  }, [summary.data, clients.data]);

  // Re-render on a 30s tick so the "Refreshed Xm ago" label stays honest
  // instead of freezing at whatever it said when the data last changed.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const updatedAt = freshestUpdatedAt(model);

  return (
    <section className="capiro-portfolio-pulse capiro-portfolio__surface" aria-label="Portfolio pulse">
      <div className="capiro-portfolio-pulse__head">
        <span className="capiro-portfolio__eyebrow">Portfolio pulse</span>
        {updatedAt > 0 ? (
          <span className="capiro-portfolio-pulse__refresh"><span className="capiro-portfolio-pulse__refresh-dot" /> Refreshed {refreshedAgo(updatedAt)}</span>
        ) : null}
      </div>
      <div className="capiro-portfolio-pulse__band">
        {loading ? figures.map((f) => <div className="capiro-portfolio-pulse__stat-skel" key={f.label} />) : summary.isError ? (
          <div className="capiro-portfolio-pulse__error" role="status">Portfolio aggregates are unavailable right now; the client list below is intact.</div>
        ) : figures.map((f) => (
          <div className="capiro-portfolio-pulse__stat" key={f.label}>
            <span className={`capiro-portfolio-pulse__value${f.value == null ? ' is-missing' : ''}`}>{f.value == null ? '—' : f.money ? formatMoney(f.value) : formatNumber(f.value)}</span>
            <span className="capiro-portfolio-pulse__label">{f.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Rollup-driven cells ───────────────────────────────────────────────────
   Three honest states: loading → skeleton bar, error → '—' with an
   explanation, resolved → the real number (0 included) or "None scheduled". */

type RollupState = 'loading' | 'error' | 'ready';

function RollupCount({
  state,
  value,
  className,
  describe,
}: {
  state: RollupState;
  value: number | null;
  className: string;
  describe?: (n: number) => string;
}) {
  if (state === 'loading') return <span className="capiro-portfolio__cell-skel" aria-hidden />;
  if (state === 'error' || value == null) return <span className={className} title="Rollup unavailable">—</span>;
  const label = describe?.(value);
  return <span className={className} aria-label={label} title={label}>{value}</span>;
}

function NextTouchCell({ state, nextTouch }: { state: RollupState; nextTouch: PortfolioRow['nextTouch'] }) {
  if (state === 'loading') return <span className="capiro-portfolio__cell-skel" aria-hidden />;
  if (state === 'error') return <span className="capiro-portfolio__meta" title="Rollup unavailable">—</span>;
  if (!nextTouch) return <span className="capiro-portfolio__meta">None scheduled</span>;
  return (
    <span className="capiro-portfolio__meta" title={nextTouch.subject}>
      {formatDateShort(nextTouch.startsAt) ?? '—'}
    </span>
  );
}

function attentionClass(count: number | null): string {
  return `capiro-portfolio__attention${count != null && count > 0 ? ' has-attention' : ''}`;
}

/**
 * Client tile + name + status + meta line — one component for both layouts.
 * In the table layout `onOpen` renders the name as a real button (the row's
 * keyboard entry point); the card layout is itself a button, so it omits it.
 */
function ClientIdentity({ row, onOpen }: { row: PortfolioRow; onOpen?: () => void }) {
  // With FOCUS chips present the sector already shows there — the meta line
  // carries only the location. Without chips, the (humanized) sector may show.
  const subtitle = (row.focusTags.length ? [row.location] : [row.sector, row.location])
    .filter(Boolean)
    .join(' · ') || '—';
  return (
    <div className="capiro-portfolio__client">
      {row.client.logoUrl ? (
        <img className="capiro-portfolio__tile capiro-portfolio__tile-logo" src={row.client.logoUrl} alt="" aria-hidden />
      ) : (
        <span className="capiro-portfolio__tile" aria-hidden>{initialsFor(row.name)}</span>
      )}
      <div className="capiro-portfolio__client-copy">
        <div className="capiro-portfolio__client-name">
          {onOpen ? (
            <button
              type="button"
              className="capiro-portfolio__name-btn"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
            >
              {row.name}
            </button>
          ) : (
            row.name
          )}
        </div>
        <div className="capiro-portfolio__client-status">
          <CapiroBadge tone={STATUS_TONE[row.status]} dot={<span className="capiro-portfolio__dot" />}>{STATUS_LABEL[row.status]}</CapiroBadge>
        </div>
        <div className="capiro-portfolio__meta">{subtitle}</div>
      </div>
    </div>
  );
}

function ClientRow({ row, rollupState, onOpen }: { row: PortfolioRow; rollupState: RollupState; onOpen: () => void }) {
  const focus = row.focusTags.slice(0, 2);
  return (
    <tr className="capiro-portfolio__tr" onClick={onOpen}>
      <td><ClientIdentity row={row} onOpen={onOpen} /></td>
      <td>{focus.length ? <div className="capiro-portfolio__tags">{focus.map((t) => <span className="capiro-portfolio__tag" key={t}>{t}</span>)}</div> : <span className="capiro-portfolio__meta">—</span>}</td>
      <td>{row.ownerName ? <div className="capiro-portfolio__owner"><span className="capiro-portfolio__avatar" aria-hidden>{initialsFor(row.ownerName)}</span><span>{row.ownerName}</span></div> : <span className="capiro-portfolio__meta">—</span>}</td>
      {/* G3 rollup (item 5): real in_progress task count in the Work column */}
      <td><RollupCount state={rollupState} value={row.workCount} className="capiro-portfolio__work-value" /></td>
      {/* G3 rollup (wire-audit "4 New capability" items 2-4): real intel/attention/next-touch */}
      <td><RollupCount state={rollupState} value={row.intelCount} className="capiro-portfolio__meta" /></td>
      <td><RollupCount state={rollupState} value={row.attentionCount} className={attentionClass(row.attentionCount)} /></td>
      <td><NextTouchCell state={rollupState} nextTouch={row.nextTouch} /></td>
    </tr>
  );
}

function ClientCard({ row, rollupState, onOpen }: { row: PortfolioRow; rollupState: RollupState; onOpen: () => void }) {
  const focus = row.focusTags.slice(0, 2);
  return (
    <button type="button" className="capiro-portfolio__clientcard" onClick={onOpen}>
      <div className="capiro-portfolio__card-main">
        <ClientIdentity row={row} />
        {/* G3 rollup (item 1): attention count instead of fixture */}
        <RollupCount
          state={rollupState}
          value={row.attentionCount}
          className={attentionClass(row.attentionCount)}
          describe={(n) => `${n} open attention item${n === 1 ? '' : 's'}`}
        />
      </div>
      <div className="capiro-portfolio__card-focus">
        {focus.length ? focus.map((tag) => <span className="capiro-portfolio__tag" key={tag}>{tag}</span>) : <span className="capiro-portfolio__meta">—</span>}
      </div>
      <div className="capiro-portfolio__card-work"><RollupCount state={rollupState} value={row.workCount} className="capiro-portfolio__work-value" /></div>
      <div className="capiro-portfolio__card-foot">
        {row.ownerName ? <div className="capiro-portfolio__owner"><span className="capiro-portfolio__avatar" aria-hidden>{initialsFor(row.ownerName)}</span><span>{row.ownerName}</span></div> : <span className="capiro-portfolio__meta">—</span>}
        {/* G3 rollup (item 1): next-touch date in card foot */}
        <NextTouchCell state={rollupState} nextTouch={row.nextTouch} />
      </div>
    </button>
  );
}

export function PortfolioIndexPage() {
  const navigate = useNavigate();
  const api = useApi();
  const toast = useCapiroToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const route = resolvePortfolioRoute(searchParams);
  const model = usePortfolioIndexModel(route);
  const [importOpen, setImportOpen] = useState(searchParams.get('modal') === 'import-lda');
  const [createOpen, setCreateOpen] = useState(searchParams.get('new') === '1');
  const setRoute = (patch: Parameters<typeof applyPortfolioRoute>[1]) => setSearchParams(applyPortfolioRoute(searchParams, patch), { replace: true });
  const openClient = (id: string) => navigate(`/clients?clientId=${encodeURIComponent(id)}`);

  // Role-gate the create button (same rule as the canonical workspace).
  const me = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: async () => (await api.get<MeResponse>('/api/me')).data,
    staleTime: 30_000,
    retry: false,
  });
  const canCreateClients = Boolean(me.data && hasAtLeast(me.data.role, 'standard_user'));

  const openCreate = () => {
    if (!canCreateClients) return;
    setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.set('new', '1');
    setSearchParams(next, { replace: true });
  };
  const closeCreate = () => {
    setCreateOpen(false);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  };

  // Create-client mutation — mirrors ClientWorkspacePage.createClient exactly:
  // POST the payload, upload the logo + documents, then refetch the full
  // client record so the redirect opens the profile with all fields populated.
  const createClient = useMutation({
    mutationFn: async (submission: ClientFormSubmit) => {
      const created = (await api.post<Client>('/api/clients', submission.payload)).data;
      if (submission.logo) await uploadClientLogo(api, created.id, submission.logo);
      if (submission.documents.length) await uploadClientDocuments(api, created.id, submission.documents);
      return (await api.get<Client>(`/api/clients/${created.id}`)).data;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      void queryClient.invalidateQueries({ queryKey: ['client-account-owners'] });
      void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-rollup'] });
      void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-pe-summary'] });
      setCreateOpen(false);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
      navigate(`/clients?clientId=${encodeURIComponent(created.id)}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const openImport = (open: boolean) => {
    setImportOpen(open);
    const next = new URLSearchParams(searchParams);
    if (open) next.set('modal', 'import-lda'); else next.delete('modal');
    setSearchParams(next, { replace: true });
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['clients'] });
    void queryClient.invalidateQueries({ queryKey: ['client-account-owners'] });
    void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-rollup'] });
    void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-pe-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
    void queryClient.invalidateQueries({ queryKey: ['engagement-meetings-week'] });
    void queryClient.invalidateQueries({ queryKey: ['program-element-finder', 'portfolio-watch'] });
  };
  const { clients } = model;
  const rollupState: RollupState = model.rollup.isLoading ? 'loading' : model.rollup.isError ? 'error' : 'ready';
  const showEmpty = !clients.isLoading && !clients.isError && model.visible.length === 0;
  // rows (not clients.data) — an all-archived tenant has data but no rows,
  // and must see the "no clients yet" state, not "no clients match filters".
  const emptyIsFilter = model.rows.length > 0;
  const statusCounts = PORTFOLIO_STATUS_LABELS.map((s) => `${s.label} ${model.counts[s.key]}`).join(' · ');

  return (
    <div className="capiro-portfolio capiro-page">
      <header className="capiro-portfolio__head">
        <div><h1 className="capiro-portfolio__title">Portfolio</h1><p className="capiro-portfolio__sub">Every client account, the work in flight, and the outside signals moving against them.</p></div>
        <span className="capiro-portfolio__head-spacer" />
        <CapiroButton variant="secondary" size="standard" onClick={refresh}>Refresh</CapiroButton>
        <CapiroButton variant="secondary" size="standard" onClick={() => openImport(true)}>Import with LDA</CapiroButton>
        <CapiroButton variant="primary" size="standard" disabled={!canCreateClients} onClick={openCreate}>New client</CapiroButton>
      </header>

      <Pulse model={model} />

      <section className="capiro-portfolio__clients capiro-portfolio__surface" aria-labelledby="capiro-portfolio-clients">
        <div className="capiro-portfolio__clients-toolbar">
          <div className="capiro-portfolio__title-row"><h2 className="capiro-portfolio__section-title" id="capiro-portfolio-clients">Clients</h2><span className="capiro-portfolio__count">{model.rows.length} accounts</span></div>
          <span className="capiro-portfolio__toolbar-spacer" />
          <input className="capiro-portfolio__search" placeholder="Search clients" aria-label="Search clients" value={route.q} onChange={(e) => setRoute({ q: e.target.value })} />
          <div className="capiro-portfolio__layout" role="group" aria-label="Layout"><button type="button" className={`capiro-portfolio__layout-btn${route.layout === 'list' ? ' is-active' : ''}`} onClick={() => setRoute({ layout: 'list' })} aria-label="List view" aria-pressed={route.layout === 'list'}>☰</button><button type="button" className={`capiro-portfolio__layout-btn${route.layout === 'cards' ? ' is-active' : ''}`} onClick={() => setRoute({ layout: 'cards' })} aria-label="Card view" aria-pressed={route.layout === 'cards'}>▦</button></div>
        </div>
        <div className="capiro-portfolio__filter-row">
          <div className="capiro-portfolio__filters" role="group" aria-label={`Status filter: ${statusCounts}`}>{PORTFOLIO_STATUS_LABELS.map((s) => <button key={s.key} type="button" className={`capiro-portfolio__filter${route.status === s.key ? ' is-active' : ''}`} onClick={() => setRoute({ status: s.key })} aria-pressed={route.status === s.key}>{s.label}<span className="capiro-portfolio__filter-count">{model.counts[s.key]}</span></button>)}</div>
          <span className="capiro-portfolio__toolbar-spacer" /><span className="capiro-portfolio__eyebrow">Sort</span>
          {PORTFOLIO_SORT_LABELS.map((s) => <button key={s.key} type="button" className={`capiro-portfolio__sort-chip${route.sort === s.key ? ' is-active' : ''}`} onClick={() => setRoute({ sort: s.key })} aria-pressed={route.sort === s.key}>{s.label}</button>)}
        </div>

        {clients.isLoading ? <div aria-busy="true"><div className="capiro-portfolio__skeleton" style={{ height: 320 }} /></div> : clients.isError ? <div className="capiro-portfolio__state capiro-portfolio__state--error" role="status"><span>Clients could not be loaded.{clients.error instanceof Error ? ` (${clients.error.message})` : ''}</span><CapiroButton variant="quiet" size="compact" onClick={() => void clients.refetch()}>Retry</CapiroButton></div> : showEmpty ? <div className="capiro-portfolio__state" role="status">{emptyIsFilter ? <><span>No clients match the current search and filters.</span><button type="button" className="capiro-portfolio__linkbtn" onClick={() => setRoute({ q: '', status: 'all' })}>Clear search and filters</button></> : 'No clients yet. Add one with New client, or import several with Import with LDA.'}</div> : route.layout === 'list' ? (
          <div className="capiro-portfolio__table-wrap"><table className="capiro-portfolio__table"><thead><tr><th>Client</th><th>Focus</th><th>Owner</th><th>Work</th><th>Intelligence</th><th>Attention</th><th>Next touch</th></tr></thead><tbody>{model.visible.map((row) => <ClientRow key={row.client.id} row={row} rollupState={rollupState} onOpen={() => openClient(row.client.id)} />)}</tbody></table><div className="capiro-portfolio__footer">Showing {model.visible.length} of {model.rows.length} clients · sorted by {route.sort}</div></div>
        ) : (
          <>
            <div className="capiro-portfolio__cards">{model.visible.map((row) => <ClientCard key={row.client.id} row={row} rollupState={rollupState} onOpen={() => openClient(row.client.id)} />)}</div>
            <div className="capiro-portfolio__footer">Showing {model.visible.length} of {model.rows.length} clients · sorted by {route.sort}</div>
          </>
        )}
      </section>

      <PortfolioProgramElements peSummary={model.peSummary} />
      <ImportWithLdaModal open={importOpen} onClose={() => openImport(false)} />
      <ClientFormDialogVNext
        open={createOpen}
        mode="create"
        submitting={createClient.isPending}
        onCancel={closeCreate}
        onSubmit={(submission) => createClient.mutate(submission)}
      />
    </div>
  );
}
