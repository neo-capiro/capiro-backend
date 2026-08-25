import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import {
  Card,
  CardHead,
  Eyebrow,
  GRADIENT_DARK,
  PfButton,
  PfSkeleton,
  Pill,
  PILL,
  TabPageHead,
  UIcon,
  type PillTone,
} from '../portfolio-primitives.js';
import { OV_ATTN, TIMELINE } from '../portfolio-fixtures.js';
import { formatDateShort } from '../../../lib/labels.js';
import {
  LogActivityModal,
  type ActivityItem,
  type Kind as ActivityKind,
} from '../ClientCrmHistory.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import './relationships-history-tab.css';

/**
 * Relationships / History sub-tab (spec §8.3).
 *
 * The timeline prefers the real `/api/clients/:id/activity` union (recorded
 * CRM activity + meetings + attachments + outreach) and falls back to the
 * design's TIMELINE fixture when the client has no activity yet. Quick-add
 * rows open the canonical LogActivityModal pre-set to their kind; pin/settle
 * mutations write through the same endpoints as the canonical tab. The
 * segmented sub-tab bar is owned by the parent page.
 *
 * The Calls and Documents filter chips and the timeline Export button are
 * gone: calls are logged as activity and read under the same timeline, and
 * documents live on the Files tab, which owns the client's attachments.
 */

const GROUP_FILTERS = ['All', 'Meetings', 'Email', 'Notes', 'Outreach'] as const;
type GroupFilter = (typeof GROUP_FILTERS)[number];

/**
 * Groups an activity row can be tagged with. Calls and Documents are no longer
 * offered as filters, but a row still carries its true group so its eyebrow
 * label and its inclusion under `All` stay honest.
 */
type ActivityGroup = GroupFilter | 'Calls' | 'Documents';

/** Activity kind → design mark, eyebrow label and filter group (§8.3). */
const KIND_VIEW: Record<ActivityKind, { mark: string; label: string; group: Exclude<ActivityGroup, 'All'>; action: string }> = {
  note: { mark: 'N', label: 'Client note', group: 'Notes', action: 'Pin' },
  email: { mark: 'E', label: 'Email thread', group: 'Email', action: 'Open thread' },
  call: { mark: 'C', label: 'Client call', group: 'Calls', action: 'Open log' },
  meeting: { mark: 'M', label: 'Client meeting', group: 'Meetings', action: 'Open meeting' },
  outreach: { mark: 'O', label: 'Outreach', group: 'Outreach', action: 'Open outreach' },
  document: { mark: 'D', label: 'Deliverable', group: 'Documents', action: 'Open file' },
  request: { mark: 'R', label: 'Client request', group: 'Notes', action: 'Open' },
  decision: { mark: 'D', label: 'Decision', group: 'Notes', action: 'Open' },
  commitment: { mark: 'C', label: 'Commitment', group: 'Notes', action: 'Settle' },
};

interface HistEntry {
  id: string;
  date: string;
  mark: string;
  kind: string;
  group: string;
  title: string;
  body: string | null;
  meta: string;
  action: string;
  onAction?: () => void;
  /** Present only on real activity — the export writes from these, not the row copy. */
  source?: ActivityItem;
}

const QUICK_ADD: Array<{ label: string; kind: ActivityKind }> = [
  { label: 'Log a call', kind: 'call' },
  { label: 'Add a note', kind: 'note' },
  { label: 'Record a client request', kind: 'request' },
  { label: 'Log a decision', kind: 'decision' },
];

export function ClientCrmHistoryProto({ client }: { client: Client }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<GroupFilter>('All');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState<ActivityKind | null>(null);

  const activity = useQuery<ActivityItem[]>({
    queryKey: ['client-activity', client.id],
    queryFn: async () =>
      (await api.get<ActivityItem[]>(`/api/clients/${client.id}/activity`, { params: { limit: 200 } })).data,
  });

  const mutate = useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      (await api.patch(`/api/clients/${client.id}/activity/${id}`, body)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['client-activity', client.id] }),
  });

  const create = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await api.post(`/api/clients/${client.id}/activity`, body)).data,
    onSuccess: () => {
      setAdding(null);
      void qc.invalidateQueries({ queryKey: ['client-activity', client.id] });
    },
  });

  const all = activity.data ?? [];
  const loaded = activity.data !== undefined && !activity.isError;
  const genuinelyEmpty = loaded && all.length === 0;

  const open = (item: ActivityItem) => {
    // Every derived row can reach its source record.
    if (item.sourceType === 'meeting') navigate(`/engagement/meetings/${item.sourceId}`);
    else if (item.sourceType === 'attachment') navigate(`/clients?clientId=${client.id}&tab=files`);
    else if (item.sourceType === 'outreach') navigate(`/outreach/${item.sourceId}`);
    // Synced mail threads have no standalone detail route yet — Engagement's
    // Meetings surface is the closest live destination for this client's
    // correspondence, scoped by clientId.
    else if (item.sourceType === 'mail_thread')
      navigate(`/engagement/meetings?clientId=${encodeURIComponent(client.id)}`);
  };

  // Real activity mapped to the design's entry shape. The design fixture
  // renders while loading or on error (keeps the surface pixel-reviewable);
  // once the fetch genuinely resolves to zero records, a real empty state
  // renders instead — the fixture is never a stand-in for "no activity".
  const entries: HistEntry[] = useMemo(() => {
    if (genuinelyEmpty) return [];
    if (all.length === 0) {
      return TIMELINE.map((e, i) => ({
        id: `fixture-${i}`,
        date: e.date,
        mark: e.mark,
        kind: e.kind,
        group: e.group,
        title: e.title,
        body: e.body,
        meta: e.meta,
        action: e.action,
      }));
    }
    return all.map((item) => {
      const view = KIND_VIEW[item.kind];
      const recorded = item.origin === 'recorded';
      return {
        id: item.id,
        date: formatDay(item.occurredAt),
        mark: view.mark,
        kind: view.label,
        group: view.group,
        title: item.title,
        // Synced meeting rows can carry a raw join URL (with an embedded
        // password) as their body — mask it to a platform name before render.
        body: maskJoinUrls(item.body),
        meta: provenance(item),
        action: recorded ? (item.pinned ? 'Pinned' : 'Pin') : view.action,
        onAction: recorded
          ? () => mutate.mutate({ id: item.id, pinned: !item.pinned })
          : item.sourceId
            ? () => open(item)
            : undefined,
        source: item,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, genuinelyEmpty, client.id]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter !== 'All' && e.group !== filter) return false;
      if (!q) return true;
      return `${e.title} ${e.body ?? ''} ${e.kind}`.toLowerCase().includes(q);
    });
  }, [entries, filter, query]);

  /**
   * Item 8 (wire-audit "3 Compose extend"). An open commitment is anything the
   * client is still owed: a recorded row with a due date, OR one logged as a
   * commitment at all — a commitment with no date is still outstanding, and
   * dropping it hid real obligations from the rail.
   */
  const openCommitments = useMemo(
    () => all.filter((item) => (item.dueAt || item.kind === 'commitment') && !item.settledAt),
    [all],
  );
  const pinnedNote = useMemo(
    () => all.find((item) => item.pinned && item.kind === 'note') ?? all.find((item) => item.pinned),
    [all],
  );

  return (
    <div className="cap-pf-anim-rise rel-hist-root">
      <TabPageHead
        title="Relationship history"
        sub="The shared institutional record of what happened between your firm and this client."
        actions={
          <PfButton variant="primary" onClick={() => setAdding('note')}>
            Add activity
          </PfButton>
        }
      />

      {/* filter bar */}
      <div className="rel-hist-filterbar">
        <div className="rel-hist-search">
          <UIcon name="SearchLg" size={20} color="var(--capiro-color-text-muted)" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search history"
            placeholder="Search history"
            className="rel-hist-search-input"
          />
        </div>
        {GROUP_FILTERS.map((g) => (
          <FilterChip key={g} label={g} active={filter === g} onClick={() => setFilter(g)} />
        ))}
        <span className="rel-hist-spacer" />
        {/* The query is `limit: 200`, not a date window — "Last 90 days"
            described a filter that does not exist. */}
        <Eyebrow style={{ whiteSpace: 'nowrap' }}>Recent activity</Eyebrow>
      </div>

      <TimelineAndControlsCard
        entries={shown}
        noActivityYet={genuinelyEmpty}
        commitments={openCommitments}
        // Fixture only while the fetch is still in flight or errored. Once
        // it genuinely resolves to nothing, "Nothing outstanding" is the
        // truthful answer — this used to fall back on `all.length === 0`,
        // which showed the fixture during every load and for every client
        // that really had no activity.
        fallbackCommitments={!loaded}
        pinnedText={pinnedNote ? maskJoinUrls(pinnedNote.body ?? pinnedNote.title) : null}
        pinnedLoaded={loaded}
        onQuickAdd={(kind) => setAdding(kind)}
        onSettle={(id) => mutate.mutate({ id, settled: true })}
        settlingId={mutate.isPending ? (mutate.variables?.id ?? null) : null}
      />

      {adding ? (
        <LogActivityModal
          initialKind={adding}
          onClose={() => setAdding(null)}
          onSubmit={(values) => create.mutate(values)}
          pending={create.isPending}
          error={create.error}
        />
      ) : null}
    </div>
  );
}

/* ── Account relationship timeline + Relationship controls (consolidated) ─── */

/**
 * The activity timeline and the quick-add/commitments/pinned-note rail used
 * to be two side-by-side cards ("Account relationship timeline" and
 * "Relationship controls") that were really one feature — the record of what
 * happened with this client and the tools to act on it. They are now one
 * card: the timeline as the main column, the controls rail beside it, both
 * under a single header and border.
 */
interface CommitmentRow {
  id: string;
  label: string;
  when: string;
  tone: PillTone;
  /** Real rows the API will accept a settle for (it requires a due date). */
  settleable?: boolean;
}

function TimelineAndControlsCard({
  entries,
  noActivityYet,
  commitments,
  fallbackCommitments,
  pinnedText,
  pinnedLoaded,
  onQuickAdd,
  onSettle,
  settlingId,
}: {
  entries: HistEntry[];
  noActivityYet: boolean;
  commitments: ActivityItem[];
  fallbackCommitments: boolean;
  pinnedText: string | null;
  pinnedLoaded: boolean;
  onQuickAdd: (kind: ActivityKind) => void;
  onSettle: (id: string) => void;
  settlingId: string | null;
}) {
  const rows: CommitmentRow[] = fallbackCommitments
    ? // Design fixture (UI-only): attention items shaped as open commitments.
      OV_ATTN.filter((a) => a.id === 'a7' || a.id === 'a3' || a.id === 'a8').map((a) => ({
        id: a.id,
        label: a.title,
        when: a.due,
        tone: a.ui as PillTone,
      }))
    : commitments.map((item) => ({
        id: item.id,
        label: item.title,
        // A commitment with no due date is still open — it just has no date to
        // show, which is different from being overdue.
        when: item.dueAt ? formatDay(item.dueAt) : 'No due date',
        tone: commitmentTone(item.dueAt),
        // The API refuses to settle a row without a dueAt ("Only a commitment
        // or request can be settled"), so the action is only offered where the
        // write would actually succeed.
        settleable: Boolean(item.dueAt),
      }));

  return (
    <Card>
      <CardHead title="Account relationship timeline" />
      <div className="cap-pf-grid-side-380 rel-hist-grid-flush">
        {/* timeline */}
        <div>
          {entries.length === 0 ? (
            <p className="rel-hist-empty-msg">
              {noActivityYet ? 'No activity recorded for this client yet.' : 'No activity matches this filter.'}
            </p>
          ) : (
            entries.map((e) => <TimelineEntry key={e.id} entry={e} />)
          )}
        </div>

        {/* relationship controls rail */}
        <div className="rel-hist-rail">
          <h4 className="rel-hist-rail-title">Relationship controls</h4>
          <div className="rel-hist-rail-section">
            <Eyebrow>Quick add</Eyebrow>
            <div className="rel-hist-rail-list">
              {QUICK_ADD.map((qa) => (
                <QuickAddRow key={qa.kind} label={qa.label} onClick={() => onQuickAdd(qa.kind)} />
              ))}
            </div>
          </div>

          <div className="rel-hist-rail-divider">
            <Eyebrow>Open commitments</Eyebrow>
            <div className="rel-hist-rail-commitments">
              {rows.length === 0 ? (
                <span className="rel-hist-muted-note">Nothing outstanding.</span>
              ) : (
                rows.map((cm) => (
                  <CommitmentLine
                    key={cm.id}
                    row={cm}
                    settling={settlingId === cm.id}
                    {...(!fallbackCommitments && cm.settleable ? { onSettle: () => onSettle(cm.id) } : {})}
                  />
                ))
              )}
            </div>
          </div>

          <div className="rel-hist-rail-divider">
            <Eyebrow>Pinned account note</Eyebrow>
            {/* While loading, a skeleton — the old fixture fallback was a
                sentence of invented client preference that read exactly like a
                real pinned note. Once the fetch settles with nothing, the honest
                answer is that there isn't one. */}
            {pinnedLoaded ? (
              <p className="rel-hist-pinned-text">
                {pinnedText ?? 'No pinned note yet — pin an activity to keep it here.'}
              </p>
            ) : (
              <div className="rel-hist-pinned-skeleton">
                <PfSkeleton />
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function TimelineEntry({ entry: e }: { entry: HistEntry }) {
  return (
    <div className="rel-hist-row">
      <span className="rel-hist-row-date">{e.date}</span>
      <span aria-hidden className="rel-hist-row-mark" style={{ background: GRADIENT_DARK }}>
        {e.mark}
      </span>
      <span className="rel-hist-row-content">
        <span className="rel-hist-row-header">
          <Eyebrow tight>{e.kind}</Eyebrow>
          <span className="rel-hist-spacer" />
          {/* No handler, no button: a dead "Open thread" that did nothing on
              click was worse than showing nothing. */}
          {e.onAction ? (
            <button type="button" onClick={e.onAction} className="rel-hist-row-action">
              {e.action}
            </button>
          ) : null}
        </span>
        <span className="rel-hist-row-title">{e.title}</span>
        {e.body ? <span className="rel-hist-row-body">{e.body}</span> : null}
        <span className="rel-hist-row-meta">{e.meta}</span>
      </span>
    </div>
  );
}

/* ControlsCard's body was folded into TimelineAndControlsCard above. */

function QuickAddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rel-hist-quickadd">
      <span className="rel-hist-quickadd-dot" aria-hidden />
      <span className="rel-hist-quickadd-label">{label}</span>
      <UIcon name="Plus" size={16} color="var(--capiro-color-text-muted)" style={{ flex: '0 0 auto' }} />
    </button>
  );
}

function CommitmentLine({
  row: cm,
  onSettle,
  settling = false,
}: {
  row: CommitmentRow;
  onSettle?: () => void;
  settling?: boolean;
}) {
  const [, , , dot] = PILL[cm.tone];
  const toneTitle = TONE_TITLE[cm.tone];
  return (
    <span className="rel-hist-commitment">
      {/* The dot was color-only — a named title/label carries the urgency for
          anyone who cannot rely on the color. */}
      <span
        role="img"
        aria-label={toneTitle}
        title={toneTitle}
        className="rel-hist-commitment-dot"
        style={{ background: dot }}
      />
      <span className="rel-hist-commitment-label">{cm.label}</span>
      {/* Settling writes `settledAt` through the same activity PATCH the pin
          action uses, which is what takes the row off this rail for good. */}
      {onSettle ? (
        <button
          type="button"
          onClick={onSettle}
          disabled={settling}
          aria-label={`Settle ${cm.label}`}
          className="rel-hist-settle-btn"
        >
          {settling ? 'Settling…' : 'Settle'}
        </button>
      ) : null}
      <Pill tone={cm.tone} size="lg" dotless style={{ flex: '0 0 auto' }}>
        {cm.when}
      </Pill>
    </span>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={active ? 'rel-hist-chip rel-hist-chip--active' : 'rel-hist-chip'}
    >
      {label}
    </button>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Commitment-dot urgency, spelled out — the color alone carried it before. */
const TONE_TITLE: Record<PillTone, string> = {
  error: 'Overdue',
  warning: 'Due soon',
  gray: 'Not due soon',
  blue: 'Upcoming',
  success: 'On track',
  brand: 'Priority',
};

/**
 * Meeting join URLs (Zoom/Teams links, often carrying `pwd=` in the query)
 * must never render as timeline copy. Any URL found in a subtitle is replaced
 * with its platform name; text without URLs passes through untouched.
 */
function maskJoinUrls(text: string | null): string | null {
  if (!text) return text;
  return text.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (url) => {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return 'Meeting link';
    }
    if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'Zoom meeting';
    if (host === 'teams.microsoft.com' || host === 'teams.live.com' || host.endsWith('.teams.microsoft.com'))
      return 'Teams meeting';
    return 'Meeting link';
  });
}

function provenance(item: ActivityItem): string {
  if (item.origin === 'recorded') return item.pinned ? 'Logged by your firm · Pinned' : 'Logged by your firm';
  if (item.sourceType === 'meeting') return 'Meeting record · notes and debrief available';
  if (item.sourceType === 'attachment') return 'Workspace · client file';
  if (item.sourceType === 'outreach') return 'Outreach campaign · strategy-linked';
  return 'Synced record';
}

function commitmentTone(dueAt: string | null): PillTone {
  if (!dueAt) return 'gray';
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return 'gray';
  const now = Date.now();
  if (due < now) return 'error';
  if (due - now < 7 * 24 * 60 * 60 * 1000) return 'warning';
  return 'gray';
}

/** Shared short date (adds the year when it is not the current one, so old
 *  activity is not mistaken for this year's). Invalid dates say so. */
function formatDay(iso: string): string {
  return formatDateShort(iso) ?? 'Undated';
}
