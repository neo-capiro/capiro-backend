import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from './use-focus-trap.js';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { Icon, StarIcon } from './tracker-icons.js';
import {
  probClass,
  trackerPaths,
  type BillSearchResult,
  type BoardBill,
  type BoardColumn,
  type RecommendationBill,
} from './tracker-api.js';
import { intelTrackerPaths } from './intel-tracker-api.js';

/**
 * §4.8 (Gate D c-8): the meter used to be labelled "Passage probability", which
 * claims a calibrated forecast. It is not one — `passageProbability` is derived
 * from the bill's current stage and the age of its latest action, and has never
 * been checked against historical outcomes. The number is unchanged; only the
 * claim it makes is. Do NOT re-derive the computation here.
 */
export const PASSAGE_LIKELIHOOD_LABEL = 'Estimated passage likelihood';
export const PASSAGE_LIKELIHOOD_TOOLTIP =
  'Stage-based estimate — derived from the bill’s current stage and latest action date. Not calibrated against historical outcomes.';

export function PassageBar({ prob }: { prob: number }) {
  const percent = Math.round(prob > 1 ? prob : prob * 100);
  return (
    <div
      className={`passage ${probClass(prob)}`}
      title={`${PASSAGE_LIKELIHOOD_LABEL} ${percent}% — ${PASSAGE_LIKELIHOOD_TOOLTIP}`}
      aria-label={`${PASSAGE_LIKELIHOOD_LABEL} ${percent} percent`}
    >
      <div className="bar">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="pct">{percent}%</span>
    </div>
  );
}

export function FitPill({ fit }: { fit: number }) {
  return (
    <span className="fit-pill" title="Recommendation fit score (0–1)">
      <span className="fl">Fit</span>
      {fit.toFixed(2)}
    </span>
  );
}

export function ChangeChip({ change }: { change: BoardBill['change'] }) {
  if (!change) return null;
  return (
    <span className={`change-chip ${change.tone}`}>
      {change.dot && <span className="cd" />}
      {change.label}
    </span>
  );
}

/**
 * State Legislation Platform (S7.2) — jurisdiction pill for a board/rec card.
 * Absent or 'US' = federal, rendered as nothing (the board is jurisdiction-mixed
 * only once a client's watchlist opts into state jurisdictions, DD5). Reuses the
 * same `.state-pill` class as the Data Explorer state-bill/legislator columns.
 */
export function JurisdictionPill({ jurisdiction }: { jurisdiction?: string }) {
  if (!jurisdiction || jurisdiction === 'US') return null;
  return <span className="state-pill num">{jurisdiction}</span>;
}

export function BillCard({
  bill,
  issueSet,
  justLanded,
  onUntrack,
  onOpen,
}: {
  bill: BoardBill;
  issueSet: Set<string>;
  justLanded: boolean;
  onUntrack: (billId: string) => void;
  onOpen: (bill: BoardBill) => void;
}) {
  // LegiWatch v2 calm re-skin: `.bcard` — bill number + unread + change dot on top,
  // title, passage meter, then a foot row of issue/hearing chips. Click opens the
  // side-drawer; the small filled star untracks (kept off the prototype's chrome
  // but preserved so the board isn't read-only without the drawer).
  return (
    <div
      className={`bcard${justLanded ? ' just-landed' : ''}${bill.terminalRisk ? ' terminal-risk' : ''}`}
      onClick={() => onOpen(bill)}
    >
      <div className="b-top">
        <span className="b-num">{bill.displayNum}</span>
        <JurisdictionPill jurisdiction={bill.jurisdiction} />
        {/* P2-10: unread was a bare dot with a `title`, unreachable by touch or
            screen reader. Now a labelled dot PLUS a visible "New" chip. */}
        {bill.unread && (
          <>
            <span className="b-unread" aria-hidden />
            <span className="chip muted b-new" aria-label="Unread" style={{ fontSize: 10 }}>
              New
            </span>
          </>
        )}
        <span className="grow" />
        {/* P2-10: the change indicator was a colored dot whose only content was
            a `title`. The label it already carried is now visible text. */}
        {bill.change && (
          <span className={`b-change ${bill.change.tone}`}>
            <span className={`dot ${bill.change.tone}`} style={{ width: 7, height: 7 }} aria-hidden />
            {bill.change.label}
          </span>
        )}
        <button
          className="bc-untrack"
          title="Tracked — remove from board"
          style={{
            border: 'none',
            background: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'var(--ink-4)',
            display: 'inline-flex',
          }}
          onClick={(e) => {
            e.stopPropagation();
            onUntrack(bill.billId);
          }}
        >
          <StarIcon filled size={12} />
        </button>
      </div>
      <div className="b-title">{bill.title}</div>
      {/* P2-09: the bill's REAL status. The board has four lanes but the
          detector classifies far more, so without this a failed governing rule
          is visually identical to a bill that is progressing. */}
      {bill.canonicalStatus && (
        <div className={`b-status${bill.terminalRisk ? ' terminal' : ''}`}>
          {bill.canonicalStatus}
        </div>
      )}
      <PassageBar prob={bill.probability} />
      <div className="b-foot">
        {(bill.tags ?? []).slice(0, 2).map((t) => (
          <span key={t} className={`chip ${issueSet.has(t) ? 'issue' : 'muted'}`} style={{ fontSize: 10.5 }}>
            {t}
          </span>
        ))}
        <HearingChip bill={bill} onOpen={onOpen} />
        <LatestActionStamp bill={bill} />
      </div>
      <LatestActionLine bill={bill} onOpen={onOpen} />
    </div>
  );
}

/**
 * P1-18 (Gate E phase c): a column exceeding 50 cards virtualizes — only DOM
 * nodes near the visible window are mounted. Below the threshold, render
 * normally: virtualization breaks Ctrl-F and adds complexity for a column
 * size no real tenant hits today (c-2).
 *
 * Keyboard reachability (c-4): windowing fundamentally means Tab cannot land
 * on an unmounted off-screen card. The mitigation is a real scrollable
 * region (tabIndex, role="group") a keyboard user can focus and page/arrow
 * through with the browser's native scroll-on-focused-container behavior,
 * bringing a card's controls into the DOM (and into Tab order) before
 * tabbing to them — plus generous overscan so short scrolls need no extra
 * step at all.
 */
const BOARD_VIRTUALIZE_THRESHOLD = 50;

export function BoardColumnCards({
  cards,
  issueSet,
  justLanded,
  onUntrack,
  onOpen,
}: {
  cards: BoardBill[];
  issueSet: Set<string>;
  justLanded: string | null;
  onUntrack: (billId: string) => void;
  onOpen: (bill: BoardBill) => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = cards.length > BOARD_VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140,
    overscan: 10,
    enabled: shouldVirtualize,
  });

  if (!shouldVirtualize) {
    return (
      <>
        {cards.map((b) => (
          <BillCard
            key={b.billId}
            bill={b}
            issueSet={issueSet}
            justLanded={justLanded === b.billId}
            onUntrack={onUntrack}
            onOpen={onOpen}
          />
        ))}
      </>
    );
  }

  return (
    <div
      ref={parentRef}
      className="bcol-scroll"
      tabIndex={0}
      role="group"
      aria-label={`${cards.length} tracked bills in this column — scroll for more`}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const b = cards[vi.index]!;
          return (
            <div
              key={b.billId}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                // .bcard's own `margin-top:8px` (`:first-of-type` resets it to
                // 0) does not apply usefully here — each card is alone in its
                // OWN wrapper, so it is trivially ":first-of-type" every
                // time and would render with NO gap at all. Padding on this
                // wrapper (which measureElement includes) replaces it.
                paddingTop: vi.index === 0 ? 0 : 8,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <BillCard
                bill={b}
                issueSet={issueSet}
                justLanded={justLanded === b.billId}
                onUntrack={onUntrack}
                onOpen={onOpen}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export type BoardTableSortKey = 'stage' | 'bill' | 'status' | 'action';
const BOARD_TABLE_STAGE_ORDER: Record<string, number> = {
  introduced: 0,
  committee: 1,
  passed: 2,
  enacted: 3,
};

/**
 * P1-18 (Gate E phase c, c-3): the table-view alternative to the 4-column
 * card grid, per Neo's decision to ship BOTH virtualization and this — one
 * flat, sortable <table> of every loaded card. Far cheaper to render than a
 * large board split across four flex-card columns, and what a large-firm
 * analyst asks for regardless of the virtualization decision.
 *
 * "Owner" (the audit's 5th column) is deliberately NOT included: BoardCard
 * carries no owner/assignee field today — `trackedBy` exists on the DB row
 * but is write-only and never resolved to a display name for the web.
 * Adding it needs a batch user-resolution query (a backend change), which is
 * out of scope for a client-side view toggle. Reported as a gap, not
 * fabricated.
 */
export function BoardTableView({
  columns,
  issueSet,
  onOpen,
}: {
  columns: BoardColumn[];
  issueSet: Set<string>;
  onOpen: (bill: BoardBill) => void;
}) {
  const [sortKey, setSortKey] = useState<BoardTableSortKey>('stage');
  const [sortDesc, setSortDesc] = useState(false);

  const rows = useMemo(() => {
    const flat = columns.flatMap((c) => c.bills.map((b) => ({ ...b, stageLabel: c.label })));
    const sorted = [...flat].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'stage') {
        cmp = (BOARD_TABLE_STAGE_ORDER[a.stage] ?? 9) - (BOARD_TABLE_STAGE_ORDER[b.stage] ?? 9);
      } else if (sortKey === 'bill') {
        cmp = a.displayNum.localeCompare(b.displayNum, undefined, { numeric: true });
      } else if (sortKey === 'status') {
        cmp = (a.canonicalStatus ?? a.stageLabel).localeCompare(b.canonicalStatus ?? b.stageLabel);
      } else {
        cmp = (b.latestActionDate ?? '').localeCompare(a.latestActionDate ?? '');
      }
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [columns, sortKey, sortDesc]);

  const toggleSort = (key: BoardTableSortKey) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(false);
    }
  };
  const indicator = (key: BoardTableSortKey) => (key === sortKey ? (sortDesc ? ' ▼' : ' ▲') : '');

  return (
    <table className="htable board-table">
      <thead>
        <tr>
          <th>
            <button type="button" className="th-sort" onClick={() => toggleSort('stage')}>
              Stage{indicator('stage')}
            </button>
          </th>
          <th>
            <button type="button" className="th-sort" onClick={() => toggleSort('bill')}>
              Bill{indicator('bill')}
            </button>
          </th>
          <th>
            <button type="button" className="th-sort" onClick={() => toggleSort('status')}>
              Status{indicator('status')}
            </button>
          </th>
          <th>
            <button type="button" className="th-sort" onClick={() => toggleSort('action')}>
              Latest action{indicator('action')}
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={4} style={{ textAlign: 'center', padding: 24 }}>
              <span className="muted mini">No tracked bills.</span>
            </td>
          </tr>
        ) : (
          rows.map((b) => (
            <tr key={b.billId} onClick={() => onOpen(b)} style={{ cursor: 'pointer' }}>
              <td data-label="Stage">{b.stageLabel}</td>
              <td data-label="Bill">
                <span className="num" style={{ marginRight: 6 }}>
                  {b.displayNum}
                </span>
                {issueSet.has(b.tags?.[0] ?? '') && b.tags?.[0] ? (
                  <span className="chip issue" style={{ fontSize: 10, marginRight: 6 }}>
                    {b.tags[0]}
                  </span>
                ) : null}
                {b.title}
              </td>
              <td data-label="Status">{b.canonicalStatus ?? b.stageLabel}</td>
              <td data-label="Latest action">{b.latestActionText ?? '—'}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/**
 * Bill 360 (R2 §2.4): the latest official action date, right-aligned in the foot
 * row — the prototype's board-card stamp (mono 10px, ink-4, `margin-left:auto`).
 * The action TEXT is the hover title rather than a second line, so the calm card
 * gains one date and no extra bulk. Renders nothing when the board response
 * carries no date (legacy board, or a cached pre-R2 response).
 */
export function LatestActionStamp({ bill }: { bill: BoardBill }) {
  if (!bill.latestActionDate) return null;
  return (
    <span
      className="num"
      style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-4)', whiteSpace: 'nowrap' }}
    >
      {bill.latestActionDate}
    </span>
  );
}

/**
 * P2-10: the latest action TEXT used to exist only as a hover `title` on the
 * date stamp — unreachable by touch and by screen reader. It is now visible
 * truncated text with an explicit Details control that opens the drawer where
 * the full text lives.
 */
export function LatestActionLine({
  bill,
  onOpen,
}: {
  bill: BoardBill;
  onOpen: (bill: BoardBill) => void;
}) {
  if (!bill.latestActionText) return null;
  return (
    <div className="b-action">
      <span className="b-action-text">{bill.latestActionText}</span>
      <button
        type="button"
        className="b-details"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(bill);
        }}
      >
        Details
      </button>
    </div>
  );
}

/**
 * P9.2 (Bill→Hearing interlink): "discussed in N hearings" chip on a board card.
 * Shown when the bill has hearing links (hearingCount>0, or a lastHearingSessionId
 * badge as a fallback). Opening it opens the same bill drawer — which shows the
 * "Discussed in hearings" section with the exact moments.
 */
export function HearingChip({
  bill,
  onOpen,
}: {
  bill: BoardBill;
  onOpen: (bill: BoardBill) => void;
}) {
  // Gate purely on the board's hearingCount (authoritative, excludes
  // dismissed/snoozed/suppressed). lastHearingSessionId is a linker watermark
  // that is never cleared, so keying off it left a stale "In hearings" chip
  // opening an empty drawer after a user dismissed every hearing alert for the
  // bill (P7/P9 review finding).
  const count = bill.hearingCount ?? 0;
  if (count <= 0) return null;
  return (
    <button
      className="chip"
      title="Discussed in hearings — open to see the moments"
      style={{
        cursor: 'pointer',
        border: 'none',
        background: 'var(--info-soft)',
        color: 'var(--info)',
        fontWeight: 600,
        fontSize: 10.5,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(bill);
      }}
    >
      in {count} hearing{count > 1 ? 's' : ''}
    </button>
  );
}

export function RecCard({
  bill,
  issueSet,
  selectMode,
  selected,
  onToggleSelect,
  onTrack,
  onDismiss,
  onOpen,
}: {
  bill: RecommendationBill;
  issueSet: Set<string>;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (billId: string) => void;
  onTrack: (billId: string) => void;
  onDismiss: (billId: string) => void;
  onOpen: (bill: RecommendationBill) => void;
}) {
  // LegiWatch v2 calm re-skin: `.rcard` — a violet-edged card with the big FIT
  // score on the left, the "why it matches" prose, sponsor, and a Track action.
  const fitPct = Math.round(bill.fit > 1 ? bill.fit : bill.fit * 100);
  const sponsor =
    bill.sponsorName != null
      ? `${bill.sponsorName}${bill.sponsorParty ? ` (${bill.sponsorParty})` : ''}`
      : bill.latestActionDate;
  return (
    <div className={`rcard${selected ? ' selected' : ''}`}>
      <div className="r-fit">
        <span className="fnum">{fitPct}</span>
        <span className="flab">Fit</span>
      </div>
      <div className="r-main">
        <div className="row" style={{ gap: 8 }}>
          {selectMode && (
            <span
              className={`rc-check${selected ? ' on' : ''}`}
              onClick={() => onToggleSelect(bill.billId)}
              title="Select"
            >
              {selected && <Icon name="check" size={12} />}
            </span>
          )}
          <span className="r-num" onClick={() => onOpen(bill)} style={{ cursor: 'pointer' }}>
            {bill.displayNum}
          </span>
          <JurisdictionPill jurisdiction={bill.jurisdiction} />
        </div>
        <div className="r-title" onClick={() => onOpen(bill)} style={{ cursor: 'pointer' }}>
          {bill.title}
        </div>
        <div className="r-why">{bill.why}</div>
        <div className="r-foot">
          {bill.matchedTags.slice(0, 2).map((t) => (
            <span key={t} className={`chip ${issueSet.has(t) ? 'issue' : 'muted'}`} style={{ fontSize: 10.5 }}>
              {t}
            </span>
          ))}
          {sponsor && <span className="mini muted num">{sponsor}</span>}
        </div>
      </div>
      <div className="r-act" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <button className="btn btn-accent sm" onClick={() => onTrack(bill.billId)}>
          <Icon name="plus" size={11} /> Track
        </button>
        <button
          className="btn btn-ghost sm"
          onClick={() => onDismiss(bill.billId)}
          title="Dismiss — trains the feed"
        >
          Not relevant
        </button>
      </div>
    </div>
  );
}

/**
 * The tracker's hand-rolled modal shell, shared by AddBillModal and
 * VerifyOtpModal — the two CUSTOM modals (the composer drawers use antd's
 * `Modal`, which brings its own trapping and must not get a second one).
 *
 * P1-12 / P2-12 (h-2): it had Escape-to-close and nothing else. No dialog role,
 * no accessible name, no initial focus, and no trapping — so a keyboard user
 * Tabbed straight out into the page behind, which was still focusable, with no
 * way back. Fixed HERE rather than in each modal so the two cannot drift.
 */
export function Modal({
  size = 'sm',
  children,
  onClose,
  label,
}: {
  size?: 'sm' | 'md';
  children: React.ReactNode;
  onClose: () => void;
  /** The dialog's accessible name — the same words as its visible title. */
  label?: string;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Owns Escape (and focus restore) so the shell no longer needs its own
  // keydown listener; two would close twice.
  useFocusTrap(dialogRef, true, onClose);
  return (
    <div className="trk-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`trk-dialog ${size}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function AddBillModal({
  clientId,
  boardNums,
  onTrackManual,
  onClose,
}: {
  clientId: string;
  boardNums: Set<string>;
  /** P2-06: returns a promise so the row's "On board" marker can wait for the
   *  write to succeed instead of assuming it did. */
  onTrackManual: (bill: BillSearchResult) => void | Promise<unknown>;
  onClose: () => void;
}) {
  const api = useApi();
  // P1.1: bill-search is served by intel-api (legacy-identical shape) when the
  // tenant is on tracker_v2 — same `trackerV2 ? intel : legacy` pattern as TrackerTab,
  // including the `flagsReady` gate (don't cache a legacy hit under the
  // flag-agnostic key before the flag resolves).
  const { enabled: trackerV2, ready: flagsReady } = useIntelFeature('tracker_v2');
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * P1-17: the jurisdictions this client actually tracks, so the search covers
   * the state legislatures they care about and not all 50.
   *
   * Fetched HERE rather than passed down, because both the watchlist and the
   * alert-prefs queries in TrackerTab are `enabled: activePanel === 'config'`
   * and are therefore empty on the Bills surface (the same chicken-and-egg g-4
   * documents). A modal is user-initiated and transient, so one fetch when it
   * opens is the right cost — unlike adding a query to every board load.
   */
  const prefs = useQuery<{ jurisdictions?: string[] }>({
    queryKey: ['tracker-modal-jurisdictions', clientId],
    queryFn: async () =>
      (await api.get<{ jurisdictions?: string[] }>(intelTrackerPaths.alertPrefs(clientId))).data,
    enabled: trackerV2 && flagsReady,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // DD5 semantics (MASTER §4.5): an EMPTY jurisdictions list means "everything
  // the watchlist produces", NOT "none" — so an empty list defaults to federal
  // only here rather than being "fixed" into a list of all states.
  const clientStates = useMemo(
    () => (prefs.data?.jurisdictions ?? []).filter((j) => j && j !== 'US'),
    [prefs.data],
  );
  const [selectedJuris, setSelectedJuris] = useState<string[] | null>(null);
  // Default = US + whatever the client tracks, recomputed once prefs arrive.
  const jurisdictions = selectedJuris ?? ['US', ...clientStates];

  const results = useQuery<BillSearchResult[]>({
    queryKey: ['tracker-bill-search', clientId, q, jurisdictions.join(',')],
    queryFn: async () =>
      (
        await api.get<BillSearchResult[]>(
          trackerV2 ? intelTrackerPaths.billSearch(clientId) : trackerPaths.billSearch(clientId),
          {
            params: trackerV2 ? { q, jurisdictions } : { q },
          },
        )
      ).data,
    enabled: q.trim().length >= 2 && flagsReady,
    staleTime: 30_000,
  });

  const isTracked = (billId: string) => boardNums.has(billId) || added.has(billId);
  /**
   * P2-06: `added` used to be set the moment the button was clicked, so a bill
   * whose track request FAILED still showed "✓ On board". It is now recorded
   * only after the caller's mutation resolves — `onTrackManual` returns a
   * promise for exactly this.
   */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const handle = (b: BillSearchResult) => {
    setPendingId(b.billId);
    void Promise.resolve(onTrackManual(b))
      .then(() => setAdded((s) => new Set(s).add(b.billId)))
      .catch(() => {
        /* the caller surfaces the error; the row simply stays untracked */
      })
      .finally(() => setPendingId((cur) => (cur === b.billId ? null : cur)));
  };
  const rows = results.data ?? [];

  return (
    <Modal size="md" onClose={onClose} label="Add a bill to the board">
      <div className="dlg-head">
        <h3>Add a bill to the board</h3>
        {/* P1-17: the old copy claimed congress-only while the search WAS
            congress-only — an honest description of a broken capability. Both
            are fixed together. */}
        <span className="sub">
          {trackerV2 && clientStates.length
            ? 'Search Congress and the state legislatures this client tracks, by number or title'
            : 'Search Congress by number or title'}
        </span>
        <button type="button" className="dlg-x" aria-label="Close" onClick={onClose}>
          <Icon name="plus" size={15} style={{ transform: 'rotate(45deg)' }} />
        </button>
      </div>
      <div className="dlg-body">
        <div className="search-field">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. “transmission”, “H.R. 4455”, “data center”…"
          />
        </div>
        {/* P1-17: the jurisdiction facet, defaulted from the client's own
            tracked states. Only shown when there is a real choice to make. */}
        {trackerV2 && clientStates.length > 0 && (
          <div className="search-juris" role="group" aria-label="Jurisdictions">
            {['US', ...clientStates].map((j) => {
              const on = jurisdictions.includes(j);
              return (
                <button
                  key={j}
                  type="button"
                  className={'pick-chip' + (on ? ' on' : '')}
                  aria-pressed={on}
                  onClick={() =>
                    setSelectedJuris(
                      on ? jurisdictions.filter((x) => x !== j) : [...jurisdictions, j],
                    )
                  }
                >
                  {j === 'US' ? 'Congress' : j}
                </button>
              );
            })}
          </div>
        )}
        <div className="search-results">
          {rows.map((b) => (
            <div key={b.billId} className={`sr-row${isTracked(b.billId) ? ' tracked' : ''}`}>
              <span className="sr-num">{b.displayNum}</span>
              {/* P1-17: label the rail so a state result is not mistaken for a
                  federal one with a similar number. */}
              {b.jurisdiction && (
                <span className="sr-juris">{b.jurisdiction === 'US' ? 'Congress' : b.jurisdiction}</span>
              )}
              <span className="sr-title">{b.title}</span>
              <span className="sr-stage">
                {b.stage === 'passed'
                  ? 'Passed'
                  : b.stage === 'committee'
                    ? 'Committee'
                    : b.stage === 'enacted'
                      ? 'Enacted'
                      : 'Introduced'}
              </span>
              {/* P2-06: disabled while its own request is in flight, and the
                  "On board" marker only appears once the write succeeded. */}
              <button
                className="sr-track"
                disabled={pendingId === b.billId || isTracked(b.billId)}
                onClick={() => handle(b)}
              >
                {isTracked(b.billId)
                  ? '✓ On board'
                  : pendingId === b.billId
                    ? 'Adding…'
                    : 'Track'}
              </button>
            </div>
          ))}
          {q.trim().length >= 2 && !results.isFetching && rows.length === 0 && (
            <div className="search-empty">No bills match “{q}”. Try a bill number or keyword.</div>
          )}
          {q.trim().length < 2 && (
            <div className="search-empty">Type at least 2 characters to search.</div>
          )}
        </div>
      </div>
      <div className="dlg-foot">
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
          Tracked bills appear instantly in their legislative-stage column.
        </span>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

export function VerifyOtpModal({
  masked,
  devCode,
  onConfirm,
  onResend,
  onClose,
  submitting,
}: {
  masked: string;
  devCode?: string;
  onConfirm: (code: string) => void;
  onResend: () => void;
  onClose: () => void;
  submitting?: boolean;
}) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  const setD = (i: number, v: string) => {
    if (!/^\d?$/.test(v)) return;
    setDigits((d) => {
      const n = [...d];
      n[i] = v;
      return n;
    });
    if (v && i < 5) refs.current[i + 1]?.focus();
  };
  const onKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  };
  const code = digits.join('');
  const full = code.length === 6;

  return (
    <Modal size="sm" onClose={onClose} label="Verify your phone number">
      <div className="dlg-head">
        <h3>Verify your phone</h3>
        <button type="button" className="dlg-x" aria-label="Close" onClick={onClose}>
          <Icon name="plus" size={15} style={{ transform: 'rotate(45deg)' }} />
        </button>
      </div>
      <div className="dlg-body">
        <div className="otp-meta" style={{ marginBottom: 14 }}>
          We texted a 6-digit code to <span className="ph">{masked}</span>
        </div>
        <div className="otp-row">
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => (refs.current[i] = el)}
              className={`otp-box${d ? ' filled' : ''}`}
              inputMode="numeric"
              maxLength={1}
              value={d}
              onChange={(e) => setD(i, e.target.value.slice(-1))}
              onKeyDown={(e) => onKey(i, e)}
            />
          ))}
        </div>
        <button className="otp-resend" onClick={onResend}>
          Didn’t get it? Resend code
        </button>
        {devCode && (
          <div className="otp-dev">
            SMS delivery isn’t live yet — dev code: <strong>{devCode}</strong>
          </div>
        )}
      </div>
      <div className="dlg-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-accent"
          style={{
            marginLeft: 'auto',
            opacity: full && !submitting ? 1 : 0.5,
            pointerEvents: full && !submitting ? 'auto' : 'none',
          }}
          onClick={() => onConfirm(code)}
        >
          <Icon name="check" size={14} /> Confirm &amp; enable SMS
        </button>
      </div>
    </Modal>
  );
}

export interface ToastItem {
  id: string;
  kind?: 'track' | 'test' | 'text';
  num?: string;
  text?: string;
  channels?: string[];
  /** P1-05: per-channel delivery outcome, so an email failure can't hide behind in-app success. */
  results?: Array<{ channel: string; status: string; detail?: string }>;
}

export function TrackToasts({ toasts }: { toasts: ToastItem[] }) {
  return (
    // P2-12 (h-3): toasts are the ONLY confirmation that a track succeeded or
    // partially failed. Without a live region a screen-reader user gets no
    // feedback at all. `polite` so it does not interrupt mid-sentence.
    <div className="trk-toasts" aria-live="polite">
      {toasts.map((t) => {
        const hasFailure = t.results?.some((r) => r.status === 'failed') ?? false;
        return (
          <div
            key={t.id}
            className={`trk-toast${t.kind === 'test' ? ' test' : ''}${hasFailure ? ' has-failure' : ''}`}
          >
            <span className="ti">
              <Icon name="check" size={12} />
            </span>
            {t.kind === 'test' && t.results?.length ? (
              <div className="t-results">
                <span>Test alert results</span>
                {t.results.map((r) => (
                  <span key={r.channel} className={`t-chip t-${r.status}`} title={r.detail}>
                    {r.channel}: {r.status}
                  </span>
                ))}
              </div>
            ) : t.kind === 'test' ? (
              <>
                <span>Sample alert sent</span>
                <span className="t-chips">
                  {(t.channels ?? []).map((c) => (
                    <span key={c} className="t-chip">
                      {c}
                    </span>
                  ))}
                </span>
              </>
            ) : t.num ? (
              <span>
                Added to board · <span className="tnum">{t.num}</span>
              </span>
            ) : (
              <span>{t.text}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface DropOption {
  v: string;
  l: string;
}

export function TrkDropdown({
  open,
  onToggle,
  label,
  value,
  options,
  onSelect,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  value: string;
  options: DropOption[];
  onSelect: (v: string) => void;
}) {
  return (
    <div className="trk-drop" onClick={(e) => e.stopPropagation()}>
      <button className="trk-drop-btn" onClick={onToggle}>
        <span className="lab">{label}</span>
        <span className="val">{(options.find((o) => o.v === value) || {}).l}</span>
        <Icon name="chev-r" size={13} style={{ transform: 'rotate(90deg)' }} />
      </button>
      {open && (
        <div className="trk-menu">
          {options.map((o) => (
            <div
              key={o.v}
              className={`opt${o.v === value ? ' sel' : ''}`}
              onClick={() => onSelect(o.v)}
            >
              {o.l}
              <span className={`ck${o.v === value ? '' : ' hidden'}`}>
                <Icon name="check" size={13} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SubNav({
  panel,
  setPanel,
  recCount,
  showFeed,
  showConfig = true,
}: {
  panel: string;
  setPanel: (p: 'board' | 'recs' | 'config' | 'feed') => void;
  recCount: number;
  /** Show the unified Feed tab — gated by the `tracker_v2` intel feature flag. */
  showFeed?: boolean;
  /** Hide Configure in the Radar Bills embedding (Watchlist is a sibling Radar tab). */
  showConfig?: boolean;
}) {
  return (
    <div className="trk-seg">
      <button className={panel === 'board' ? 'active' : ''} onClick={() => setPanel('board')}>
        Board
      </button>
      <button className={panel === 'recs' ? 'active' : ''} onClick={() => setPanel('recs')}>
        Recommendations {recCount > 0 && <span className="seg-badge">{recCount}</span>}
      </button>
      {showFeed && (
        <button className={panel === 'feed' ? 'active' : ''} onClick={() => setPanel('feed')}>
          Feed
        </button>
      )}
      {showConfig && (
        <button className={panel === 'config' ? 'active' : ''} onClick={() => setPanel('config')}>
          <span className="seg-cog">
            <Icon name="settings" size={13} />
          </span>{' '}
          Configure
        </button>
      )}
    </div>
  );
}
