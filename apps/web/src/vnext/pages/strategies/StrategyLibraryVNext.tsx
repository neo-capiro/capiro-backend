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
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { CapiroPlusIcon } from '../../components/icons/index.js';
import { useShellClientContext } from '../../adapters/legacy/useShellClientContext.js';
import { ScopeBar, type ScopeBarStatus } from './ScopeBar.js';
import {
  clientName,
  memberName,
  useClientsLite,
  useDeleteStrategy,
  useFirmPhases,
  usePendingWatchCounts,
  useStrategies,
  useTenantMembers,
} from './strategies-api.js';
import type { FirmPhase, StrategyListItem } from '../../../pages/strategy/types.js';
import './strategies.css';
import './strategy-library.css';

/** spStrategy.id is a UUID column; anything else is a malformed link, not a query. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/* Exported so StrategyEditorVNext's eyebrow can render the same friendly
 * label for `StrategyType` instead of the raw slug — both statically
 * imported by VNextStrategiesRoutes.tsx already, so this adds no new
 * bundle/circular-import concern. */
export const TYPE_LABEL: Record<string, string> = {
  appropriations: 'Appropriations ask',
  authorization: 'Authorization',
  regulatory: 'Regulatory / Policy',
  coalition: 'Coalition',
  procurement: 'Contract / Procurement',
  earmark: 'Earmark',
};

import { strategyRelativeTime } from './lib/date-format.js';

type SortKey = 'recent' | 'steps';

/*
 * Local glyphs (design handoff, "Assets" section: LayersThree01 / Stars02 /
 * BookOpen01). The shared icon set (../../components/icons/index.tsx) has no
 * layers/sparkle/book entry, and adding one there is out of scope for this
 * pass — that file may be touched by another concurrent Strategies agent.
 * These mirror its stroke conventions (24x24 viewBox, currentColor, 1.75
 * stroke) as self-contained, view-local glyphs instead.
 */
function LibraryPhasesGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 21 8l-9 5-9-5 9-5Z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16l9 5 9-5" />
    </svg>
  );
}

function AgentReviewGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 3l1.6 4.2L17 9l-4.4 1.8L11 15l-1.6-4.2L5 9l4.4-1.8L11 3Z" />
      <path d="M18.5 14.5l.75 1.9 1.9.75-1.9.75-.75 1.9-.75-1.9-1.9-.75 1.9-.75.75-1.9Z" />
    </svg>
  );
}

function ContextLibraryGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5c1.8-1 4.4-1 6.5 0 .3.15.5.46.5.8v11.7c0 .5-.5.8-.95.6-2-.9-4.4-.9-6.35.1-.4.2-.7-.1-.7-.5V6c0-.2.1-.4.3-.5Z" />
      <path d="M20 5.5c-1.8-1-4.4-1-6.5 0-.3.15-.5.46-.5.8v11.7c0 .5.5.8.95.6 2-.9 4.4-.9 6.35.1.4.2.7-.1.7-.5V6c0-.2-.1-.4-.3-.5Z" />
    </svg>
  );
}

/** Real FY span across the firm's configured phases (min start → max end).
 *  The handoff's reference copy hardcodes "FY27–FY29" as fixture text; this
 *  computes the actual span from `FirmPhase.startFy`/`endFy` so the banner
 *  never claims a window the firm's real phase rows don't back. */
function firmPhaseFyRange(phases: FirmPhase[]): string | null {
  if (phases.length === 0) return null;
  const startFy = Math.min(...phases.map((p) => p.startFy));
  const endFy = Math.max(...phases.map((p) => p.endQ === 1 ? p.endFy - 1 : p.endFy));
  return startFy === endFy ? `FY${startFy}` : `FY${startFy}–FY${endFy}`;
}

export function StrategyLibraryVNext() {
  const navigate = useNavigate();
  const strategies = useStrategies();
  const clients = useClientsLite();
  const members = useTenantMembers();
  const firmPhases = useFirmPhases();
  const watchCounts = usePendingWatchCounts(true);
  const clientContext = useShellClientContext();
  const deleteStrategy = useDeleteStrategy();

  const [sort, setSort] = useState<SortKey>('recent');
  const [planFilter, setPlanFilter] = useState<'all' | 'unassigned' | 'empty'>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  /* Two-step delete: the row's Delete control arms this, and only the armed
   * row's explicit Confirm actually mutates. No window.confirm (the module's
   * dirty-guard convention) and no single-click destructive action. */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const rows = strategies.data ?? [];
  const counts = watchCounts.data ?? {};
  const watchAvailable = Boolean(watchCounts.data) && !watchCounts.isError;
  const fyRange = useMemo(() => firmPhaseFyRange(firmPhases.data ?? []), [firmPhases.data]);
  const selectedClientId = clientContext.selectedClientId;

  /* Live-status pill (design handoff, "Scope bar" section): a real react-query
   * fetch timestamp, never a fabricated "Live" claim — falls back to an
   * honest gray state while loading or if the last fetch failed. */
  const status: ScopeBarStatus = strategies.isError
    ? { tone: 'gray', label: 'Live status unavailable' }
    : strategies.dataUpdatedAt
      ? { tone: 'success', label: `Live · refreshed ${relativeTime(new Date(strategies.dataUpdatedAt).toISOString())}` }
      : { tone: 'gray', label: 'Loading…' };

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
    /* ScopeBar client chip (§7.1): the shared cross-app client scope now
     * actually filters the table, not just the chip label. The list endpoint
     * already returns the full tenant set, so this is a real client-side
     * filter over the complete loaded collection — never a server round-trip
     * that could be mistaken for a truncated result. */
    if (selectedClientId) list = list.filter((r) => r.clientId === selectedClientId);
    if (ownerFilter !== 'all') list = list.filter((r) => r.ownerUserId === ownerFilter);
    if (planFilter === 'unassigned') list = list.filter((row) => (row.summary?.unassignedCount ?? 0) > 0);
    if (planFilter === 'empty') list = list.filter((row) => row.nodeCount === 0);
    const sorted = [...list];
    if (sort === 'recent') {
      sorted.sort((a, b) => (b.lastEditedAt ?? b.createdAt).localeCompare(a.lastEditedAt ?? a.createdAt));
    } else {
      // The library has step counts, not per-plan health or gate dates.
      sorted.sort((a, b) => (b.nodeCount ?? 0) - (a.nodeCount ?? 0));
    }
    return sorted;
  }, [rows, ownerFilter, sort, selectedClientId, planFilter]);

  const scopedRows = selectedClientId ? rows.filter((r) => r.clientId === selectedClientId) : rows;
  const plannedCount = scopedRows.filter((row) => row.nodeCount > 0).length;
  const emptyCount = scopedRows.length - plannedCount;
  const clientCount = new Set(scopedRows.map((row) => row.clientId)).size;
  const needsReview = scopedRows.reduce((sum, row) => sum + (counts[row.id] ?? 0), 0);
  const totalSteps = scopedRows.reduce((sum, row) => sum + row.nodeCount, 0);
  const summaryAvailable = scopedRows.every((row) => row.summary !== undefined);
  const unassignedCount = scopedRows.reduce((sum, row) => sum + (row.summary?.unassignedCount ?? 0), 0);
  const assignedCount = scopedRows.reduce((sum, row) => sum + (row.summary?.assignedCount ?? 0), 0);
  const ownerCoverage = summaryAvailable && totalSteps ? `${Math.round(assignedCount / totalSteps * 100)}%` : '—';

  if (strategies.isLoading) {
    return (
      <>
        <ScopeBar clientLabel="PORTFOLIO" status={status} />
        <div className="st-page">
          <div className="st-page-header">
            <div>
              <p className="st-eyebrow">Strategy operating system</p>
              <h1 className="st-title">Strategies</h1>
            </div>
          </div>
          <div className="st-stats">{[0, 1, 2, 3].map((i) => <CapiroSkeleton key={i} height={88} />)}</div>
          <div className="st-state-row">{[0, 1, 2, 3].map((i) => <CapiroSkeleton key={i} height={64} />)}</div>
        </div>
      </>
    );
  }

  if (strategies.isError) {
    return (
      <>
        <ScopeBar clientLabel="PORTFOLIO" status={status} />
        <div className="st-page">
          <CapiroErrorState
            title="Strategies could not be loaded"
            description="The strategy service did not respond. Your data is intact — retry to reload the library."
            onRetry={() => void strategies.refetch()}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <ScopeBar clientLabel="PORTFOLIO" status={status} />
      <div className="st-hero">
        <div className="st-page-header">
          <div>
            <p className="st-eyebrow">Strategy operating system</p>
            <h1 className="st-title">Strategies</h1>
            <p className="st-purpose">
              Turn client goals into executable plans aligned to appropriations, authorization,
              regulatory and procurement calendars.
            </p>
          </div>
          <div className="st-actions">
            <CapiroButton leadingIcon={<AgentReviewGlyph />} onClick={() => navigate('/strategies/agents/proposals')}>
              Agent review
              {needsReview > 0 ? <CapiroBadge tone="warning">{needsReview}</CapiroBadge> : null}
            </CapiroButton>
            <CapiroButton leadingIcon={<ContextLibraryGlyph />} onClick={() => navigate('/strategies/context')}>
              Context library
            </CapiroButton>
            <CapiroButton variant="primary" leadingIcon={<CapiroPlusIcon />} onClick={() => navigate('/strategies/new')}>
              New strategy
            </CapiroButton>
          </div>
        </div>
      </div>
      <div className="st-canvas">
        {/* Firm phases banner (§7.1) — setup prompt when unconfigured, never an empty card.
            40px icon tile per the design handoff ("View: Strategy library"); the fy range
            in the configured copy is computed from the real FirmPhase rows (see
            firmPhaseFyRange above), not the handoff's hardcoded "FY27–FY29" fixture text. */}
        {firmPhases.data && firmPhases.data.length === 0 ? (
          <div className="st-card st-library-phases st-library-phases--setup">
            <div className="st-card__body st-library-phases__row">
              <span className="st-library-phases__icon" aria-hidden="true">
                <LibraryPhasesGlyph />
              </span>
              <div className="st-library-phases__text">
                <h2 className="st-card__title">Set the firm&rsquo;s operating phases</h2>
                <p className="st-purpose">
                  No phase model is configured. Firm phases align every strategy to the firm&rsquo;s
                  fiscal rhythm — set them to light up the reference layer.
                </p>
              </div>
              <CapiroButton variant="primary" onClick={() => navigate('/strategies/phases')}>
                Set up phases
              </CapiroButton>
            </div>
          </div>
        ) : firmPhases.isLoading ? (
          <div className="st-card st-library-phases">
            <div className="st-card__body st-library-phases__row">
              <span className="st-library-phases__icon" aria-hidden="true">
                <LibraryPhasesGlyph />
              </span>
              <div className="st-library-phases__text">
                <h2 className="st-card__title">Loading firm phases…</h2>
                <p className="st-purpose">
                  The firm&rsquo;s operating phase model is loading.
                </p>
              </div>
            </div>
          </div>
        ) : firmPhases.isError ? (
          <div className="st-card st-library-phases">
            <div className="st-card__body st-library-phases__row">
              <span className="st-library-phases__icon" aria-hidden="true">
                <LibraryPhasesGlyph />
              </span>
              <div className="st-library-phases__text">
                <h2 className="st-card__title">Firm phases could not be loaded</h2>
                <p className="st-purpose">
                  The phase model is unavailable. Strategies can still be opened, but the
                  reference layer and FY range will not render until this resolves.
                </p>
              </div>
              <CapiroButton onClick={() => void firmPhases.refetch()}>Retry</CapiroButton>
            </div>
          </div>
        ) : (
          <div className="st-card st-library-phases">
            <div className="st-card__body st-library-phases__row">
              <span className="st-library-phases__icon" aria-hidden="true">
                <LibraryPhasesGlyph />
              </span>
              <div className="st-library-phases__text">
                <h2 className="st-card__title">Firm phases are set</h2>
                <p className="st-purpose">
                  {firmPhases.data?.length ?? 0} operating phases align every strategy to the firm&rsquo;s
                  {fyRange ? ` ${fyRange}` : ''} rhythm.
                </p>
              </div>
              <CapiroButton onClick={() => navigate('/strategies/phases')}>Edit phases</CapiroButton>
            </div>
          </div>
        )}

        <div className="st-stats">
          <button type="button" className="st-stat" onClick={() => { setOwnerFilter('all'); setPlanFilter('all'); }}>
            <p className="st-stat__value">{plannedCount}</p>
            <p className="st-stat__label">Plans with steps</p>
            <p className="st-stat__hint">{emptyCount} empty · Across {clientCount} {clientCount === 1 ? 'client' : 'clients'}</p>
          </button>
          <button type="button" className={needsReview > 0 ? 'st-stat st-stat--attention' : 'st-stat'} onClick={() => navigate('/strategies/agents/proposals')}>
            <p className="st-stat__value">{watchAvailable ? needsReview : '—'}</p>
            <p className="st-stat__label">Watcher proposals</p>
            <p className="st-stat__hint">{watchAvailable ? 'Open agent review' : 'Watch status unavailable'}</p>
          </button>
          <button type="button" className="st-stat" disabled={!summaryAvailable} onClick={() => { setOwnerFilter('all'); setPlanFilter('unassigned'); }}>
            <p className="st-stat__value">{summaryAvailable ? unassignedCount : '—'}</p>
            <p className="st-stat__label">Unassigned work</p>
            <p className="st-stat__hint">Show plans with unfinished, unassigned steps</p>
          </button>
          <div className="st-stat">
            <p className="st-stat__value">{ownerCoverage}</p>
            <p className="st-stat__label">Owner coverage</p>
            <p className="st-stat__hint">{summaryAvailable ? `${assignedCount} of ${totalSteps} steps assigned` : 'Assignment data unavailable'}</p>
          </div>
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
            <div className="st-segmented" role="group" aria-label="Plan filter">
              <button aria-pressed={planFilter === 'all'} onClick={() => setPlanFilter('all')}>All plans</button>
              <button aria-pressed={planFilter === 'unassigned'} disabled={!summaryAvailable} onClick={() => setPlanFilter('unassigned')}>Unassigned work</button>
              <button aria-pressed={planFilter === 'empty'} onClick={() => setPlanFilter('empty')}>Empty plans</button>
            </div>
            <div className="st-segmented" role="group" aria-label="Owner filter">
              <button aria-pressed={ownerFilter === 'all'} onClick={() => setOwnerFilter('all')}>All owners</button>
              {owners.map(([id, name]) => (
                <button key={id} aria-pressed={ownerFilter === id} onClick={() => setOwnerFilter(id)}>
                  {name}
                </button>
              ))}
            </div>
            <span className="st-library-divider" aria-hidden="true" />
            <span className="st-library-sortlabel">Sort</span>
            <div className="st-segmented" role="group" aria-label="Sort">
              <button aria-pressed={sort === 'recent'} onClick={() => setSort('recent')}>Recently updated</button>
              <button aria-pressed={sort === 'steps'} onClick={() => setSort('steps')}>Most steps</button>
            </div>
          </div>
        </div>

        {/* Genuinely no strategies at all — distinct from the owner filter
            emptying the result set below (README, "Strategy table": "Footer
            carries the result count and a Clear filters link when filtered to
            empty" — that's the OTHER case, handled inside the table card). */}
        {rows.length === 0 ? (
          <CapiroEmptyState
            title="No strategies yet"
            description="Create the firm's first strategy to get started."
            action={
              <CapiroButton variant="primary" onClick={() => navigate('/strategies/new')}>
                New strategy
              </CapiroButton>
            }
          />
        ) : (
          <div className="st-card st-library-tablecard">
            {/* A failed delete must say so — never leave the row looking deleted
                or the failure silent. */}
            {deleteStrategy.isError ? (
              <p className="st-modal__alert" role="alert">
                The strategy could not be deleted.{' '}
                {(deleteStrategy.error as Error)?.message || 'Please try again.'}
              </p>
            ) : null}
            <div className="st-library-tablescroll">
              <table className="st-library-table">
                <thead>
                  <tr>
                    <th scope="col">Client / Strategy</th>
                    <th scope="col">Plan</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Updated</th>
                    <th scope="col"><span className="st-visually-hidden">Actions</span></th>
                    <th scope="col"><span className="st-visually-hidden">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr className="st-library-emptyrow">
                      <td colSpan={6}>
                        No strategies match the current filters.
                      </td>
                    </tr>
                  ) : (
                    filtered.map((s) => (
                      <StrategyRow
                        key={s.id}
                        strategy={s}
                        client={clientName(clients.data, s.clientId)}
                        owner={memberName(members.data, s.ownerUserId)}
                        watchCount={watchAvailable ? counts[s.id] ?? 0 : null}
                        confirmingDelete={pendingDeleteId === s.id}
                        onRequestDelete={() => { if (!deleteStrategy.isPending) setPendingDeleteId(s.id); }}
                        onCancelDelete={() => setPendingDeleteId(null)}
                        onConfirmDelete={() => {
                          if (deleteStrategy.isPending) return;
                          deleteStrategy.mutate(s.id, {
                            onSettled: () => setPendingDeleteId(null),
                          });
                        }}
                        deleting={deleteStrategy.isPending && pendingDeleteId === s.id}
                        onOpen={() => {
                          // Guard: never navigate with an empty/malformed id — the editor
                          // would render "This strategy link is not valid" (PR #919).
                          if (!s.id || !UUID_RE.test(s.id)) return;
                          navigate(`/strategies/${s.id}`);
                        }}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="st-library-tablefoot">
              <span className="st-purpose">
                {filtered.length === rows.length
                  ? `Showing all ${rows.length} ${rows.length === 1 ? 'strategy' : 'strategies'}`
                  : `Showing ${filtered.length} of ${rows.length} strategies`}
              </span>
              {filtered.length === 0 ? (
                <button
                  type="button"
                  className="st-library-clearlink"
                  onClick={() => {
                    setOwnerFilter('all');
                    setPlanFilter('all');
                    clientContext.setSelectedClientId(null);
                  }}
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function StrategyRow({
  strategy,
  client,
  owner,
  watchCount,
  onOpen,
  confirmingDelete,
  deleting,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  strategy: StrategyListItem;
  client: string;
  owner: string;
  watchCount: number | null;
  onOpen: () => void;
  confirmingDelete: boolean;
  deleting: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const updated = strategy.lastEditedAt ?? strategy.createdAt;
  return (
    <tr
      className="st-library-row"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      role="link"
      aria-label={`Open strategy ${strategy.title}`}
    >
      <td>
        <div className="st-library-client">{client}</div>
        <div className="st-library-title">{strategy.title}</div>
      </td>
      <td>
        <span className="st-pill st-pill--accent">{TYPE_LABEL[strategy.type] ?? strategy.type}</span>
        <div className="st-library-steps">{strategy.nodeCount === 0 ? 'Empty plan' : `${strategy.nodeCount} steps`}</div>
        {strategy.summary && strategy.nodeCount > 0 ? <div className="st-library-steps">
          {strategy.summary.completedCount === strategy.nodeCount ? 'Completed' : strategy.summary.reviewCount === strategy.nodeCount ? 'Draft / review' : 'Working plan'}
          {strategy.summary.unassignedCount > 0 ? ` · ${strategy.summary.unassignedCount} unassigned` : ''}
          {strategy.summary.reviewCount > 0 ? ` · ${strategy.summary.reviewCount} awaiting review` : ''}
        </div> : null}
      </td>
      <td>
        <div className="st-library-owner">
          <IdentityMark kind="person" name={owner} size="sm" />
          <div>
            <div className="st-library-ownername">{owner}</div>
            {watchCount === null ? (
              <span className="st-pill">Watch status unavailable</span>
            ) : watchCount > 0 ? (
              <span className="st-pill st-pill--warning">{watchCount} watch {watchCount === 1 ? 'note' : 'notes'}</span>
            ) : (
              <span className="st-pill st-pill--success">No watch notes</span>
            )}
          </div>
        </div>
      </td>
      <td className="st-library-updated">{relativeTime(updated)}</td>
      {/* Row actions. Every control stopPropagation()s — the <tr> itself is the
          open affordance, so a click that reached it would navigate instead of
          deleting. */}
      <td className="st-library-actions" onClick={(e) => e.stopPropagation()}>
        {confirmingDelete ? (
          <span className="st-library-confirm">
            <span className="st-library-confirm__ask">Delete?</span>
            <button
              type="button"
              className="st-library-confirm__yes"
              disabled={deleting}
              onClick={onConfirmDelete}
            >
              {deleting ? 'Deleting…' : 'Confirm'}
            </button>
            <button
              type="button"
              className="st-library-confirm__no"
              disabled={deleting}
              onClick={onCancelDelete}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="st-library-delete"
            onClick={onRequestDelete}
            aria-label={`Delete strategy ${strategy.title}`}
          >
            Delete
          </button>
        )}
      </td>
      <td aria-hidden="true" className="st-library-chev">›</td>
    </tr>
  );
}

function relativeTime(iso: string): string {
  return strategyRelativeTime(iso);
}
