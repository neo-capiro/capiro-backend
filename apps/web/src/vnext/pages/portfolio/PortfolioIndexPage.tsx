import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { hasAtLeast } from '@capiro/shared';
import { message } from 'antd';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import { useApi } from '../../../lib/use-api.js';
import type { MeResponse } from '../../../lib/me.js';
import type { AxiosInstance } from 'axios';
import type { Client, ClientFormSubmit } from '../../../pages/clients/clientTypes.js';
import { ClientFormModal } from '../../../pages/clients/ClientFormModal.js';
import { ImportWithLdaModal } from './ImportWithLdaModal.js';
import { PortfolioProgramElements } from './PortfolioProgramElements.js';
import {
  PORTFOLIO_SORT_LABELS,
  PORTFOLIO_STATUS_LABELS,
  applyPortfolioRoute,
  resolvePortfolioRoute,
} from './portfolio-routing.js';
import { usePortfolioIndexModel, type PortfolioRow, type PortfolioAlert, type ComingUpItem } from './usePortfolioIndexModel.js';
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

/** Freshest dataUpdatedAt across the queries the pulse band reads. */
function freshestUpdatedAt(model: ReturnType<typeof usePortfolioIndexModel>): number {
  return Math.max(
    model.summary.dataUpdatedAt,
    model.clients.dataUpdatedAt,
    model.strategies.dataUpdatedAt,
    model.meetings.dataUpdatedAt,
    model.accountOwners.dataUpdatedAt,
    model.rollup.dataUpdatedAt,
    model.peSummary.dataUpdatedAt,
  );
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
    model.strategies.isLoading ||
    model.meetings.isLoading ||
    model.accountOwners.isLoading;
  const figures = useMemo(() => {
    const clientCount = clients.data?.filter((c) => (c.status ?? '').toLowerCase() !== 'archived').length;
    const s = summary.data;
    return [
      { label: 'Clients', value: clientCount ?? null },
      { label: 'Need attention', value: s?.needAttention ?? null },
      { label: 'Active strategies', value: model.strategies.data?.length ?? null },
      { label: 'Meetings this week', value: s?.meetingsThisWeek ?? null },
      { label: 'Tracked bills', value: s?.billsTracked ?? null },
      { label: 'Active regulations', value: s?.activeRegulations ?? null },
      { label: 'LDA spend QTD', value: s?.ldaSpendQtd != null ? `$${s.ldaSpendQtd.toLocaleString()}` : null },
    ];
  }, [summary.data, clients.data, model.strategies.data, model.meetings.data]);

  const refreshLabel = useMemo(
    () => refreshedAgo(freshestUpdatedAt(model)),
    [model, loading], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <section className="capiro-portfolio-pulse capiro-portfolio__surface" aria-label="Portfolio pulse">
      <div className="capiro-portfolio-pulse__head">
        <span className="capiro-portfolio__eyebrow">Portfolio pulse</span>
        <span className="capiro-portfolio-pulse__refresh"><span className="capiro-portfolio-pulse__refresh-dot" /> Refreshed {refreshLabel}</span>
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
  // G3 rollup: next-touch date label (wire-audit "4 New capability" item 4).
  const nextTouchLabel = row.nextTouch
    ? new Date(row.nextTouch.startsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;
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
      {/* G3 rollup (item 5): real in_progress task count in the Work column */}
      <td>{row.workCount != null ? <span className="capiro-portfolio__work-value">{row.workCount}</span> : <span className="capiro-portfolio__work-value">—</span>}<span className="capiro-portfolio__track" aria-hidden><span /></span></td>
      {/* G3 rollup (wire-audit "4 New capability" items 2-4): real intel/attention/next-touch */}
      <td>{row.intelCount != null ? <span className="capiro-portfolio__meta">{row.intelCount}</span> : <span className="capiro-portfolio__meta">—</span>}</td>
      <td>{row.attentionCount != null ? <span className={`capiro-portfolio__attention${row.attentionCount > 0 ? ' has-attention' : ''}`}>{row.attentionCount}</span> : <span className="capiro-portfolio__attention">—</span>}</td>
      <td>{nextTouchLabel ? <span className="capiro-portfolio__meta">{nextTouchLabel}</span> : <span className="capiro-portfolio__meta">—</span>}</td>
    </tr>
  );
}

function ClientCard({ row, onOpen }: { row: PortfolioRow; onOpen: () => void }) {
  const focus = row.focusTags.slice(0, 2);
  const status = <CapiroBadge tone={STATUS_TONE[row.status]} dot={<span className="capiro-portfolio__dot" />}>{STATUS_LABEL[row.status]}</CapiroBadge>;
  // G3 rollup: next-touch date label (wire-audit "4 New capability" item 1 + 4).
  const nextTouchLabel = row.nextTouch
    ? new Date(row.nextTouch.startsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;
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
        {/* G3 rollup (item 1): attention count instead of fixture — */}
        {row.attentionCount != null ? (
          <span className={`capiro-portfolio__attention${row.attentionCount > 0 ? ' has-attention' : ''}`}>{row.attentionCount}</span>
        ) : (
          <span className="capiro-portfolio__attention">—</span>
        )}
      </div>
      <div className="capiro-portfolio__card-focus">
        {focus.length ? focus.map((tag) => <span className="capiro-portfolio__tag" key={tag}>{tag}</span>) : <span className="capiro-portfolio__meta">—</span>}
      </div>
      <div className="capiro-portfolio__card-work">{row.workCount != null ? <span className="capiro-portfolio__work-value">{row.workCount}</span> : <span className="capiro-portfolio__work-value">—</span>}<span className="capiro-portfolio__track" aria-hidden><span /></span></div>
      <div className="capiro-portfolio__card-foot">
        {row.ownerName ? <div className="capiro-portfolio__owner"><span className="capiro-portfolio__avatar" aria-hidden>{initialsFor(row.ownerName)}</span><span>{row.ownerName}</span></div> : <span className="capiro-portfolio__meta">—</span>}
        {/* G3 rollup (item 1): next-touch date in card foot */}
        {nextTouchLabel ? <span className="capiro-portfolio__meta">{nextTouchLabel}</span> : <span className="capiro-portfolio__meta">—</span>}
      </div>
    </button>
  );
}

/* ── Feed rows (WA2 coming-up, WA3 portfolio-alerts) ───────────────────────── */

const SEVERITY_DOT: Record<string, string> = {
  critical: '#F04438',
  notable: '#F79009',
  info: '#344054',
};

function AlertRow({ alert, onOpen }: { alert: PortfolioAlert; onOpen: () => void }) {
  const dot = SEVERITY_DOT[String(alert.severity).toLowerCase()] ?? '#667085';
  return (
    <button type="button" className="capiro-portfolio__feed-row" onClick={onOpen}>
      <span className="capiro-portfolio__feed-dot" style={{ background: dot }} />
      <span className="capiro-portfolio__feed-copy">
        <span className="capiro-portfolio__feed-title">{alert.title}</span>
        <span className="capiro-portfolio__feed-meta">{alert.clientName}{alert.kind ? ` · ${alert.kind}` : ''}</span>
      </span>
      {alert.countdownDays != null ? (
        <span className="capiro-portfolio__feed-due">{alert.countdownDays <= 0 ? 'Today' : `${alert.countdownDays}d`}</span>
      ) : null}
      <span className="capiro-portfolio__feed-open">Open →</span>
    </button>
  );
}

function ComingUpRow({ item }: { item: ComingUpItem }) {
  const date = new Date(item.date);
  const dateLabel = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <a
      className="capiro-portfolio__feed-row"
      href={item.href ?? '#'}
      target={item.href ? '_blank' : undefined}
      rel={item.href ? 'noreferrer' : undefined}
    >
      <span className="capiro-portfolio__feed-label">{item.label}</span>
      <span className="capiro-portfolio__feed-copy">
        <span className="capiro-portfolio__feed-title">{item.title}</span>
        {item.detail ? <span className="capiro-portfolio__feed-meta">{item.detail}</span> : null}
      </span>
      <span className="capiro-portfolio__feed-due">{dateLabel}{item.time ? ` · ${item.time}` : ''}</span>
    </a>
  );
}

export function PortfolioIndexPage() {
  const navigate = useNavigate();
  const api = useApi();
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
    onError: (err) => message.error(errorMessage(err)),
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
    void queryClient.invalidateQueries({ queryKey: ['intelligence', 'coming-up'] });
    void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-alerts'] });
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
        <CapiroButton variant="primary" size="standard" disabled={!canCreateClients} onClick={openCreate}>New client</CapiroButton>
      </header>

      <Pulse model={model} />

      {(model.alerts.data?.alerts.length || model.comingUp.data?.items.length) ? (
        <div className="capiro-portfolio__feeds">
          {model.alerts.data && model.alerts.data.alerts.length > 0 ? (
            <section className="capiro-portfolio__surface capiro-portfolio__feed" aria-label="Needs attention">
              <div className="capiro-portfolio__feed-head">
                <h2 className="capiro-portfolio__section-title">Needs attention</h2>
                <span className="capiro-portfolio__count">{model.alerts.data.total} alert{model.alerts.data.total === 1 ? '' : 's'}</span>
              </div>
              <div className="capiro-portfolio__feed-body">
                {model.alerts.data.alerts.map((a) => <AlertRow key={a.id} alert={a} onOpen={() => openClient(a.clientId)} />)}
              </div>
            </section>
          ) : null}

          {model.comingUp.data && model.comingUp.data.items.length > 0 ? (
            <section className="capiro-portfolio__surface capiro-portfolio__feed" aria-label="Coming up">
              <div className="capiro-portfolio__feed-head">
                <h2 className="capiro-portfolio__section-title">Coming up</h2>
                <span className="capiro-portfolio__count">{model.comingUp.data.items.length} this week</span>
              </div>
              <div className="capiro-portfolio__feed-body">
                {model.comingUp.data.items.map((item) => <ComingUpRow key={item.id} item={item} />)}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

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

      <PortfolioProgramElements peSummary={model.peSummary} />
      <ImportWithLdaModal open={importOpen} onClose={() => openImport(false)} />
      <ClientFormModal
        open={createOpen}
        mode="create"
        submitting={createClient.isPending}
        onCancel={closeCreate}
        onSubmit={(submission) => createClient.mutate(submission)}
      />
    </div>
  );
}
