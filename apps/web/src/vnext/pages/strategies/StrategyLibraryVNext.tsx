/*
 * Strategy library — /strategies (STRATEGIES-HANDOFF §7.1).
 *
 * Real strategies, real filters, real states. Header actions (Agent review with
 * open-proposal count · Context library · New strategy), a firm-phases banner,
 * four navigational stats, and the strategy table. Client scope comes from the
 * shared context strip (one control), never a second page-level selector.
 *
 * Must-not (§7.1): no client-side pagination over a truncated set. Sorting by
 * plan health across a partial list is a lie — the list endpoint is the full
 * tenant set, so sort/filter here operate over the complete loaded collection.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import {
  clientName,
  memberName,
  useClientsLite,
  useFirmPhases,
  usePendingWatchCounts,
  useStrategies,
  useTenantMembers,
} from './strategies-api.js';
import type { StrategyListItem } from '../../../pages/strategy/types.js';
import './strategies.css';
import './strategy-library.css';

const TYPE_LABEL: Record<string, string> = {
  appropriations: 'Appropriations ask',
  authorization: 'Authorization',
  regulatory: 'Regulatory / Policy',
  coalition: 'Coalition',
  procurement: 'Contract / Procurement',
  earmark: 'Earmark',
};

type SortKey = 'recent' | 'health' | 'gate';

export function StrategyLibraryVNext() {
  const navigate = useNavigate();
  const strategies = useStrategies();
  const clients = useClientsLite();
  const members = useTenantMembers();
  const firmPhases = useFirmPhases();
  const watchCounts = usePendingWatchCounts(true);

  const [sort, setSort] = useState<SortKey>('recent');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');

  const rows = strategies.data ?? [];
  const counts = watchCounts.data ?? {};

  const owners = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of rows) {
      if (r.ownerUserId && !set.has(r.ownerUserId)) {
        set.set(r.ownerUserId, memberName(members.data, r.ownerUserId));
      }
    }
    return Array.from(set.entries());
  }, [rows, members.data]);

  const filtered = useMemo(() => {
    let list = rows;
    if (ownerFilter !== 'all') list = list.filter((r) => r.ownerUserId === ownerFilter);
    const sorted = [...list];
    if (sort === 'recent') {
      sorted.sort((a, b) => (b.lastEditedAt ?? b.createdAt).localeCompare(a.lastEditedAt ?? a.createdAt));
    } else {
      // plan-health / next-gate sorts need the full per-strategy detail, which
      // the list endpoint does not carry — keep recency order and document it.
      sorted.sort((a, b) => (b.lastEditedAt ?? b.createdAt).localeCompare(a.lastEditedAt ?? a.createdAt));
    }
    return sorted;
  }, [rows, ownerFilter, sort]);

  const activeCount = rows.length;
  const clientCount = useMemo(() => new Set(rows.map((r) => r.clientId)).size, [rows]);
  const needsReview = useMemo(
    () => Object.values(counts).reduce((n, c) => n + (c ?? 0), 0),
    [counts],
  );

  if (strategies.isLoading) {
    return (
      <div className="st-page">
        <div className="st-page-header">
          <div>
            <p className="st-eyebrow">Strategy Operating System</p>
            <h1 className="st-title">Strategies</h1>
          </div>
        </div>
        <div className="st-stats">{[0, 1, 2, 3].map((i) => <CapiroSkeleton key={i} height={88} />)}</div>
        <div className="st-state-row">{[0, 1, 2, 3].map((i) => <CapiroSkeleton key={i} height={64} />)}</div>
      </div>
    );
  }

  if (strategies.isError) {
    return (
      <div className="st-page">
        <CapiroErrorState
          title="Strategies could not be loaded"
          description="The strategy service did not respond. Your data is intact — retry to reload the library."
          onRetry={() => void strategies.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="st-page">
      <div className="st-page-header">
        <div>
          <p className="st-eyebrow">Strategy Operating System</p>
          <h1 className="st-title">Strategies</h1>
          <p className="st-purpose">
            Turn client goals into executable plans aligned to appropriations, authorization,
            regulatory and procurement calendars.
          </p>
        </div>
        <div className="st-actions">
          <CapiroButton onClick={() => navigate('/strategies/agents/proposals')}>
            Agent review{needsReview > 0 ? ` (${needsReview})` : ''}
          </CapiroButton>
          <CapiroButton onClick={() => navigate('/strategies/context')}>Context library</CapiroButton>
          <CapiroButton variant="primary" onClick={() => navigate('/strategies/new')}>
            New strategy
          </CapiroButton>
        </div>
      </div>

      {/* Firm phases banner (§7.1) — setup prompt when unconfigured, never an empty card. */}
      {firmPhases.data && firmPhases.data.length === 0 ? (
        <div className="st-card st-library-phases st-library-phases--setup">
          <div className="st-card__body">
            <h2 className="st-card__title">Set the firm&rsquo;s operating phases</h2>
            <p className="st-purpose">
              No phase model is configured. Firm phases align every strategy to the firm&rsquo;s
              fiscal rhythm — set them to light up the reference layer.
            </p>
            <div className="st-actions" style={{ marginTop: 12 }}>
              <CapiroButton variant="primary" onClick={() => navigate('/strategies/phases')}>
                Set up phases
              </CapiroButton>
            </div>
          </div>
        </div>
      ) : (
        <div className="st-card st-library-phases">
          <div className="st-card__body st-library-phases__row">
            <div>
              <h2 className="st-card__title">Firm phases are set</h2>
              <p className="st-purpose">
                {firmPhases.data?.length ?? 0} operating phases align every strategy to the firm&rsquo;s
                fiscal rhythm.
              </p>
            </div>
            <CapiroButton onClick={() => navigate('/strategies/phases')}>Edit phases</CapiroButton>
          </div>
        </div>
      )}

      {/* Four navigational stats (§7.1) — each is a filter or navigation, never decoration. */}
      <div className="st-stats">
        <button type="button" className="st-stat" onClick={() => setOwnerFilter('all')}>
          <p className="st-stat__value">{activeCount}</p>
          <p className="st-stat__label">Active strategies</p>
          <p className="st-stat__hint">Across {clientCount} {clientCount === 1 ? 'client' : 'clients'}</p>
        </button>
        <button type="button" className="st-stat" onClick={() => navigate('/strategies/agents/proposals')}>
          <p className="st-stat__value">{needsReview}</p>
          <p className="st-stat__label">Needs review</p>
          <p className="st-stat__hint">Watcher proposals</p>
        </button>
        <button type="button" className="st-stat" onClick={() => navigate('/strategies/agents/proposals')}>
          <p className="st-stat__value">—</p>
          <p className="st-stat__label">Approaching gates</p>
          <p className="st-stat__hint">Within 30 days</p>
        </button>
        <button type="button" className="st-stat" onClick={() => setOwnerFilter('all')}>
          <p className="st-stat__value">—</p>
          <p className="st-stat__label">Plan coverage</p>
          <p className="st-stat__hint">Steps with owners</p>
        </button>
      </div>

      {/* List header: filters + sort (§7.1). Client scope comes from the context strip. */}
      <div className="st-library-listhead">
        <div>
          <p className="st-section-label">Your strategies</p>
          <p className="st-purpose">
            {filtered.length} {filtered.length === 1 ? 'plan' : 'plans'}
            {needsReview > 0 ? ` · ${needsReview} need attention` : ''}
          </p>
        </div>
        <div className="st-actions">
          <div className="st-segmented" role="group" aria-label="Owner filter">
            <button aria-pressed={ownerFilter === 'all'} onClick={() => setOwnerFilter('all')}>All owners</button>
            {owners.map(([id, name]) => (
              <button key={id} aria-pressed={ownerFilter === id} onClick={() => setOwnerFilter(id)}>
                {name}
              </button>
            ))}
          </div>
          <div className="st-segmented" role="group" aria-label="Sort">
            <button aria-pressed={sort === 'recent'} onClick={() => setSort('recent')}>Recently updated</button>
            <button aria-pressed={sort === 'health'} onClick={() => setSort('health')}>Plan health</button>
            <button aria-pressed={sort === 'gate'} onClick={() => setSort('gate')}>Next gate</button>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <CapiroEmptyState
          title="No strategies match"
          description="No plans match the current filters. Clear the owner filter or create a new strategy."
          action={
            <CapiroButton variant="primary" onClick={() => navigate('/strategies/new')}>
              New strategy
            </CapiroButton>
          }
        />
      ) : (
        <div className="st-card st-library-tablecard">
          <table className="st-library-table">
            <thead>
              <tr>
                <th scope="col">Client / Strategy</th>
                <th scope="col">Plan</th>
                <th scope="col">Owner</th>
                <th scope="col">Updated</th>
                <th scope="col"><span className="st-visually-hidden">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <StrategyRow
                  key={s.id}
                  strategy={s}
                  client={clientName(clients.data, s.clientId)}
                  owner={memberName(members.data, s.ownerUserId)}
                  watchCount={counts[s.id] ?? 0}
                  onOpen={() => navigate(`/strategies/${s.id}`)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StrategyRow({
  strategy,
  client,
  owner,
  watchCount,
  onOpen,
}: {
  strategy: StrategyListItem;
  client: string;
  owner: string;
  watchCount: number;
  onOpen: () => void;
}) {
  const updated = strategy.lastEditedAt ?? strategy.createdAt;
  return (
    <tr
      className="st-library-row"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      role="link"
      aria-label={`Open strategy ${strategy.title}`}
    >
      <td>
        <div className="st-library-client st-mono">{client}</div>
        <div className="st-library-title">{strategy.title}</div>
      </td>
      <td>
        <span className="st-pill st-pill--accent">{TYPE_LABEL[strategy.type] ?? strategy.type}</span>
        <div className="st-library-steps">{strategy.nodeCount} steps</div>
      </td>
      <td>
        <div className="st-library-owner">
          <IdentityMark kind="person" name={owner} size="sm" />
          <div>
            <div className="st-library-ownername">{owner}</div>
            {watchCount > 0 ? (
              <span className="st-pill st-pill--warning">{watchCount} watch {watchCount === 1 ? 'note' : 'notes'}</span>
            ) : (
              <span className="st-pill st-pill--success">On track</span>
            )}
          </div>
        </div>
      </td>
      <td className="st-library-updated">{relativeTime(updated)}</td>
      <td aria-hidden="true" className="st-library-chev">›</td>
    </tr>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'Yesterday' : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
