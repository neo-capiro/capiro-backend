import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Modal, Skeleton } from 'antd';
import { CheckOutlined, CloseOutlined, LinkOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { useActionsList } from '../actions/actions-api.js';
import { getProgramElementsList } from '../program-element/api.js';
import type { ProgramElementListItem } from '../program-element/types.js';
import {
  ActionSignalChip,
  SignalPill,
  baShort,
  serviceLabel,
  useWatchToggle,
} from '../program-element/pe-shared.js';
import { Sparkline, fmtMoneyM, serviceColor } from '../program-element/charts/index.js';
import '../program-element/program-elements-final.css';

const CLOSED_ACTION_STATUSES = new Set(['dismissed', 'archived']);

export function PortfolioProgramElementsSection() {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const watch = useWatchToggle();
  const monitored = useQuery({
    queryKey: ['program-element-finder', 'portfolio-watch'],
    queryFn: () => getProgramElementsList(api, { watched: 'true', limit: 100 }),
    staleTime: 30_000,
  });
  const actions = useActionsList({ page: 1, limit: 100 });
  const addResults = useQuery({
    queryKey: ['program-element-finder', 'portfolio-add-approved', addQuery.trim()],
    queryFn: () => getProgramElementsList(api, { q: addQuery.trim() || undefined, page: 1, limit: 20 }),
    enabled: addOpen,
    staleTime: 60_000,
  });
  const actionCountByPe = useMemo(() => {
    const counts = new Map<string, number>();
    for (const action of actions.data?.data ?? []) {
      if (!action.peCode || CLOSED_ACTION_STATUSES.has(action.status)) continue;
      counts.set(action.peCode, (counts.get(action.peCode) ?? 0) + 1);
    }
    return counts;
  }, [actions.data]);
  const rows = monitored.data?.data ?? [];
  const total = monitored.data?.total ?? rows.length;
  const busyCode = watch.isPending ? watch.variables?.peCode ?? null : null;

  useEffect(() => {
    if (searchParams.get('section') !== 'program-elements') return;
    const frame = window.requestAnimationFrame(() => document.getElementById('portfolio-program-elements')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [searchParams, monitored.isLoading]);

  const closeAdd = () => {
    setAddOpen(false);
    setSelectedCodes([]);
  };
  const toggleSelected = (code: string) => setSelectedCodes((current) => current.includes(code) ? current.filter((item) => item !== code) : [...current, code]);
  const addSelected = async () => {
    if (!selectedCodes.length) return;
    setAdding(true);
    try {
      for (const peCode of selectedCodes) await watch.mutateAsync({ peCode, watching: true });
      closeAdd();
    } finally {
      setAdding(false);
    }
  };

  return (
    <section id="portfolio-program-elements" className="portfolio-pe-section pe-final-portfolio" aria-labelledby="portfolio-pe-title">
      <div className="portfolio-pe-heading">
        <div className="portfolio-pe-title-row"><h2 id="portfolio-pe-title">Program elements</h2><span className="portfolio-pe-count">{total.toLocaleString()}</span></div>
        <div className="portfolio-pe-actions"><button type="button" onClick={() => setAddOpen(true)}>Add program element</button><button type="button" className="is-muted" onClick={() => navigate('/program-elements')}>Browse all</button></div>
      </div>
      <p className="portfolio-pe-description">Monitored lines live here, not in a separate watchlist. Opening a card goes straight to its profile under Program elements.</p>

      {monitored.isError ? <Alert type="error" showIcon message="Unable to load monitored Program Elements" action={<Button size="small" onClick={() => void monitored.refetch()}>Retry</Button>} /> : monitored.isLoading ? <div className="portfolio-pe-grid">{[0,1,2,3].map((item) => <div className="portfolio-pe-card" key={item}><Skeleton active paragraph={{ rows: 5 }} /></div>)}</div> : <>
        {!rows.length ? <div className="portfolio-pe-empty"><strong>No Program Elements monitored yet</strong><span>Add one by code or name, or open a line under Program elements and press Monitor.</span><button type="button" onClick={() => setAddOpen(true)}>Add program element</button></div> : null}
        <div className="portfolio-pe-grid">
          {rows.map((row) => <ProgramElementCard key={row.peCode} row={row} actionCount={actionCountByPe.get(row.peCode) ?? 0} actionsLoading={actions.isLoading} busy={busyCode === row.peCode} onOpen={() => navigate(`/program-elements/${encodeURIComponent(row.peCode)}?from=portfolio`)} onRemove={() => watch.mutate({ peCode: row.peCode, watching: false })} />)}
          <button type="button" className="portfolio-pe-add-card" onClick={() => setAddOpen(true)}><span className="portfolio-pe-add-icon"><PlusOutlined /></span><strong>Add program element</strong><span>search by code or name</span></button>
        </div>
      </>}

      <Modal open={addOpen} width={760} rootClassName="portfolio-pe-modal pe-final-add-modal" title={<div className="pe-final-add-title"><h3>Add program elements</h3><p>Search the catalog by code or name, select one or more lines, then add them to Portfolio.</p></div>} footer={null} onCancel={closeAdd} destroyOnClose={false}>
        <label className="pe-final-add-search"><SearchOutlined /><input value={addQuery} onChange={(event) => setAddQuery(event.target.value)} placeholder="e.g. 0603270A or electronic warfare" autoFocus /></label>
        <div className="pe-final-add-results">
          {addResults.isLoading ? <div style={{ padding: 18 }}><Skeleton active paragraph={{ rows: 5 }} /></div> : addResults.isError ? <div style={{ padding: 18 }}><Alert type="error" showIcon message="Unable to search the Program Element catalog" action={<Button size="small" onClick={() => void addResults.refetch()}>Retry</Button>} /></div> : !(addResults.data?.data ?? []).length ? <div className="portfolio-pe-modal-empty">No match. Check the code, or browse the full catalog.</div> : (addResults.data?.data ?? []).map((row) => {
            const watched = Boolean(row.watched);
            const selected = selectedCodes.includes(row.peCode);
            return <div className="pe-final-add-row" key={row.peCode}>
              <button className={`pe-final-select${selected || watched ? ' selected' : ''}`} type="button" disabled={watched} aria-label={`${selected ? 'Remove' : 'Select'} ${row.peCode}`} aria-pressed={selected || watched} onClick={() => toggleSelected(row.peCode)}>{selected || watched ? <CheckOutlined /> : null}</button>
              <span className="pe-final-code">{row.peCode}</span>
              <div className="pe-final-add-row-copy"><strong>{row.title}</strong><small>{serviceLabel(row.service)} · {row.latestCurrent == null ? 'current amount unavailable' : `${fmtMoneyM(row.latestCurrent)} current`}</small></div>
              <button className={`pe-final-btn${watched ? ' monitoring' : ''}`} type="button" disabled={watched || busyCode === row.peCode} onClick={() => watch.mutate({ peCode: row.peCode, watching: true })}>{watched ? 'Already monitored' : 'Add'}</button>
            </div>;
          })}
        </div>
        <div className="pe-final-client-options"><span>Link selected lines to a client</span><div><button type="button" disabled><LinkOutlined /> No client</button><button type="button" disabled title="Client assignment is unchanged and is not available from the current watch mutation.">Choose client</button></div></div>
        <div className="pe-final-add-footer"><span>{selectedCodes.length ? `${selectedCodes.length} selected` : 'Select rows to add several at once'}</span><button className="pe-final-btn" type="button" onClick={closeAdd}>Cancel</button><button className="pe-final-btn primary" type="button" disabled={!selectedCodes.length || adding} onClick={() => void addSelected()}>{adding ? 'Adding…' : selectedCodes.length > 1 ? `Add ${selectedCodes.length} lines` : 'Add selected'}</button></div>
      </Modal>
    </section>
  );
}

function ProgramElementCard({ row, actionCount, actionsLoading, busy, onOpen, onRemove }: { row: ProgramElementListItem; actionCount: number; actionsLoading: boolean; busy: boolean; onOpen: () => void; onRemove: () => void }) {
  const ba = baShort(row.budgetActivity);
  const delta = displayDelta(row);
  const fundingRisk = (delta ?? 0) < 0 || row.actionSignalType === 'cut' || row.actionSignalType === 'termination';
  const trendUp = row.spark && row.spark.length > 1 ? row.spark.at(-1)! >= row.spark[0]! : true;
  return (
    <article
      className={`portfolio-pe-card${fundingRisk ? ' risk' : actionCount ? ' actions' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="portfolio-pe-card-top">
        <span className="portfolio-pe-code">{row.peCode}</span>
        {ba ? <span className="portfolio-pe-ba">BA {ba}</span> : null}
        <span className="portfolio-pe-spacer" />
        <button
          type="button"
          className="portfolio-pe-remove"
          title="Stop monitoring"
          aria-label={`Stop monitoring ${row.peCode}`}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <CloseOutlined />
        </button>
      </div>
      <h3>{row.title}</h3>
      <div className="portfolio-pe-states">
        {fundingRisk ? <span className="pe-final-pill critical">Funding at risk</span> : null}
        {actionCount ? (
          <span className="pe-final-pill info">
            {actionCount} open action{actionCount === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
      <div className="portfolio-pe-service">
        <span style={{ background: serviceColor(row.service) }} />
        {serviceLabel(row.service)}
      </div>
      <div className="portfolio-pe-client">
        <LinkOutlined />
        <span className="portfolio-pe-client-label">No client linked</span>
        <button
          type="button"
          className="portfolio-pe-client-link"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          Link
        </button>
      </div>
      <div className="portfolio-pe-spark">
        {row.spark && row.spark.length > 1 ? (
          <Sparkline
            data={row.spark}
            width={240}
            height={44}
            color={trendUp ? 'var(--pef-accent)' : 'var(--pef-critical)'}
            strokeWidth={2}
          />
        ) : (
          <span>Not enough history</span>
        )}
      </div>
      <div className="portfolio-pe-metrics">
        <div>
          <span>Current</span>
          <strong>{row.latestCurrent == null ? '—' : fmtMoneyM(row.latestCurrent)}</strong>
        </div>
        <div>
          <span>Δ vs req</span>
          <strong
            className={
              delta == null ? '' : delta < 0 ? 'is-down' : delta > 0 ? 'is-up' : ''
            }
          >
            {delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}
          </strong>
        </div>
        <div>
          <span>Actions</span>
          <strong>{actionsLoading ? '—' : actionCount}</strong>
        </div>
      </div>
      {row.actionSignalType || row.signalType ? (
        <div className="portfolio-pe-signal">
          {row.actionSignalType ? (
            <ActionSignalChip type={row.actionSignalType} tone={row.actionSignalTone} />
          ) : (
            <SignalPill item={row} />
          )}
          <span>{relativeTime(row.lastSyncedAt)}</span>
        </div>
      ) : (
        <div className="portfolio-pe-signal">
          <span className="pe-final-pill muted">No recent movement</span>
        </div>
      )}
    </article>
  );
}
function displayDelta(row: ProgramElementListItem): number | null {
  if (row.latestCurrent != null && row.latestRequest != null && row.latestCurrentFy != null && row.latestCurrentFy === row.latestRequestFy && row.latestRequest !== 0) return ((row.latestCurrent - row.latestRequest) / Math.abs(row.latestRequest)) * 100;
  return row.deltaPct ?? null;
}
function relativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}
