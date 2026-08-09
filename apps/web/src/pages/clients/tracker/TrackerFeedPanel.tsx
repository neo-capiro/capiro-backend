import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useNavigate } from 'react-router-dom';
import { useBillTarget } from '../../bills/bill-target.js';
import { App as AntApp, Input, Modal } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import {
  alertBand,
  isPriorScoreModel,
  scoreExplanation,
  feedQueryString,
  intelFeedKeys,
  intelFeedPaths,
  SOURCE_LABEL,
  type FeedFilter,
  type FeedItem,
  type FeedOrder,
  type FeedResponse,
  type RecommendedAction,
} from './intel-feed-api.js';
import { intelTrackerPaths } from './intel-tracker-api.js';
import {
  useAddTalkingPoint,
  useBulkWorkState,
  useEditMemoInWorkspace,
  useSetReport,
  useSetWorkState,
  WORK_STATE_BULK_MAX,
  type WorkStatePatchInput,
} from './alert-actions-api.js';
import { useTeamMembers, type TeamMemberOption } from '../../actions/actions-api.js';
import {
  actionTextOf,
  buildOutreachContextPoolItem,
  renderPacketSummary,
  type GovernmentAffairsAlertPacket,
} from './alert-packet.js';
import { MemoComposerDrawer } from './MemoComposerDrawer.js';
import { DistrictBriefComposerDrawer } from './DistrictBriefComposerDrawer.js';

/**
 * Unified intel FEED panel (Phase 6 §9.7) — bill | hearing | combined alerts with
 * per-source counts, plus intelligent per-alert ACTIONS (draft memo / outreach /
 * pull quotes / add to weekly report / open source). The memo is generated in
 * apps/api (Memory-grounded) and auto-filed to the client's Documents; the alert
 * shows "memo drafted" once done. Gated by `tracker_v2`.
 *
 * LegiWatch v2 re-skin: the "calm design" — collapsible `.acard` cards (one
 * severity cue = the colored left edge), a right rail (Show / Arrange / At a
 * glance), Hanken/Newsreader/JetBrains type. Markup uses the shared calm classes
 * from `radar/legiwatch.css` (scoped under `.lw-root`).
 */

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtTs(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase() || '•'
  );
}

/** Compact inline icon set (matches the prototype's action glyphs). */
function Ic({ n, size = 12 }: { n: string; size?: number }) {
  const paths: Record<string, string> = {
    doc: 'M6 2h7l5 5v15H6z M13 2v5h5',
    mail: 'M3 5h18v14H3z M3 6l9 7 9-7',
    check: 'M4 12l5 5L20 6',
    file: 'M6 2h7l5 5v15H6z',
    audio: 'M12 3v12 M8 7a4 4 0 0 0 8 0 M5 19h14',
    spark: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
    quote: 'M7 7H4v6h3l-1 4 M17 7h-3v6h3l-1 4',
    plus: 'M12 5v14 M5 12h14',
    chevR: 'M9 6l6 6-6 6',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[n] ?? paths.file} />
    </svg>
  );
}

/**
 * P2-15 (Gate E phase e): the feed's empty state said "a tracked bill moves
 * or a hearing hits" — predating state bills, regulations, and Program
 * Elements, all of which the SAME feed already carries (FeedItem.sourceType
 * has covered all six for a while; the copy just never caught up). Built
 * FROM SOURCE_LABEL rather than a second hard-coded list, so it cannot drift
 * from the real source types again. "combined" is a bill+hearing pairing
 * marker, not a distinct source, so it is excluded from the enumeration.
 */
const FEED_SOURCE_NAMES = Object.entries(SOURCE_LABEL)
  .filter(([k]) => k !== 'combined')
  .map(([, label]) => label.toLowerCase());
function joinWithOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

const ACTION_ICON: Record<string, string> = {
  save_recap: 'spark',
  draft_memo: 'doc',
  district_brief: 'file',
  send_outreach: 'mail',
  draft_outreach: 'mail',
  add_to_report: 'check',
  open_bill: 'file',
  open_hearing: 'audio',
  open_program_element: 'file',
  pull_quotes: 'quote',
  add_talking_point: 'plus',
};

/** $X.XB / $XM for a millions figure — matches the dossier + PE formatters. */
function fmtMillionsShort(m: number): string {
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m % 1 ? m.toFixed(1) : m.toFixed(0)}M`;
}

/** Group a flat, already-ordered feed page by client, preserving first-seen order
 *  (LegiWatch v2 "Grouped by client" arrangement at the all-clients altitude). */
function groupByClient(
  items: FeedItem[],
): Array<{ clientId: string; clientName: string; list: FeedItem[] }> {
  const order: string[] = [];
  const map = new Map<string, { clientId: string; clientName: string; list: FeedItem[] }>();
  for (const it of items) {
    let g = map.get(it.clientId);
    if (!g) {
      g = { clientId: it.clientId, clientName: it.clientName ?? 'Client', list: [] };
      map.set(it.clientId, g);
      order.push(it.clientId);
    }
    g.list.push(it);
  }
  return order.map((id) => map.get(id)!);
}

function actionLabel(a: RecommendedAction, item: FeedItem): string {
  if (a.kind === 'draft_memo' && item.actions?.memo) return 'Redraft memo';
  if (a.kind === 'add_to_report') return item.actions?.inReport ? 'In weekly report ✓' : a.label;
  return a.label;
}

/**
 * P1-11: the old chip fired on EVERY alert, because `toCanonicalAlert` hard-codes
 * `whoActs: ''` (it had no feed source) and canonical completeness flagged it —
 * and the tooltip listed raw field names. Canonical completeness stays in
 * observability; the USER-facing warning fires only when a MATERIAL piece of
 * evidence is absent, described in words an analyst can act on.
 *
 * `whoActs` is deliberately NOT here: an unassigned alert is an assignment gap,
 * not an evidence gap, and phase e gives it a real "Assign owner" affordance.
 */
export function materialGaps(item: FeedItem): string[] {
  const gaps: string[] = [];
  if (!item.whyItMatters) gaps.push('client relevance');
  if (!item.evidence?.provenance?.sourceUrl && !item.evidence?.bill?.url)
    gaps.push('a source link');
  if (
    item.sourceType === 'bill' ||
    item.sourceType === 'state_bill' ||
    item.sourceType === 'combined'
  ) {
    if (!item.evidence?.bill?.actionText) gaps.push('the official action text');
  }
  return gaps;
}

/** P1-10: the deadline/urgency cue for a collapsed card. */
function urgencyText(item: FeedItem): string | null {
  if (item.urgency) return item.urgency;
  const d = item.evidence?.bill?.actionDate;
  return d ? `Action ${d}` : null;
}

const BAND_TOOLTIP = 'Ranked from client relevance, materiality, urgency, and client priority.';

/** P2-04: the worklist filter. 'default' hides this user's dismissed + snoozed. */
const WORK_FILTERS: Array<{ v: string; label: string }> = [
  { v: 'default', label: 'Active' },
  { v: 'new', label: 'New' },
  { v: 'in_review', label: 'In review' },
  { v: 'assigned', label: 'Assigned' },
  { v: 'actioned', label: 'Actioned' },
  { v: 'snoozed', label: 'Snoozed' },
  { v: 'dismissed', label: 'Dismissed' },
  { v: 'all', label: 'All' },
];

const WORK_STATE_LABEL: Record<string, string> = {
  new: 'New',
  in_review: 'In review',
  assigned: 'Assigned',
  actioned: 'Actioned',
  snoozed: 'Snoozed',
  dismissed: 'Dismissed',
};

/**
 * Display name for an assignee id, from the tenant roster.
 * MP-15/H-8: a departed member's id no longer appears in the roster — render
 * "Former member", never the raw id (edge case: removed user).
 */
function memberName(members: TeamMemberOption[], userId: string | null): string | null {
  if (!userId) return null;
  const m = members.find((x) => x.userId === userId);
  if (!m) return 'Former member';
  const full = [m.firstName, m.lastName].filter(Boolean).join(' ').trim();
  return full || m.email;
}

function FeedCard({
  item,
  onAction,
  showClient = false,
  onScopeClient,
  members = [],
  selected = false,
  onToggleSelect,
  autoExpand = false,
  onAutoExpanded,
  onEditMemoInWorkspace,
}: {
  item: FeedItem;
  onAction: (a: RecommendedAction, item: FeedItem) => void;
  /** P11 global feed: render a client label so cross-client alerts are attributable. */
  showClient?: boolean;
  /** LegiWatch v2: clicking the client label scopes the whole feature to it. */
  onScopeClient?: (clientId: string) => void;
  /** P2-04: the tenant roster, for the Assign owner picker. */
  members?: TeamMemberOption[];
  selected?: boolean;
  onToggleSelect?: (alertId: string) => void;
  /** g-7: this card is the `&alert=` deep-link target — scroll to it and open it. */
  autoExpand?: boolean;
  onAutoExpanded?: () => void;
  /** RB-04: no generation, no replacement — reads the saved memo and opens it in Workspace. */
  onEditMemoInWorkspace: (item: FeedItem) => void;
}) {
  // LegiWatch v2 (L1): calm card — collapsed by default, expands on demand.
  const [open, setOpen] = useState(false);
  const [showAllQuotes, setShowAllQuotes] = useState(false);
  const api = useApi();
  const ev = item.evidence ?? {};
  const mentions = ev.hearing?.mentions ?? [];
  const actions = item.recommendedActions ?? [];
  const primary = actions.find((a) => a.primary) ?? actions[0];
  const drafted = !!item.actions?.memo;
  const inReport = !!item.actions?.inReport;
  // P1-11 (c-4/c-7): computed ONCE per render. The old code called
  // toCanonicalAlert(item) twice in the same JSX block.
  const gaps = materialGaps(item);
  const band = alertBand(item);
  const urgency = urgencyText(item);
  const sourceUrl = ev.provenance?.sourceUrl ?? ev.bill?.url ?? null;

  /**
   * P1-10 (c-3): the §4.1 packet supplies procedural meaning and the
   * confidence/unknowns block. Fetched LAZILY — `enabled: open` means an
   * unexpanded card costs nothing — and cached per alert id by TanStack, so
   * collapsing and re-expanding does not refetch.
   */
  const packetQ = useQuery({
    queryKey: ['intel-alert-packet', item.clientId, item.id],
    queryFn: async () =>
      (
        await api.get<GovernmentAffairsAlertPacket>(
          `/intel-api/clients/${encodeURIComponent(item.clientId)}/alerts/${encodeURIComponent(item.id)}/packet`,
        )
      ).data,
    enabled: open,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const packet = packetQ.data ?? null;

  // ── P2-04 triage ───────────────────────────────────────────────────────────
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const setWorkState = useSetWorkState();
  const work = item.workState;
  const assigneeName = memberName(members, work?.assignedTo ?? null);

  /**
   * P2-06: pending-then-success, never fire-and-toast. The toast is raised from
   * `onSuccess`, and every button that triggers this disables while pending, so
   * a slow network cannot produce a success message for a request that failed.
   */
  const triage = (patch: WorkStatePatchInput, done: string) =>
    setWorkState.mutate(
      { clientId: item.clientId, alertId: item.id, ...patch },
      {
        onSuccess: () => {
          message.success(done);
          // §4.10 (f-5): Gate D phase e's `dismissed` work state, fired only on
          // the transition INTO it — best-effort, never blocks the triage UX.
          if (patch.state === 'dismissed') {
            void api
              .post(intelTrackerPaths.feedback(item.clientId), {
                targetRef: item.id,
                targetType: 'alert',
                signal: 'alert_ignored',
              })
              .catch(() => {});
          }
        },
        onError: (e: unknown) => message.error(`Could not update: ${(e as Error).message}`),
      },
    );

  const snoozeUntil = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString();
  };

  /**
   * g-7: the `&alert=` deep-link target. Scrolls to the card and expands it,
   * then tells the parent to CLEAR the param — so a refresh does not re-scroll
   * and re-expand a card the user has since collapsed. Runs once.
   */
  const cardRef = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!autoExpand || focusedRef.current) return;
    focusedRef.current = true;
    setOpen(true);
    cardRef.current?.scrollIntoView({ block: 'center' });
    onAutoExpanded?.();
  }, [autoExpand, onAutoExpanded]);

  return (
    <div
      ref={cardRef}
      className={'acard' + (open ? ' open' : '')}
      data-sev={item.severity}
      data-alert-id={item.id}
    >
      {/* P1-12: this header was a `<div onClick>` — a keyboard user could not
          expand a feed card at all. The checkbox and client chip are siblings,
          not children, so the disclosure button wraps only the title block. */}
      <div className="acard-head">
        {onToggleSelect && (
          <input
            type="checkbox"
            className="acard-select"
            aria-label={`Select ${item.title}`}
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(item.id)}
          />
        )}
        <div className="acard-main">
          {/* Only the TITLE is the disclosure control: `acard-meta` below
              contains the client-scope button, and a button cannot nest inside
              another button (invalid HTML, and it breaks both keyboard and AT). */}
          <button
            type="button"
            className={'acard-title' + (open ? '' : ' clip')}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {item.title}
          </button>
          <div className="acard-meta">
            {showClient && (
              <button
                className="chip client"
                onClick={(e) => {
                  e.stopPropagation();
                  onScopeClient?.(item.clientId);
                }}
                title="View only this client"
              >
                <span className="cdot">{initials(item.clientName ?? 'Client')}</span>
                {item.clientName ?? 'Client'}
              </button>
            )}
            <span className="src-label">{SOURCE_LABEL[item.sourceType]}</span>
            {item.tag && (
              <span className="chip tag" title="Matched watchlist tag">
                #{item.tag}
              </span>
            )}
            {/* P1-10 (c-2): severity, in the same critical|notable|info vocabulary
                the alert emails use, so the two surfaces never disagree. */}
            <span className={`chip sev-${item.severity}`} title={`Severity: ${item.severity}`}>
              {item.severity}
            </span>
            {/* P1-10 (c-6) + §4.8 (d-5): the score is shown as an explainable
                BAND, never as a raw 0.72, and the tooltip lists every factor's
                contribution — with "unavailable" for anything we cannot compute. */}
            <span className="chip band" title={scoreExplanation(item)}>
              {band} priority
            </span>
            {urgency && (
              <span className="chip" style={{ fontSize: 10.5 }} title="Deadline / urgency">
                {urgency}
              </span>
            )}
            {/* P1-11 (c-4): replaces the `incomplete` chip, which fired on EVERY
                alert. This one only fires on evidence an analyst can act on. */}
            {gaps.length > 0 && (
              <span
                className="chip warn"
                style={{ fontSize: 10.5 }}
                title={`This alert is missing: ${gaps.join(', ')}`}
              >
                limited evidence
              </span>
            )}
            {/* P2-04: this user's own triage state, never the firm-wide one. */}
            {work && work.state !== 'new' && (
              <span className="chip muted" style={{ fontSize: 10.5 }} title="Your triage state">
                {WORK_STATE_LABEL[work.state] ?? work.state}
                {work.state === 'assigned' && assigneeName ? ` · ${assigneeName}` : ''}
              </span>
            )}
            {drafted && (
              <span className="done-flag">
                <Ic n="check" size={10} /> memo drafted
              </span>
            )}
            {inReport && (
              <span className="chip success" style={{ fontSize: 10.5 }}>
                in weekly report
              </span>
            )}
            <span className="acard-date">{fmtDate(item.createdAt)}</span>
          </div>
        </div>
        {!open && primary && (
          <span className="acard-primary" onClick={(e) => e.stopPropagation()}>
            <button className="btn sm" onClick={() => onAction(primary, item)}>
              <Ic n={ACTION_ICON[primary.kind] ?? 'file'} /> {actionLabel(primary, item)}
            </button>
          </span>
        )}
        <span className="acard-chev">
          <Ic n="chevR" size={15} />
        </span>
      </div>

      {open && (
        <div className="acard-body">
          {/* P1-10 (c-3.1): "why this matters to THIS client". The API has always
              returned it (feed.service selects whyItMatters); the calm card just
              never rendered it. Highest-value restoration in this phase. */}
          {item.whyItMatters && (
            <div className="acard-why">
              <span className="acard-sect">Why this matters</span>
              {item.whyItMatters}
            </div>
          )}

          {/* c-3.2: procedural meaning — the deterministic §4.3 outlook off the
              packet, falling back to the stage the evidence already carries. */}
          {(packet?.proceduralMeaning || ev.bill?.stage) && (
            <div className="acard-why">
              <span className="acard-sect">Procedural meaning</span>
              {packet?.proceduralMeaning ? (
                <>
                  {packet.proceduralMeaning.currentStage}
                  {packet.proceduralMeaning.nextPossibleSteps?.length
                    ? ` — next: ${packet.proceduralMeaning.nextPossibleSteps.join(', ')}`
                    : ''}
                  {packet.proceduralMeaning.blockedBy?.length ? (
                    <div className="muted mini">
                      Blocked by: {packet.proceduralMeaning.blockedBy.join('; ')}
                    </div>
                  ) : null}
                </>
              ) : (
                ev.bill?.stage
              )}
            </div>
          )}

          {ev.bill && (
            <div
              className="acard-evi"
              onClick={() =>
                onAction(
                  { kind: 'open_bill', label: 'Open bill', target: { billId: ev.bill!.billId } },
                  item,
                )
              }
            >
              <span className="evnum">{ev.bill.displayNum}</span>
              <span>
                {ev.bill.stage}
                {ev.bill.actionText ? ` — ${ev.bill.actionText}` : ''}{' '}
                {ev.bill.actionDate ? (
                  <span className="muted num">({ev.bill.actionDate})</span>
                ) : null}
              </span>
            </div>
          )}

          {/* R4 §4.3: a Program Element funding movement. Shows the PE code, the
              delta type, and the exact movement (both amounts in millions), and
              opens Program Element 360 — the line-level source of truth (§4.2). */}
          {ev.programElement && (
            <div
              className="acard-evi"
              onClick={() =>
                onAction(
                  {
                    kind: 'open_program_element',
                    label: 'Open Program Element',
                    target: { peCode: ev.programElement!.peCode },
                  },
                  item,
                )
              }
            >
              <span className="evnum">{ev.programElement.peCode}</span>
              <span>
                {ev.programElement.deltaTypeLabel}
                {ev.programElement.title ? ` — ${ev.programElement.title}` : ''}{' '}
                <span className="muted num">
                  (FY{ev.programElement.fiscalYear}
                  {ev.programElement.amountFromMillions != null &&
                  ev.programElement.amountToMillions != null
                    ? `, ${fmtMillionsShort(ev.programElement.amountFromMillions)} → ${fmtMillionsShort(ev.programElement.amountToMillions)}`
                    : ''}
                  )
                </span>
              </span>
            </div>
          )}

          {mentions.length > 0 && (
            <div>
              {(showAllQuotes ? mentions : mentions.slice(0, 1)).map((m, i) => (
                <div className="acard-quote" key={m.segmentId ?? i}>
                  <span className="qts">{fmtTs(m.timestampMs)}</span>
                  <span>
                    {m.speakerName ? <b>{m.speakerName}: </b> : null}
                    {m.quote ? (
                      `“${m.quote}”`
                    ) : (
                      <i className="muted">[encrypted — open hearing to view]</i>
                    )}
                  </span>
                </div>
              ))}
              {mentions.length > 1 && !showAllQuotes && (
                <div className="more-quotes" onClick={() => setShowAllQuotes(true)}>
                  +{mentions.length - 1} more quote{mentions.length - 1 === 1 ? '' : 's'}
                </div>
              )}
            </div>
          )}

          {/* c-3.3: the official source, as an explicit link. Gate C made
              provenance.sourceUrl reliable, so this stops being a guess. */}
          {sourceUrl && (
            <div className="acard-why">
              <span className="acard-sect">Source</span>
              <a href={sourceUrl} target="_blank" rel="noreferrer noopener">
                View official source
              </a>
            </div>
          )}

          {/* c-3.4: who should act. An unassigned alert gets a real affordance
              rather than the empty string that used to flag every card.
              MP-15 / Gate H d-5: item.workState.assignedToName is declared but no
              server code has ever produced it, so this rendered a raw DB user id
              in production. `assigneeName` already resolves the SAME assignedTo
              against the SAME tenant-admin roster for the collapsed-card chip
              (line ~437) — reuse it here instead of the dead field. */}
          <div className="acard-why">
            <span className="acard-sect">Who should act</span>
            {item.workState?.assignedTo ? (
              <span>{assigneeName ?? item.workState.assignedTo}</span>
            ) : (
              <span className="muted">Unassigned</span>
            )}
          </div>

          {/* c-3.5: confidence and unknowns — the packet's own coverage numbers,
              never a number without an explanation. */}
          {packet?.confidence && (
            <div className="acard-why">
              <span className="acard-sect">Confidence and unknowns</span>
              <span>
                Evidence coverage {Math.round((packet.confidence.evidenceCoverage ?? 0) * 100)}%
              </span>
              {packet.confidence.missingFields?.length ? (
                <div className="muted mini">
                  Not established: {packet.confidence.missingFields.join(', ')}
                </div>
              ) : null}
              {packet.proceduralMeaning?.uncertainty?.length ? (
                <div className="muted mini">{packet.proceduralMeaning.uncertainty.join('; ')}</div>
              ) : null}
            </div>
          )}

          {/* P2-05: an alert that ALREADY has a memo offers ways to reach it,
              not just "Redraft". documentAttachmentId has been in the contract
              all along; nothing surfaced it. */}
          {item.actions?.memo && (
            <div className="acard-actions">
              <button
                className="btn sm btn-ghost"
                onClick={() => {
                  // MP-13 / Gate H phase b: the client profile's Documents tab, via
                  // the SAME ?tab= deep link tracker emails already use, plus
                  // ?attachmentId= so DocumentsTab highlights the exact row —
                  // apps/api still exposes no per-attachment download ROUTE, so
                  // this lands on the record rather than fetching it directly.
                  const attId = item.actions?.memo?.documentAttachmentId;
                  const qs = new URLSearchParams({ clientId: item.clientId, tab: 'documents' });
                  if (attId) qs.set('attachmentId', attId);
                  navigate(`/clients?${qs.toString()}`);
                }}
              >
                <Ic n="doc" /> Open memo
              </button>
              <button className="btn sm btn-ghost" onClick={() => onEditMemoInWorkspace(item)}>
                <Ic n="spark" /> Edit in Workspace
              </button>
              <button
                className="btn sm btn-ghost"
                onClick={() => {
                  const reviewId = item.actions?.memo?.reviewRequestId;
                  navigate(reviewId ? `/reviews?id=${encodeURIComponent(reviewId)}` : '/reviews');
                }}
              >
                <Ic n="check" /> Review history
              </button>
            </div>
          )}

          {/* P2-04: triage. Every control disables while its mutation is in
              flight, and success is reported from onSuccess (P2-06). */}
          <div className="acard-actions" aria-label="Triage">
            <button
              className="btn sm btn-ghost"
              disabled={setWorkState.isPending}
              onClick={() => triage({ state: 'in_review' }, 'Marked reviewed')}
            >
              <Ic n="check" /> Mark reviewed
            </button>
            <label className="btn sm btn-ghost" style={{ gap: 6 }}>
              Assign
              <select
                aria-label="Assign owner"
                value={work?.assignedTo ?? ''}
                disabled={setWorkState.isPending || members.length === 0}
                onChange={(e) =>
                  e.target.value
                    ? triage({ state: 'assigned', assignedTo: e.target.value }, 'Owner assigned')
                    : triage({ state: 'in_review', assignedTo: null }, 'Owner cleared')
                }
              >
                {/* §6.4 / edge case 10: the options come from the tenant's own
                    roster, so an id that is not a member cannot be stored. There
                    is deliberately no free-text user-id field. */}
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {memberName(members, m.userId)}
                  </option>
                ))}
              </select>
            </label>
            <label className="btn sm btn-ghost" style={{ gap: 6 }}>
              Snooze
              <select
                aria-label="Snooze"
                value=""
                disabled={setWorkState.isPending}
                onChange={(e) => {
                  if (!e.target.value) return;
                  triage(
                    { state: 'snoozed', snoozedUntil: snoozeUntil(Number(e.target.value)) },
                    'Snoozed',
                  );
                }}
              >
                <option value="">Choose…</option>
                <option value="1">1 day</option>
                <option value="7">1 week</option>
                <option value="30">30 days</option>
              </select>
            </label>
            <button
              className="btn sm btn-ghost"
              disabled={setWorkState.isPending}
              onClick={() => triage({ state: 'dismissed' }, 'Dismissed')}
            >
              Dismiss
            </button>
            {/* MP-14 / Gate H phase c: these are honest navigation, not alert-scoped
                actions — no task or strategy record is created here. Neo confirmed
                c-2 (relabel) over c-1 (build real linked records) for this gate. */}
            <button className="btn sm btn-ghost" onClick={() => navigate('/actions')}>
              Open Action Board
            </button>
            <button className="btn sm btn-ghost" onClick={() => navigate('/strategies')}>
              Open Strategies
            </button>
          </div>

          {actions.length > 0 && (
            <div className="acard-actions">
              {actions.map((a, i) => (
                <button
                  key={a.kind}
                  className={
                    'btn sm' +
                    (i === 0
                      ? ' btn-accent'
                      : a.kind === 'open_bill' || a.kind === 'open_hearing'
                        ? ' btn-ghost'
                        : '')
                  }
                  onClick={() => onAction(a, item)}
                >
                  <Ic n={ACTION_ICON[a.kind] ?? 'file'} /> {actionLabel(a, item)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * P1-18 (Gate E phase c): the feed's flat (non-grouped) item list virtualizes
 * once a loaded page set exceeds 100 items — only DOM nodes near the visible
 * window are mounted. Below that, render normally (c-2). FeedCard's height
 * varies hugely between collapsed and expanded (quotes, actions, confidence
 * block all appear only when open), so `measureElement` (dynamic
 * measurement) is used rather than trusting a fixed estimate.
 *
 * The GROUPED-by-client arrangement (global + group=true) is intentionally
 * NOT virtualized here — group boundaries make windowing meaningfully more
 * complex, and it is an opt-in, less-common view where each group is
 * typically much smaller than the full page anyway.
 */
const FEED_VIRTUALIZE_THRESHOLD = 100;

function FeedItemsList({
  items,
  onAction,
  showClient,
  onScopeClient,
  members,
  selectedIds,
  toggleSelect,
  focusAlertId,
  onFocused,
  onEditMemoInWorkspace,
}: {
  items: FeedItem[];
  onAction: (a: RecommendedAction, item: FeedItem) => void;
  showClient: boolean;
  onScopeClient?: (clientId: string) => void;
  members: TeamMemberOption[];
  selectedIds: string[];
  toggleSelect: (alertId: string) => void;
  focusAlertId?: string | null;
  onFocused?: () => void;
  onEditMemoInWorkspace: (item: FeedItem) => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = items.length > FEED_VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 90,
    overscan: 6,
    enabled: shouldVirtualize,
  });

  const card = (it: FeedItem) => (
    <FeedCard
      key={it.id}
      item={it}
      onAction={onAction}
      showClient={showClient}
      onScopeClient={onScopeClient}
      members={members}
      selected={selectedIds.includes(it.id)}
      onToggleSelect={toggleSelect}
      autoExpand={focusAlertId === it.id}
      onAutoExpanded={onFocused}
      onEditMemoInWorkspace={onEditMemoInWorkspace}
    />
  );

  if (!shouldVirtualize) {
    return <div className="feed">{items.map(card)}</div>;
  }

  return (
    <div
      ref={parentRef}
      className="feed feed-virtual"
      tabIndex={0}
      role="group"
      aria-label={`${items.length} alerts loaded — scroll for more`}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const it = items[vi.index]!;
          return (
            <div
              key={it.id}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {card(it)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TrackerFeedPanel({
  clientId,
  clientName,
  onOpenBill,
  onScopeClient,
  global = false,
  focusAlertId,
  onFocused,
  railTop,
}: {
  /** Per-client mode: the client to scope to. Omitted/ignored in `global` mode. */
  clientId?: string;
  clientName?: string;
  /**
   * LegiWatch v2 (L1): global feed only — clicking a card's client label scopes the
   * whole feature to that client. RadarPage passes a setter for the `client` URL param.
   */
  onScopeClient?: (clientId: string) => void;
  /**
   * P3/P9.1: when provided, `open_bill` alert actions open the bill in place
   * (the Radar/profile bill side-drawer) instead of navigating to Data Explorer.
   * Falls back to `/explorer?bill=` navigation for any other caller (back-compat).
   * The alert's own clientId is passed as the 2nd arg so the global feed (P11) can
   * open the drawer scoped to the right client.
   */
  onOpenBill?: (billId: string, clientId: string) => void;
  /**
   * P11 global altitude: render the TENANT-WIDE cross-client roll-up (each card
   * labels its client) instead of one client's feed. Actions still work — every
   * per-alert operation is scoped to `item.clientId`.
   */
  global?: boolean;
  /** g-7: `&alert=<id>` deep link from an alert email. */
  focusAlertId?: string | null;
  onFocused?: () => void;
  /**
   * Rendered at the top of the right rail, above the feed's own controls.
   * LegiWatch passes its schedule/board/coverage widgets here; the
   * client-profile embedding passes nothing, so that surface is unchanged.
   * Kept as a slot rather than built in so this shared panel does not take on
   * the page's queries.
   */
  railTop?: ReactNode;
}) {
  const api = useApi();
  const navigate = useNavigate();
  // Bill 360 when the tenant has it, Explorer otherwise — never a dark surface.
  const billTarget = useBillTarget();
  const { message } = AntApp.useApp();
  const [source, setSource] = useState<FeedFilter>('all');
  // P1-10: the API has supported order=score since Phase 6 (feed.service.ts:146,
  // 187-190) with a covering index, and the web hard-coded 'date'. It is now a
  // control. Newest stays the DEFAULT — the calm design leads with recency, and
  // the feed-lead copy says so.
  const [order, setOrder] = useState<FeedOrder>('date');
  // LegiWatch v2 (L1): global feed arrangement — single stream (default) or grouped
  // by client. Never the default; only offered at the all-clients altitude.
  const [group, setGroup] = useState(false);
  // P2-04: the worklist filter. 'default' = this user's active queue, which
  // EXCLUDES their dismissed and still-snoozed alerts.
  // An alert email is an explicit request to inspect that alert. Start on
  // All so the user's own dismissed/snoozed work state cannot make a valid
  // deep-link target disappear before the panel has a chance to find it.
  const [workFilter, setWorkFilter] = useState(focusAlertId ? 'all' : 'default');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [composerItem, setComposerItem] = useState<FeedItem | null>(null);
  const [briefItem, setBriefItem] = useState<FeedItem | null>(null);
  const [tpItem, setTpItem] = useState<FeedItem | null>(null);
  const [tpText, setTpText] = useState('');
  const focusExhaustedRef = useRef<string | null>(null);

  // A focused alert can arrive after mount when URL state changes in place.
  // Keep the visible work-state control honest about the widened search.
  useEffect(() => {
    if (!focusAlertId) return;
    // The target may not belong to the source filter the analyst was using
    // before an email link arrived in-place. Widen both controls visibly.
    setSource('all');
    setWorkFilter('all');
    focusExhaustedRef.current = null;
  }, [focusAlertId]);

  const setReport = useSetReport();
  const addTalkingPoint = useAddTalkingPoint();
  // §6.4: a real tenant roster already exists and is reused here, so Assign
  // owner stores a member id the picker returned — never free text.
  const team = useTeamMembers();
  const members = Array.isArray(team.data) ? team.data : [];
  const bulkWorkState = useBulkWorkState();

  // P10: acting on a feed alert = hand-off. "Draft outreach" creates a real
  // outreach DRAFT record seeded with the alert as a context item, then deep-links
  // the wizard's resume path (/engagement/outreach/draft/:id). The wizard hydrates
  // client/title/context from metadata and resumes at the Build Context step — no
  // wizard changes needed. Mirrors the DTO in engagement.controller.ts
  // (CreateOutreachRecordDto: type/clientId/title/direction/lastStep/metadata/contextPool).
  const draftOutreach = useMutation({
    mutationFn: async (item: FeedItem) => {
      // P1-13: the wizard used to open with `whyItMatters + one bill action`, dropping
      // every hearing quote and speaker, every PE funding delta, every regulation field,
      // the official source URL, the client's position/priority, the active strategy, and
      // the target offices. Fetch the server-built §4.1 packet instead.
      //
      // .catch(() => null) is load-bearing: a packet-fetch failure must NEVER block the
      // outreach draft, and the fallback is byte-identical to the old projection.
      const packet = await api
        .get<GovernmentAffairsAlertPacket>(
          `/intel-api/clients/${encodeURIComponent(item.clientId)}/alerts/${encodeURIComponent(item.id)}/packet`,
        )
        .then((r) => r.data)
        .catch(() => null);
      const body = packet ? renderPacketSummary(packet) : actionTextOf(item);
      const ctxId = `alert-${item.id}`;
      const contextItem = {
        id: ctxId,
        kind: 'intel' as const,
        title: item.title,
        body,
        tag: 'LegiWatch alert',
        scope: 'all' as const,
        note: '',
      };
      const res = await api.post<{ id: string }>('/api/engagement/outreach', {
        type: 'campaign',
        clientId: item.clientId, // scope to the alert's own client (global feed too)
        title: `Re: ${item.title}`.slice(0, 240),
        direction: 'on-behalf',
        lastStep: 4,
        metadata: {
          source: 'radar-alert',
          direction: 'on-behalf',
          lastStepId: 'context',
          tone: 'Professional',
          targets: [],
          contextItems: [contextItem],
        },
        // The projection the API stores at the top level so Meri generation sees the
        // alert as a context source (mirrors the wizard's contextPool). Since P1-13 this
        // carries the PACKET-derived context, not the old one-line summary.
        //
        // The packet is nested in `summary` rather than sent as its own key on purpose:
        // OutreachContextPoolItemDto is strictly typed and the global ValidationPipe runs
        // forbidNonWhitelisted, so an unwhitelisted `packet` key would 400 the whole POST
        // — and widening that DTO would touch a contract the outreach wizard also uses.
        // Slice to the DTO bounds (title @Length(1,240), summary @Length(0,2000)):
        // intel_alert.title is unbounded and federal bill/hearing titles routinely
        // exceed 240, which would 400 the whole POST (review finding).
        contextPool: [buildOutreachContextPoolItem(ctxId, item, body)],
      });
      return res.data;
    },
    onSuccess: (record) => {
      message.success('Outreach draft created — opening the wizard');
      navigate(`/engagement/outreach/draft/${encodeURIComponent(record.id)}`);
    },
    onError: (e: unknown) =>
      message.error(`Could not create outreach draft: ${(e as Error).message}`),
  });

  // RB-04 / Gate H a-1: "Edit in Workspace" on an alert that already has a memo
  // — reads the saved content and opens it directly, never through the
  // generate-on-open composer (that path is Redraft memo, a separate,
  // confirm-gated action inside MemoComposerDrawer).
  const editInWorkspace = useEditMemoInWorkspace();
  const handleEditMemoInWorkspace = (item: FeedItem) => {
    if (editInWorkspace.isPending) return;
    editInWorkspace.mutate(
      {
        clientId: item.clientId,
        alertId: item.id,
        clientName: item.clientName ?? clientName ?? '',
        fallbackTitle: `Client memo — ${item.title}`,
      },
      {
        onSuccess: (draftId) => {
          message.success('Opened in Workspace');
          navigate(`/workspace/draft/${encodeURIComponent(draftId)}`);
        },
        onError: (e: unknown) => message.error((e as Error).message),
      },
    );
  };

  // P11: global mode reads the tenant-wide roll-up (`_all/feed`) under a distinct
  // cache key; per-client mode is unchanged. The path/key switch is the ONLY
  // difference — filters, keyset cursor, and page shape are identical.
  const focusedAlert = useQuery<FeedResponse>({
    queryKey: ['intel-feed-alert', global ? '_all' : clientId, focusAlertId],
    queryFn: async () => {
      const base = global
        ? '/intel-api/clients/_all/feed/alerts'
        : `/intel-api/clients/${encodeURIComponent(clientId!)}/feed/alerts`;
      return (await api.get<FeedResponse>(`${base}/${encodeURIComponent(focusAlertId!)}`)).data;
    },
    enabled: Boolean(focusAlertId),
    retry: false,
  });

  const query = useInfiniteQuery({
    queryKey: global
      ? [...intelFeedKeys.tenantFeed(source, order), workFilter]
      : [...intelFeedKeys.feed(clientId!, source, order), workFilter],
    queryFn: async ({ pageParam }) => {
      const path = global ? intelFeedPaths.tenantFeed() : intelFeedPaths.feed(clientId!);
      return (
        await api.get<FeedResponse>(
          `${path}?${feedQueryString(source, order, pageParam || undefined, workFilter)}`,
        )
      ).data;
    },
    initialPageParam: '',
    getNextPageParam: (last: FeedResponse) =>
      last.hasMore && last.nextCursor ? last.nextCursor : undefined,
  });

  const pageItems = query.data?.pages.flatMap((p) => p.items) ?? [];
  const focusedItem = focusedAlert.data?.items[0];
  const items =
    focusedItem && !pageItems.some((item) => item.id === focusedItem.id)
      ? [focusedItem, ...pageItems]
      : pageItems;

  /** A direct alert-id lookup avoids walking an entire feed for a stale link. */
  useEffect(() => {
    if (!focusAlertId || focusedAlert.isLoading) return;
    if (focusedAlert.isError) {
      const key = `${focusAlertId}:error`;
      if (focusExhaustedRef.current !== key) {
        focusExhaustedRef.current = key;
        message.warning('Could not load the linked alert. The active feed is still available.');
        onFocused?.();
      }
      return;
    }
    if (!focusedItem) {
      const key = `${focusAlertId}:missing`;
      if (focusExhaustedRef.current !== key) {
        focusExhaustedRef.current = key;
        message.warning('The linked alert is no longer available in this feed.');
        onFocused?.();
      }
      return;
    }
    focusExhaustedRef.current = null;
  }, [focusAlertId, focusedAlert.isLoading, focusedAlert.isError, focusedItem, message, onFocused]);

  // §4.8 edge case 4: how many loaded alerts predate the re-weight.
  const priorModelCount = items.filter(isPriorScoreModel).length;
  const counts = query.data?.pages[0]?.counts ?? {};
  const sevCounts = query.data?.pages[0]?.severityCounts ?? {};
  const totalUpdates = Object.values(counts).reduce((n, v) => n + (v ?? 0), 0);

  const onAction = (a: RecommendedAction, item: FeedItem) => {
    switch (a.kind) {
      case 'draft_memo':
        setComposerItem(item);
        break;
      case 'district_brief':
        setBriefItem(item);
        break;
      case 'open_bill':
        if (a.target?.billId) {
          // Bill 360 (R2 §2.5): a feed action opens the dossier drawer in place when
          // the host provides one, and otherwise the canonical /bills/:id page. The
          // old fallback routed to the Explorer drill-in, which §2.5 removed as a
          // bill entry point.
          if (onOpenBill) onOpenBill(a.target.billId, item.clientId);
          else navigate(billTarget(a.target.billId));
        }
        break;
      case 'open_hearing':
        if (a.target?.sessionId)
          navigate(`/intelligence/hearing-watch/${encodeURIComponent(a.target.sessionId)}`);
        break;
      case 'open_program_element':
        // R4 §4.3: the PE alert deep-links to Program Element 360.
        if (a.target?.peCode) navigate(`/program-elements/${encodeURIComponent(a.target.peCode)}`);
        break;
      case 'pull_quotes': {
        const qs = (item.evidence?.hearing?.mentions ?? [])
          .map((m) => `${m.speakerName ? `${m.speakerName}: ` : ''}${m.quote ?? ''}`.trim())
          .filter(Boolean);
        if (qs.length) {
          // P2-06: same un-awaited + optional-chained clipboard bug as the two
          // composer drawers — it claimed success while copying nothing.
          void navigator.clipboard
            .writeText(qs.join('\n'))
            .then(() => message.success(`Copied ${qs.length} quote${qs.length === 1 ? '' : 's'}`))
            .catch(() =>
              message.warning('Could not copy automatically — select the text and copy manually.'),
            );
        } else {
          message.info('No decrypted quotes available — open the hearing to view.');
        }
        break;
      }
      case 'draft_outreach':
        if (!draftOutreach.isPending) draftOutreach.mutate(item);
        break;
      case 'add_talking_point':
        setTpItem(item);
        setTpText(
          `${item.title}${item.whyItMatters ? ` — ${item.whyItMatters}` : ''}`.slice(0, 300),
        );
        break;
      case 'add_to_report': {
        const on = !item.actions?.inReport;
        setReport.mutate(
          { clientId: item.clientId, alertId: item.id, on },
          {
            onSuccess: () =>
              message.success(on ? 'Added to weekly report' : 'Removed from weekly report'),
          },
        );
        break;
      }
    }
  };

  const toggleSelect = (alertId: string) =>
    setSelectedIds((prev) =>
      prev.includes(alertId) ? prev.filter((x) => x !== alertId) : [...prev, alertId],
    );

  /**
   * P2-04 + P2-06: bulk triage reports PARTIAL failure. The hook chunks at
   * WORK_STATE_BULK_MAX and returns per-chunk outcomes, so "12 of 30" is a real
   * count rather than an optimistic claim, and the selection clears only after
   * every call settles.
   */
  const runBulk = (state: WorkStatePatchInput['state'], label: string) => {
    const ids = new Set(selectedIds);
    // The bulk route is client-scoped, and the global roll-up mixes clients —
    // group by each alert's OWN clientId rather than assuming one.
    const byClient = new Map<string, string[]>();
    for (const it of items) {
      if (!ids.has(it.id)) continue;
      byClient.set(it.clientId, [...(byClient.get(it.clientId) ?? []), it.id]);
    }
    const groups = [...byClient.entries()];
    void Promise.allSettled(
      groups.map(([cid, alertIds]) =>
        bulkWorkState.mutateAsync({ clientId: cid, alertIds, state }),
      ),
    ).then((results) => {
      let ok = 0;
      let failed = 0;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          ok += r.value.ok;
          failed += r.value.failed;
          // §4.10 (f-5): only when the WHOLE group succeeded — the bulk result
          // is a count, not per-id outcomes, so a partial failure can't tell us
          // which ids to attribute the signal to. Conservative: skip the group.
          if (state === 'dismissed' && r.value.failed === 0) {
            const [cid, alertIds] = groups[i]!;
            for (const alertId of alertIds) {
              void api
                .post(intelTrackerPaths.feedback(cid), {
                  targetRef: alertId,
                  targetType: 'alert',
                  signal: 'alert_ignored',
                })
                .catch(() => {});
            }
          }
        } else {
          failed += [...byClient.values()][i]?.length ?? 1;
        }
      });
      if (failed > 0)
        message.warning(`${label}: ${ok} of ${ok + failed} updated — ${failed} failed`);
      else message.success(`${label}: ${ok} updated`);
      setSelectedIds([]);
    });
  };

  // Right-rail "Show" options — source facet with tenant/client-scoped counts.
  const srcOpts: Array<{ v: FeedFilter; label: string; n?: number }> = [
    { v: 'all', label: 'All sources' },
    { v: 'bill', label: 'Bill moves', n: counts.bill ?? 0 },
    { v: 'state_bill', label: 'State bills', n: counts.state_bill ?? 0 },
    { v: 'hearing', label: 'Hearings', n: counts.hearing ?? 0 },
    { v: 'combined', label: 'Bill + Hearing', n: counts.combined ?? 0 },
    { v: 'regulation', label: 'Regulations', n: counts.regulation ?? 0 },
    // R4 §4.3: PE funding movements share the client feed with bills and hearings.
    { v: 'program_element', label: 'Program elements', n: counts.program_element ?? 0 },
  ];

  const body = (() => {
    if (query.isLoading) {
      return (
        <div className="feed">
          {[86, 64, 72].map((h, i) => (
            <div key={i} className="skel" style={{ height: h }} />
          ))}
        </div>
      );
    }
    if (query.isError) {
      return (
        <div className="guide plain">
          <h4>Feed unavailable</h4>
          <p>We couldn’t load the alert feed. Try again in a moment.</p>
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div className="guide">
          <div className="gico">
            <Ic n="check" size={20} />
          </div>
          <h4>Nothing new right now</h4>
          <p>
            {global
              ? `When a ${joinWithOr(FEED_SOURCE_NAMES)} moves for any client, it lands here — newest first.`
              : `When a ${joinWithOr(FEED_SOURCE_NAMES)} moves for ${clientName ?? 'this client'}, it lands here.`}
          </p>
        </div>
      );
    }
    if (global && group) {
      return (
        <div className="feed">
          {groupByClient(items).map((g) => (
            <div key={g.clientId}>
              <div className="group-label">
                <button
                  className="chip client"
                  onClick={() => onScopeClient?.(g.clientId)}
                  title="View only this client"
                >
                  <span className="cdot">{initials(g.clientName)}</span>
                  {g.clientName}
                </button>
                <span className="muted mini">
                  {g.list.length} update{g.list.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="feed" style={{ marginTop: 6 }}>
                {g.list.map((it) => (
                  <FeedCard
                    key={it.id}
                    item={it}
                    onAction={onAction}
                    showClient={false}
                    onScopeClient={onScopeClient}
                    members={members}
                    selected={selectedIds.includes(it.id)}
                    onToggleSelect={toggleSelect}
                    autoExpand={focusAlertId === it.id}
                    onAutoExpanded={onFocused}
                    onEditMemoInWorkspace={handleEditMemoInWorkspace}
                  />
                ))}
              </div>
            </div>
          ))}
          {query.hasNextPage && (
            <button
              className="btn"
              style={{ margin: '4px auto 0' }}
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      );
    }
    return (
      <>
        <FeedItemsList
          items={items}
          onAction={onAction}
          showClient={global}
          onScopeClient={onScopeClient}
          members={members}
          selectedIds={selectedIds}
          toggleSelect={toggleSelect}
          focusAlertId={focusAlertId}
          onFocused={onFocused}
          onEditMemoInWorkspace={handleEditMemoInWorkspace}
        />
        {query.hasNextPage && (
          <button
            className="btn"
            style={{ margin: '4px auto 0' }}
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </>
    );
  })();

  return (
    <div className="feed-layout">
      <div className="feed-main">
        {/* P2-12 (h-3): the result count changes when a filter or the ordering
            changes, and that change is the only feedback either produces. */}
        <div className="feed-lead" aria-live="polite">
          {global
            ? 'What changed across all clients'
            : `What changed for ${clientName ?? 'this client'}`}{' '}
          · {totalUpdates} update{totalUpdates === 1 ? '' : 's'}
        </div>
        {/* P2-04: bulk triage. Reuses the existing .bulk-bar pattern. Reports
            PARTIAL failure — never a blanket success (P2-06). */}
        {selectedIds.length > 0 && (
          <div className="bulk-bar" role="region" aria-label="Bulk triage">
            <span>
              {selectedIds.length} selected
              {selectedIds.length > WORK_STATE_BULK_MAX
                ? ` — sent in ${Math.ceil(selectedIds.length / WORK_STATE_BULK_MAX)} batches`
                : ''}
            </span>
            {(
              [
                ['in_review', 'Mark reviewed'],
                ['actioned', 'Mark actioned'],
                ['dismissed', 'Dismiss'],
              ] as const
            ).map(([state, label]) => (
              <button
                key={state}
                className="btn sm"
                disabled={bulkWorkState.isPending}
                onClick={() => runBulk(state, label)}
              >
                {label}
              </button>
            ))}
            <button className="btn sm btn-ghost" onClick={() => setSelectedIds([])}>
              Clear
            </button>
          </div>
        )}
        {body}
      </div>

      <aside className="feed-rail">
        {railTop}
        {/* P1-10: Newest / Priority. `order` is already part of the query key
            AND the query string, so switching refetches under a distinct cache
            entry with no other change. */}
        <div className="rail-card">
          <div className="rc-t">Order</div>
          <div className="seg-toggle" role="group" aria-label="Feed ordering">
            <button
              type="button"
              aria-pressed={order === 'date'}
              className={order === 'date' ? 'on' : ''}
              onClick={() => setOrder('date')}
            >
              Newest
            </button>
            <button
              type="button"
              aria-pressed={order === 'score'}
              className={order === 'score' ? 'on' : ''}
              onClick={() => setOrder('score')}
              title={BAND_TOOLTIP}
            >
              Priority
            </button>
          </div>
          {/* §4.8 edge case 4: scoring is FORWARD-ONLY (§6.2), so this list can
              mix alerts scored by two different models. Saying so is the
              condition on which the re-weight ships — it must not be silent. */}
          {order === 'score' && priorModelCount > 0 && (
            <div className="muted mini" style={{ marginTop: 6 }}>
              Ranked by the current model. {priorModelCount} alert
              {priorModelCount === 1 ? '' : 's'} on this page{' '}
              {priorModelCount === 1 ? 'was' : 'were'} scored by the prior model and may rank
              differently.
            </div>
          )}
        </div>

        {/* P2-04: the worklist. Default is this user's ACTIVE queue — their
            dismissed and still-snoozed alerts are excluded server-side. */}
        <div className="rail-card">
          <div className="rc-t">Worklist</div>
          {WORK_FILTERS.map((o) => (
            <button
              key={o.v}
              className={'rail-opt' + (workFilter === o.v ? ' on' : '')}
              aria-pressed={workFilter === o.v}
              onClick={() => {
                setWorkFilter(o.v);
                setSelectedIds([]);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div className="rail-card">
          <div className="rc-t">Show</div>
          {srcOpts.map((o) => (
            <button
              key={o.v}
              className={'rail-opt' + (source === o.v ? ' on' : '')}
              onClick={() => setSource(o.v)}
            >
              {o.label}
              {o.n != null && <span className="n">{o.n}</span>}
            </button>
          ))}
        </div>

        {global && (
          <div className="rail-card">
            <div className="rc-t">Arrange</div>
            <button className={'rail-opt' + (!group ? ' on' : '')} onClick={() => setGroup(false)}>
              Single stream
            </button>
            <button className={'rail-opt' + (group ? ' on' : '')} onClick={() => setGroup(true)}>
              Grouped by client
            </button>
          </div>
        )}

        <div className="rail-card">
          <div className="rc-t">At a glance</div>
          <div className="rail-stat">
            <span className="dot critical" />
            Critical
            <span className="n">{sevCounts.critical ?? 0}</span>
          </div>
          <div className="rail-stat">
            <span className="dot notable" />
            Notable
            <span className="n">{sevCounts.notable ?? 0}</span>
          </div>
          <div className="rail-stat">
            <span className="dot info" />
            Info
            <span className="n">{sevCounts.info ?? 0}</span>
          </div>
        </div>
      </aside>

      {/* Client-scoped drawers derive their client from the alert itself so they
          work in both per-client and global (P11) mode. */}
      <MemoComposerDrawer
        open={!!composerItem}
        onClose={() => setComposerItem(null)}
        clientId={composerItem?.clientId ?? clientId ?? ''}
        clientName={composerItem?.clientName ?? clientName ?? ''}
        item={composerItem}
      />

      <DistrictBriefComposerDrawer
        open={!!briefItem}
        onClose={() => setBriefItem(null)}
        clientId={briefItem?.clientId ?? clientId ?? ''}
        item={briefItem}
      />

      <Modal
        title="Add talking point"
        open={!!tpItem}
        onCancel={() => setTpItem(null)}
        okText="Save"
        confirmLoading={addTalkingPoint.isPending}
        onOk={() => {
          if (!tpItem || !tpText.trim()) return;
          addTalkingPoint.mutate(
            { clientId: tpItem.clientId, alertId: tpItem.id, text: tpText.trim() },
            {
              onSuccess: () => {
                message.success('Talking point saved');
                setTpItem(null);
              },
              onError: (e: unknown) => message.error((e as Error).message),
            },
          );
        }}
      >
        <Input.TextArea
          value={tpText}
          onChange={(e) => setTpText(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 6 }}
          placeholder="A concise, client-ready talking point"
        />
      </Modal>
    </div>
  );
}

export default TrackerFeedPanel;
