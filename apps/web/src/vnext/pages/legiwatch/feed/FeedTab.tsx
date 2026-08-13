/**
 * Feed tab (§7.3) — the alert worklist. Saved-view strip, worklist header,
 * bulk bar, packet rows, and the view-control rail (Order · Worklist buckets ·
 * Source-type chips · Arrange · the standing priority explanation).
 *
 * Saved views have no persistence backend (GAPS LW-G8) — the strip is omitted
 * rather than rendered against nothing; `Reset` clears filters, not a view.
 *
 * Work states are server-authoritative (§1.8): one mutation, available in
 * three places (§4.1 #9) — the drawer's Change menu, the bulk bar, and the
 * row-level state pill. Optimistic with rollback; invalidates the canonical
 * feed keys so the old app reflects the change (§16).
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { FeedItem, FeedOrder, FeedFilter } from '../../../../pages/clients/tracker/intel-feed-api.js';
import {
  useLwFeed,
  useLwFeedItems,
  useLwWorkState,
  useLwBucketCount,
} from '../lib/api.js';
import {
  WORKLIST_BUCKETS,
  SOURCE_FAMILIES,
  WORK_STATE_LABEL,
  WORK_STATE_TONE,
  packetBand,
  ageLabel,
  clientAttribution,
  type WorkState,
} from '../lib/types.js';
import { LwPill, LwSeg, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateEmpty, LwStateUnavailable, LwStateAllClear } from '../states/SystemStates.js';
import { PacketDrawer } from './PacketDrawer.js';
import { useSearchParams } from 'react-router-dom';

type Arrange = 'stream' | 'byClient';

export function FeedTab({ scope, clients }: { scope: string; clients: Client[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [order, setOrder] = useState<FeedOrder>('date');
  const [bucket, setBucket] = useState('default');
  const [source, setSource] = useState<FeedFilter>('all');
  const [arrange, setArrange] = useState<Arrange>('stream');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  const qc = useQueryClient();
  const workState = useLwWorkState(scope);

  const work = bucket === 'default' ? undefined : bucket;
  const feed = useLwFeed(scope, source, order, work);
  const { items, counts } = useLwFeedItems(feed);

  const openAlertId = searchParams.get('alert');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      `${it.title} ${it.clientName ?? ''} ${it.evidence?.bill?.displayNum ?? ''} ${it.sourceType}`
        .toLowerCase()
        .includes(q),
    );
  }, [items, search]);

  const grouped = useMemo(() => {
    if (arrange !== 'byClient') return null;
    const map = new Map<string, FeedItem[]>();
    for (const it of filtered) {
      const key = it.clientName ?? it.clientId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, arrange]);

  const setAlert = (id: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('alert', id);
        else next.delete('alert');
        return next;
      },
      { replace: false },
    );
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  };

  const bulk = (state: WorkState) => {
    const ids = [...selected];
    if (!ids.length) return;
    const prev = qc.getQueryData(['intel-feed']);
    workState.mutate(
      { alertIds: ids, state },
      {
        onSuccess: () => {
          setSelected(new Set());
          showToast(`${ids.length} ${ids.length === 1 ? 'alert' : 'alerts'} marked ${WORK_STATE_LABEL[state].toLowerCase()}`);
        },
        onError: () => {
          qc.setQueryData(['intel-feed'], prev); // rollback
          showToast('Could not update — changes rolled back');
        },
      },
    );
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openDrawer = (it: FeedItem) => setAlert(it.id);

  if (feed.isLoading) {
    return (
      <div className="lw-body">
        <div className="lw-feed-cols">
          <div className="lw-card" style={{ padding: 18 }}>
            <LwStateLoading rows={4} />
          </div>
          <div className="lw-card lw-rail" style={{ padding: 18 }}>
            <LwStateLoading rows={3} />
          </div>
        </div>
      </div>
    );
  }

  if (feed.isError) {
    return (
      <div className="lw-body">
        <LwStateUnavailable
          source="LegiWatch feed"
          reason="The alert feed could not be loaded. Your watchlists and tracked bills are intact."
          onRetry={() => void feed.refetch()}
        />
      </div>
    );
  }

  const row = (it: FeedItem) => {
    const { band, tone } = packetBand(it);
    const ws = (it.workState?.state ?? 'new') as WorkState;
    const src = it.evidence?.bill?.displayNum ?? it.sourceType.toUpperCase();
    return (
      <div
        key={it.id}
        className={`lw-prow${selected.has(it.id) ? ' is-selected' : ''}`}
        onClick={() => openDrawer(it)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && openDrawer(it)}
      >
        <button
          type="button"
          className={`lw-prow__check${selected.has(it.id) ? ' is-on' : ''}`}
          aria-label={`Select ${it.title}`}
          aria-pressed={selected.has(it.id)}
          onClick={(e) => {
            e.stopPropagation();
            toggle(it.id);
          }}
        >
          ✓
        </button>
        <div className="lw-prow__main">
          <div className="lw-prow__meta">
            <LwPill tone={tone} size="22">{band}</LwPill>
            <span className="lw-prow__src">
              {src} · {ageLabel(it.createdAt)}
            </span>
            <span className="lw-prow__src">{clientAttribution(it)}</span>
          </div>
          <div className="lw-prow__title">{it.title}</div>
          {it.whyItMatters ? (
            <div className="lw-prow__block">
              <span className="lw-prow__prefix">WHY · </span>
              {it.whyItMatters}
            </div>
          ) : null}
          {it.evidence?.match?.matchedTags?.length ? (
            <div className="lw-prow__block">
              <span className="lw-prow__prefix">MATCH · </span>
              <span className="lw-mono" style={{ fontSize: 11 }}>
                {it.evidence.match.matchedTags.join(' · ')}
              </span>
            </div>
          ) : null}
        </div>
        <div className="lw-prow__side">
          <RowStatePill
            state={ws}
            onChange={(next) => {
              workState.mutate(
                { alertIds: [it.id], state: next },
                { onSuccess: () => showToast(`Marked ${WORK_STATE_LABEL[next].toLowerCase()}`) },
              );
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="lw-body">
      {/* worklist header */}
      <div className="lw-card" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 className="lw-card__title" style={{ fontSize: 16 }}>
            {arrange === 'byClient' ? 'What changed grouped by client' : 'What changed across all clients'}
          </h2>
          <span className="lw-card__meta" style={{ marginLeft: 0 }}>
            {filtered.length} {order === 'date' ? '· NEWEST' : '· PRIORITY'}
          </span>
          <div className="lw-search" style={{ marginLeft: 'auto', flex: '0 1 320px', minWidth: 200 }}>
            <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>⌕</span>
            <input
              aria-label="Search the feed"
              placeholder="Search title, client, source, record"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* bulk bar — appears on first selection */}
      {selected.size > 0 ? (
        <div className="lw-bulk lw-on-ink" role="toolbar" aria-label="Bulk actions">
          <span className="lw-bulk__n">{selected.size} SELECTED</span>
          <LwButton onClick={() => bulk('in_review')}>Mark reviewed</LwButton>
          <LwButton onClick={() => bulk('actioned')}>Mark actioned</LwButton>
          <LwButton onClick={() => bulk('dismissed')}>Dismiss</LwButton>
          <LwButton onClick={() => setSelected(new Set())}>Clear</LwButton>
        </div>
      ) : null}

      <div className="lw-feed-cols">
        <div className="lw-card" style={{ overflow: 'hidden' }}>
          {filtered.length === 0 ? (
            search || source !== 'all' || bucket !== 'default' ? (
              <div style={{ padding: 18 }}>
                <LwStateEmpty
                  onReset={() => {
                    setSearch('');
                    setSource('all');
                    setBucket('default');
                  }}
                />
              </div>
            ) : (
              <div style={{ padding: 18 }}>
                <LwStateAllClear lastScan={feed.dataUpdatedAt ? new Date(feed.dataUpdatedAt).toLocaleTimeString() : undefined} />
              </div>
            )
          ) : arrange === 'byClient' && grouped ? (
            grouped.map(([client, list]) => (
              <div key={client}>
                <div className="lw-history__label" style={{ padding: '12px 18px 6px' }}>{client}</div>
                {list.map(row)}
              </div>
            ))
          ) : (
            filtered.map(row)
          )}
          {feed.hasNextPage ? (
            <div style={{ padding: 14, display: 'flex', justifyContent: 'center' }}>
              <LwButton onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
                {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </LwButton>
            </div>
          ) : null}
        </div>

        {/* view-control rail (§7.3) */}
        <aside className="lw-card lw-rail" aria-label="Feed controls">
          <div className="lw-rail__sect">
            <div className="lw-rail__label">Order</div>
            <LwSeg
              ariaLabel="Feed order"
              options={[
                { id: 'date' as FeedOrder, label: 'Newest' },
                { id: 'score' as FeedOrder, label: 'Priority' },
              ]}
              value={order}
              onChange={setOrder}
            />
          </div>

          <div className="lw-rail__sect">
            <div className="lw-rail__label">Worklist</div>
            {WORKLIST_BUCKETS.map((b) => (
              <BucketRow
                key={b.id}
                scope={scope}
                bucket={b.id}
                label={b.label}
                active={bucket === b.id}
                onSelect={() => setBucket(b.id)}
              />
            ))}
          </div>

          <div className="lw-rail__sect">
            <div className="lw-rail__label">Source type</div>
            <RailOption
              label="All sources"
              count={Object.values(counts).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? null}
              active={source === 'all'}
              onClick={() => setSource('all')}
            />
            {SOURCE_FAMILIES.map((f) => (
              <RailOption
                key={f.id}
                label={f.label}
                count={counts[f.id] ?? null}
                active={source === f.id}
                onClick={() => setSource(f.id)}
              />
            ))}
          </div>

          <div className="lw-rail__sect">
            <div className="lw-rail__label">Arrange</div>
            <LwSeg
              ariaLabel="Arrangement"
              options={[
                { id: 'stream' as Arrange, label: 'Single stream' },
                { id: 'byClient' as Arrange, label: 'Group by client' },
              ]}
              value={arrange}
              onChange={setArrange}
            />
          </div>

          <div className="lw-rail__sect">
            <div className="lw-rail__label">Priority</div>
            <p style={{ margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--lw-body)' }}>
              Priority is ranked from client relevance, materiality, urgency, and client priority —
              computed on the server, never recomputed here.
            </p>
            <div style={{ marginTop: 10 }}>
              <LwButton
                onClick={() => {
                  setSearch('');
                  setSource('all');
                  setBucket('default');
                  setOrder('date');
                  setArrange('stream');
                }}
              >
                Reset
              </LwButton>
            </div>
          </div>
        </aside>
      </div>

      {openAlertId ? (
        <PacketDrawer scope={scope} alertId={openAlertId} onClose={() => setAlert(null)} />
      ) : null}

      {toast ? <div className="lw-toast" role="status">{toast}</div> : null}
    </div>
  );
}

function RailOption({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`lw-rail__opt${active ? ' is-active' : ''}`} onClick={onClick}>
      <span>{label}</span>
      {count != null ? <span className="lw-rail__count">{count}</span> : null}
    </button>
  );
}

function BucketRow({
  scope,
  bucket,
  label,
  active,
  onSelect,
}: {
  scope: string;
  bucket: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  // The active bucket's count is the loaded list's count; inactive buckets do a
  // cheap head read (GAPS LW-G1 — no bucket-count endpoint).
  const q = useLwBucketCount(scope, bucket, !active);
  return (
    <button type="button" className={`lw-rail__opt${active ? ' is-active' : ''}`} onClick={onSelect}>
      <span>{label}</span>
      <span className="lw-rail__count">{active ? '·' : q.data == null ? '' : q.data}</span>
    </button>
  );
}

/** Row-level state pill (§4.1 #9) — the third place the one work-state
 *  mutation is available, preventing a modal round trip. */
function RowStatePill({ state, onChange }: { state: WorkState; onChange: (next: WorkState) => void }) {
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <LwPill tone={WORK_STATE_TONE[state]}>
        {WORK_STATE_LABEL[state]}
      </LwPill>
      <span style={{ display: 'inline-block', marginLeft: 6 }}>
        <select
          aria-label="Change work state"
          value={state}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(e.target.value as WorkState)}
          style={{
            height: 24,
            fontFamily: 'var(--lw-mono)',
            fontSize: 11,
            borderRadius: 6,
            border: '1px solid var(--lw-control)',
            color: 'var(--lw-label)',
            background: 'var(--lw-surface)',
          }}
        >
          {(Object.keys(WORK_STATE_LABEL) as WorkState[]).map((s) => (
            <option key={s} value={s}>{WORK_STATE_LABEL[s]}</option>
          ))}
        </select>
      </span>
    </span>
  );
}
