/**
 * Feed tab (§7.3) — the alert worklist. Worklist header, bulk bar, packet
 * rows, and the view-control rail (Order · Worklist buckets · Source-type
 * chips · Arrange · the standing priority explanation).
 *
 * All view controls are URL-driven: every filter/order/arrangement choice
 * lives in the query string, so refresh, back/forward, and shared deep links
 * restore the visible feed exactly. `Reset` clears filters back to the
 * default URL state.
 *
 * Work states are server-authoritative (§1.8): one mutation, available in
 * three places (§4.1 #9) — the drawer's Change menu, the bulk bar, and the
 * row-level state pill. Optimistic with rollback; invalidates the canonical
 * feed keys so the old app reflects the change (§16).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { FeedItem, FeedOrder, FeedFilter } from '../../../../pages/clients/tracker/intel-feed-api.js';
import {
  useLwFeed,
  useLwFeedItems,
  useLwWorkState,
  useLwAssignSelf,
  defaultBucketCount,
} from '../lib/api.js';
import {
  WORKLIST_BUCKETS,
  SOURCE_FAMILIES,
  WORK_STATE_LABEL,
  packetBand,
  ageLabel,
  clientAttribution,
  type WorkState,
} from '../lib/types.js';
import { LwPill, LwSeg, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateEmpty, LwStateUnavailable, LwStateAllClear } from '../states/SystemStates.js';
import { PacketDrawer } from './PacketDrawer.js';
import { feedHearingDetailHref } from '../lib/feed-hearing-link.js';
import { groupFeedEvents } from './group-feed-events.js';

type Arrange = 'stream' | 'byClient';

export function FeedTab({ scope, clients }: { scope: string; clients: Client[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const previousScope = useRef(scope);
  const scopeChanged = previousScope.current !== scope;
  useEffect(() => {
    if (!scopeChanged) return;
    previousScope.current = scope;
    if (!searchParams.has('alert')) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('alert');
      return next;
    }, { replace: true });
  }, [scope, scopeChanged, searchParams, setSearchParams]);

  // Selection, pending row mutations and toast timers belong to one client
  // scope. Never mount a previous scope's open packet under the new client.
  return <ScopedFeedTab key={scope} scope={scope} clients={clients} suppressAlert={scopeChanged} />;
}

function ScopedFeedTab({ scope, clients, suppressAlert }: { scope: string; clients: Client[]; suppressAlert: boolean }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // View controls derive from the URL on every navigation so Back/Forward and
  // deep links restore the visible feed exactly.
  const order: FeedOrder = searchParams.get('order') === 'score' ? 'score' : 'date';
  const bucket = WORKLIST_BUCKETS.find((item) => item.id === searchParams.get('work'))?.id ?? 'default';
  const source: FeedFilter = SOURCE_FAMILIES.find((item) => item.id === searchParams.get('filter'))?.id ?? 'all';
  const arrange: Arrange = searchParams.get('arrange') === 'byClient' ? 'byClient' : 'stream';
  const search = searchParams.get('q') ?? '';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [showEmptyBuckets, setShowEmptyBuckets] = useState(false);
  const toastTimeout = useRef<number | null>(null);
  useEffect(() => () => {
    if (toastTimeout.current !== null) window.clearTimeout(toastTimeout.current);
  }, []);
  /** Rows with an in-flight row-level triage, so each pill disables its own. */
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const workState = useLwWorkState(scope);
  const self = useLwAssignSelf();

  const work = bucket === 'default' ? undefined : bucket;
  const feed = useLwFeed(scope, source, order, work);
  const { items, counts, workStateCounts } = useLwFeedItems(feed);

  // Selected scope-lens client (null on All clients); ID-matched display
  // fallback only — the client-scoped feed omits clientName by design.
  const selectedClient = useMemo(
    () => clients.find((c) => c.id.toLowerCase() === scope.toLowerCase()) ?? null,
    [clients, scope],
  );

  const openAlertId = suppressAlert ? null : searchParams.get('alert');

  const updateView = (
    changes: Partial<Record<'q' | 'order' | 'work' | 'filter' | 'arrange', string | null>>,
    replace = false,
  ) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace });
  };

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
      // Same ID-matched rule as the row label.
      const key = clientAttribution(it, clients.find((c) => c.id.toLowerCase() === it.clientId.toLowerCase()));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, arrange, clients]);

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
    if (toastTimeout.current !== null) window.clearTimeout(toastTimeout.current);
    toastTimeout.current = window.setTimeout(() => setToast(null), 2600);
  };

  const bulk = (state: WorkState) => {
    const ids = [...selected];
    if (!ids.length) return;
    if (state === 'assigned' && !self.userId) {
      showToast('Assignee could not be resolved — state not changed');
      return;
    }
    // The rollback lives in useLwWorkState's onMutate/onError snapshot. This
    // used to read and write the bare ['intel-feed'] prefix, which addresses no
    // cache entry (the real keys carry clientId/source/order/bucket), so the
    // "rollback" was a no-op that also wiped nothing.
    workState.mutate(
      { alertIds: ids, state, ...(state === 'assigned' ? { assignedTo: self.userId } : {}) },
      {
        onSuccess: () => {
          setSelected(new Set());
          showToast(`${ids.length} ${ids.length === 1 ? 'alert' : 'alerts'} marked ${WORK_STATE_LABEL[state].toLowerCase()}`);
        },
        onError: () => showToast('Could not update — changes rolled back'),
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
    const itemTitle = it.evidence?.bill?.title || it.evidence?.hearing?.title || it.title;
    const change = observedChange(it);
    // LW-QA-003/§12: bounded deep-link (hearingId → official event id →
    // congress.gov URL). NEVER title fuzzy-match. Legacy rows without any of
    // those anchors stay on the packet drawer (honest non-linkable).
    const hearingHref = feedHearingDetailHref(it);
    const openRow = () => (hearingHref ? navigate(hearingHref) : openDrawer(it));
    return (
      <div
        key={it.id}
        className={`lw-prow${selected.has(it.id) ? ' is-selected' : ''}`}
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
            {it.severity === 'critical' && !it.evidence?.match?.details?.length && <span>Client match needs review</span>}
            {it.evidence?.bill?.displayNum && <span>{it.evidence.bill.displayNum}{it.evidence.provenance?.jurisdiction && it.evidence.provenance.jurisdiction !== 'US' ? ` · ${it.evidence.provenance.jurisdiction}` : ''}{it.evidence.bill.stage ? ` · ${it.evidence.bill.stage}` : ''}</span>}
            <span className="lw-prow__src">{ageLabel(it.createdAt)}</span>
          </div>
          <button
            type="button"
            className="lw-prow__title lw-prow__title--action"
            onClick={openRow}
          >
            {itemTitle}
          </button>
          <div className="lw-prow__block">{change}</div>
          <span className="lw-prow__client">{clientAttribution(it, selectedClient)}</span>
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
            selfAvailable={self.userId != null}
            // LW-QA-019: a single-row failure used to be completely silent — no
            // onError, no pending state — so a 404 left the old value on screen
            // with nothing to tell the user the triage never happened.
            pending={workState.isPending && pendingIds.has(it.id)}
            onChange={(next) => {
              if (next === 'assigned' && !self.userId) {
                showToast('Assignee could not be resolved — state not changed');
                return;
              }
              setPendingIds((prev) => new Set(prev).add(it.id));
              workState.mutate(
                {
                  alertIds: [it.id],
                  state: next,
                  ...(next === 'assigned' ? { assignedTo: self.userId } : {}),
                },
                {
                  onSuccess: () => showToast(`Marked ${WORK_STATE_LABEL[next].toLowerCase()}`),
                  onError: () => showToast('Could not update — change reverted'),
                  onSettled: () =>
                    setPendingIds((prev) => {
                      const nextSet = new Set(prev);
                      nextSet.delete(it.id);
                      return nextSet;
                    }),
                },
              );
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="lw-body">
      {/* worklist header — title names the actual scope (LW-QA-022): a scoped
          feed reads the client name, never the all-clients banner. */}
      <div className="lw-card" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 className="lw-card__title" style={{ fontSize: 16 }}>
            {arrange === 'byClient'
              ? 'What changed grouped by client'
              : scope
                ? `What changed for ${clients.find((c) => c.id === scope)?.name ?? 'this client'}`
                : 'What changed across all clients'}
          </h2>
          <span className="lw-card__meta" style={{ marginLeft: 0 }}>
            {filtered.length} {order === 'date' ? '· NEWEST' : '· PRIORITY'}
          </span>
          <div className="lw-search" style={{ marginLeft: 'auto', flex: '0 1 320px', minWidth: 200 }}>
            <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>⌕</span>
            <input
              aria-label="Search the feed"
              aria-describedby="feed-search-hint"
              placeholder="Filter visible updates"
              value={search}
              onChange={(e) => updateView({ q: e.target.value || null }, true)}
            />
            <span id="feed-search-hint" className="lw-sr-only">Filter by title, client, source, or record — applies within current client, source, and work-state filters</span>
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
        <div className="lw-feed-list">
          {filtered.length === 0 ? (
            search || source !== 'all' || bucket !== 'default' ? (
              <div className="lw-card" style={{ padding: 18 }}>
                <LwStateEmpty
                  onReset={() => {
                    updateView({ q: null, filter: null, work: null });
                  }}
                />
              </div>
            ) : (
              <div className="lw-card" style={{ padding: 18 }}>
                <LwStateAllClear lastScan={feed.dataUpdatedAt ? new Date(feed.dataUpdatedAt).toLocaleTimeString() : undefined} />
              </div>
            )
          ) : arrange === 'byClient' && grouped ? (
            grouped.map(([client, list]) => (
              <div key={client} className="lw-feed-list__group">
                <div className="lw-history__label" style={{ padding: '0 0 6px' }}>{client}</div>
                <div className="lw-feed-list">{list.map(row)}</div>
              </div>
            ))
          ) : (
            groupFeedEvents(filtered).map((list) => list.length === 1 ? row(list[0]!) : (
              <div key={list[0]!.id} className="lw-feed-list__group">
                {row(list[0]!)}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 12 }} aria-label="Affected clients">
                  {list.map((it) => <LwButton key={it.id} size="36" onClick={() => openDrawer(it)}>{clientAttribution(it, clients.find((c) => c.id.toLowerCase() === it.clientId.toLowerCase()))}</LwButton>)}
                </div>
                <details><summary>{list.length - 1} more client alerts for this update</summary>{list.slice(1).map(row)}</details>
              </div>
            ))
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
              onChange={(next) => updateView({ order: next === 'date' ? null : next })}
            />
          </div>

          <div className="lw-rail__sect">
            <div className="lw-rail__label">Worklist</div>
            {WORKLIST_BUCKETS.map((b) => {
              const cnt = b.id === 'default'
                ? defaultBucketCount(workStateCounts)
                : (workStateCounts?.[b.id as keyof typeof workStateCounts] ?? null);
              // Zero-count buckets are only shown when showing empty buckets.
              const isActive = bucket === b.id;
              const isZeroCount = cnt === 0;
              if (!isActive && isZeroCount && !showEmptyBuckets) return null;
              return (
                <BucketRow
                  key={b.id}
                  label={b.label}
                  active={isActive}
                  onSelect={() => updateView({ work: b.id === 'default' ? null : b.id })}
                  count={cnt}
                />
              );
            })}
            {(() => {
              const zeroBuckets = WORKLIST_BUCKETS.filter((b) => {
                const cnt = b.id === 'default'
                  ? defaultBucketCount(workStateCounts)
                  : (workStateCounts?.[b.id as keyof typeof workStateCounts] ?? null);
                const isActive = bucket === b.id;
                return cnt === 0 && !isActive;
              });
              if (zeroBuckets.length === 0) return null;
              if (showEmptyBuckets) {
                return null;
              }
              return (
                <button
                  type="button"
                  className="lw-rail__opt"
                  style={{ color: 'var(--lw-meta)', fontSize: 12 }}
                  onClick={() => setShowEmptyBuckets(true)}
                >
                  Empty states ({zeroBuckets.length})
                </button>
              );
            })()}
          </div>

          <div className="lw-rail__sect">
            <div className="lw-rail__label">Source type</div>
            <RailOption
              label="All sources"
              count={Object.values(counts).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? null}
              active={source === 'all'}
              onClick={() => updateView({ filter: null })}
            />
            {SOURCE_FAMILIES.map((f) => (
              <RailOption
                key={f.id}
                label={f.label}
                count={counts[f.id] ?? null}
                active={source === f.id}
                onClick={() => updateView({ filter: f.id })}
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
              onChange={(next) => updateView({ arrange: next === 'stream' ? null : next })}
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
                  updateView({ q: null, filter: null, work: null, order: null, arrange: null });
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


function observedChange(item: FeedItem): string {
  if (item.evidence?.bill?.actionText) return item.evidence.bill.actionText.replace(/\s*\(fit\s+[\d.]+\)/gi, '');
  switch (item.kind) {
    case 'bill_text_changed': return 'Bill text changed';
    case 'bill_new_match': return 'New bill match';
    case 'hearing_new': return 'New hearing';
    default: return item.kind?.replaceAll('_', ' ') || 'Change recorded';
  }
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
    <button type="button" className={`lw-rail__opt${active ? ' is-active' : ''}`} aria-pressed={active} onClick={onClick}>
      <span>{label}</span>
      {count != null ? <span className="lw-rail__count">{count}</span> : null}
    </button>
  );
}

function BucketRow({
  label,
  active,
  onSelect,
  count,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
  /** Exact server-side count for this bucket (W2-3); null while loading. */
  count: number | null;
}) {
  return (
    <button type="button" className={`lw-rail__opt${active ? ' is-active' : ''}`} aria-pressed={active} onClick={onSelect}>
      <span>{label}</span>
      <span className="lw-rail__count">{count == null ? '' : count}</span>
    </button>
  );
}

/** Row-level state pill (§4.1 #9) — the third place the one work-state
 *  mutation is available, preventing a modal round trip. */
function RowStatePill({
  state,
  onChange,
  pending,
  selfAvailable,
}: {
  state: WorkState;
  onChange: (next: WorkState) => void;
  /** This row's own mutation is in flight — the control is not interactive. */
  pending: boolean;
  /** LW-QA-021: 'Assign to me' needs the actor's resolved tenant-member id. */
  selfAvailable: boolean;
}) {
  return (
    <span onClick={(e) => e.stopPropagation()}>
      {/* Single interactive state control -- the select already shows the current state
          as its selected value, so the static pill would be redundant (QA finding). */}
      <select
        aria-label="Change work state"
        value={state}
        disabled={pending}
        aria-busy={pending}
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
          <option key={s} value={s}>
            {s === 'assigned' ? (selfAvailable ? 'Assign to me' : 'Assigned (unavailable)') : WORK_STATE_LABEL[s]}
          </option>
        ))}
      </select>
    </span>
  );
}
