import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Modal, Skeleton } from 'antd';
import { CloseOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
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
import '../program-element/program-elements-redesign.css';

const CLOSED_ACTION_STATUSES = new Set(['dismissed', 'archived']);

export function PortfolioProgramElementsSection() {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const watch = useWatchToggle();

  const monitored = useQuery({
    queryKey: ['program-element-finder', 'portfolio-watch'],
    queryFn: () => getProgramElementsList(api, { watched: 'true', limit: 100 }),
    staleTime: 30 * 1000,
  });

  const actions = useActionsList({ page: 1, limit: 100 });

  const addResults = useQuery({
    queryKey: ['program-element-finder', 'portfolio-add', addQuery.trim()],
    queryFn: () =>
      getProgramElementsList(api, {
        q: addQuery.trim() || undefined,
        page: 1,
        limit: 20,
      }),
    enabled: addOpen,
    staleTime: 60 * 1000,
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
  const busyCode = watch.isPending ? (watch.variables?.peCode ?? null) : null;

  useEffect(() => {
    if (searchParams.get('section') !== 'program-elements') return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById('portfolio-program-elements')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchParams, monitored.isLoading]);

  const toggleWatch = (row: ProgramElementListItem, watching: boolean) => {
    watch.mutate({ peCode: row.peCode, watching });
  };

  return (
    <section id="portfolio-program-elements" className="portfolio-pe-section" aria-labelledby="portfolio-pe-title">
      <div className="portfolio-pe-heading">
        <div className="portfolio-pe-title-row">
          <h2 id="portfolio-pe-title">Program elements</h2>
          <span>{total.toLocaleString()}</span>
        </div>
        <div className="portfolio-pe-actions">
          <button type="button" onClick={() => setAddOpen(true)}>
            Add program element
          </button>
          <button type="button" className="is-muted" onClick={() => navigate('/program-elements')}>
            Browse all
          </button>
        </div>
      </div>
      <p className="portfolio-pe-description">
        Monitored lines live here, not in a separate watchlist. Opening a card goes straight to its
        profile under Program elements.
      </p>

      {monitored.isError ? (
        <Alert type="error" showIcon message="Unable to load monitored program elements" />
      ) : monitored.isLoading ? (
        <div className="portfolio-pe-grid">
          {[0, 1, 2].map((index) => (
            <div className="portfolio-pe-card" key={index}>
              <Skeleton active paragraph={{ rows: 5 }} />
            </div>
          ))}
        </div>
      ) : (
        <>
          {rows.length === 0 ? (
            <div className="portfolio-pe-empty">
              <strong>No program elements monitored yet</strong>
              <span>
                Add one by code or name, or open a line under Program elements and press Monitor.
              </span>
            </div>
          ) : null}

          <div className="portfolio-pe-grid">
            {rows.map((row) => (
              <ProgramElementCard
                key={row.peCode}
                row={row}
                actionCount={actionCountByPe.get(row.peCode) ?? 0}
                actionsLoading={actions.isLoading}
                busy={busyCode === row.peCode}
                onOpen={() => navigate(`/program-elements/${encodeURIComponent(row.peCode)}`)}
                onRemove={() => toggleWatch(row, false)}
              />
            ))}

            <button type="button" className="portfolio-pe-add-card" onClick={() => setAddOpen(true)}>
              <span className="portfolio-pe-add-icon">
                <PlusOutlined />
              </span>
              <strong>Add program element</strong>
              <span>search by code or name</span>
            </button>
          </div>
        </>
      )}

      <Modal
        open={addOpen}
        width={620}
        rootClassName="portfolio-pe-modal"
        title={
          <div className="portfolio-pe-modal-title">
            <h3>Add a program element</h3>
            <p>
              Search the catalog by code or name. Adding it starts monitoring and puts a card in
              your Portfolio.
            </p>
          </div>
        }
        footer={
          <button type="button" className="portfolio-pe-done" onClick={() => setAddOpen(false)}>
            Done
          </button>
        }
        onCancel={() => setAddOpen(false)}
        destroyOnClose={false}
      >
        <div className="portfolio-pe-modal-search">
          <Input
            value={addQuery}
            onChange={(event) => setAddQuery(event.target.value)}
            placeholder="e.g. 0603270A or electronic warfare"
            prefix={<SearchOutlined />}
            allowClear
            autoFocus
          />
        </div>
        <div className="portfolio-pe-modal-results">
          {addResults.isLoading ? (
            <div className="portfolio-pe-modal-loading">
              <Skeleton active paragraph={{ rows: 4 }} />
            </div>
          ) : addResults.isError ? (
            <div className="portfolio-pe-modal-loading">
              <Alert type="error" showIcon message="Unable to search the program element catalog" />
            </div>
          ) : (addResults.data?.data ?? []).length === 0 ? (
            <div className="portfolio-pe-modal-empty">
              No match. Check the code, or browse the catalog under Program elements.
            </div>
          ) : (
            (addResults.data?.data ?? []).map((row) => {
              const watched = Boolean(row.watched);
              const busy = busyCode === row.peCode;
              return (
                <div className="portfolio-pe-modal-row" key={row.peCode}>
                  <span className="portfolio-pe-code">{row.peCode}</span>
                  <div className="portfolio-pe-modal-copy">
                    <strong>{row.title}</strong>
                    <span>
                      {serviceLabel(row.service)} ·{' '}
                      {row.latestCurrent != null ? `${fmtMoneyM(row.latestCurrent)} current` : 'current amount unavailable'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={watched ? 'is-added' : ''}
                    disabled={busy}
                    onClick={() => toggleWatch(row, !watched)}
                  >
                    {watched ? 'Added' : 'Add'}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </Modal>
    </section>
  );
}

function ProgramElementCard({
  row,
  actionCount,
  actionsLoading,
  busy,
  onOpen,
  onRemove,
}: {
  row: ProgramElementListItem;
  actionCount: number;
  actionsLoading: boolean;
  busy: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const ba = baShort(row.budgetActivity);
  const delta = displayDeltaPct(row);
  const trendUp = row.spark && row.spark.length > 1 ? row.spark.at(-1)! >= row.spark[0]! : true;

  return (
    <article
      className="portfolio-pe-card"
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
      <div className="portfolio-pe-service">
        <span style={{ background: serviceColor(row.service) }} />
        {serviceLabel(row.service)}
      </div>

      <div className="portfolio-pe-spark">
        {row.spark && row.spark.length > 1 ? (
          <Sparkline
            data={row.spark}
            width={240}
            height={44}
            color={trendUp ? 'var(--accent)' : 'var(--critical)'}
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
          <strong className={delta == null ? '' : delta < 0 ? 'is-down' : delta > 0 ? 'is-up' : ''}>
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
          <span>data {relativeTime(row.lastSyncedAt)}</span>
        </div>
      ) : null}
    </article>
  );
}

function displayDeltaPct(row: ProgramElementListItem): number | null {
  if (
    row.latestCurrent != null &&
    row.latestRequest != null &&
    row.latestCurrentFy != null &&
    row.latestCurrentFy === row.latestRequestFy &&
    row.latestRequest !== 0
  ) {
    return ((row.latestCurrent - row.latestRequest) / Math.abs(row.latestRequest)) * 100;
  }
  return row.deltaPct ?? null;
}

function relativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.max(0, Math.floor(diffMs / 86_400_000));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1d ago';
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}
