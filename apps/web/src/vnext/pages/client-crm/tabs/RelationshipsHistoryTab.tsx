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
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 40,
            padding: '0 12px',
            width: 320,
            borderRadius: 8,
            background: '#ffffff',
            border: '1px solid #E0DCD4',
            boxShadow: '0px 1px 2px rgba(16,24,40,.05)',
          }}
        >
          <UIcon name="SearchLg" size={20} color="#667085" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search history"
            placeholder="Search history"
            style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 14, color: '#101828' }}
          />
        </div>
        {GROUP_FILTERS.map((g) => (
          <FilterChip key={g} label={g} active={filter === g} onClick={() => setFilter(g)} />
        ))}
        <span style={{ flex: 1 }} />
        {/* The query is `limit: 200`, not a date window — "Last 90 days"
            described a filter that does not exist. */}
        <Eyebrow style={{ whiteSpace: 'nowrap' }}>Recent activity</Eyebrow>
      </div>

      <div className="cap-pf-grid-side-380">
        <TimelineCard entries={shown} noActivityYet={genuinelyEmpty} />
        <ControlsCard
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
      </div>

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

/* ── Timeline card ────────────────────────────────────────────────────────── */

function TimelineCard({ entries, noActivityYet }: { entries: HistEntry[]; noActivityYet: boolean }) {
  return (
    <Card>
      <CardHead title="Account relationship timeline" />
      <div>
        {entries.length === 0 ? (
          <p style={{ margin: 0, padding: '20px 24px', fontSize: 14, color: '#667085' }}>
            {noActivityYet ? 'No activity recorded for this client yet.' : 'No activity matches this filter.'}
          </p>
        ) : (
          entries.map((e) => <TimelineEntry key={e.id} entry={e} />)
        )}
      </div>
    </Card>
  );
}

function TimelineEntry({ entry: e }: { entry: HistEntry }) {
  const [hover, setHover] = useState(false);
  const [actionHover, setActionHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        gap: 16,
        padding: '16px 24px',
        borderBottom: '1px solid #F2F0EB',
        background: hover ? '#FAF9F6' : 'transparent',
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          width: 76,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '.04em',
          textTransform: 'uppercase',
          color: '#667085',
        }}
      >
        {e.date}
      </span>
      <span
        aria-hidden
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: GRADIENT_DARK,
          color: '#ffffff',
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {e.mark}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <Eyebrow tight>{e.kind}</Eyebrow>
          <span style={{ flex: 1 }} />
          {/* No handler, no button: a dead "Open thread" that did nothing on
              click was worse than showing nothing. */}
          {e.onAction ? (
            <button
              type="button"
              onClick={e.onAction}
              onMouseEnter={() => setActionHover(true)}
              onMouseLeave={() => setActionHover(false)}
              style={{ fontSize: 13, fontWeight: 600, color: actionHover ? '#0E141C' : '#101828', whiteSpace: 'nowrap' }}
            >
              {e.action}
            </button>
          ) : null}
        </span>
        <span style={{ display: 'block', marginTop: 4, fontSize: 16, fontWeight: 600, color: '#101828', textWrap: 'pretty' }}>
          {e.title}
        </span>
        {e.body ? (
          <span style={{ display: 'block', marginTop: 4, fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
            {e.body}
          </span>
        ) : null}
        <span style={{ display: 'block', marginTop: 8, fontSize: 12, color: '#667085' }}>{e.meta}</span>
      </span>
    </div>
  );
}

/* ── Relationship controls card ───────────────────────────────────────────── */

interface CommitmentRow {
  id: string;
  label: string;
  when: string;
  tone: PillTone;
  /** Real rows the API will accept a settle for (it requires a due date). */
  settleable?: boolean;
}

function ControlsCard({
  commitments,
  fallbackCommitments,
  pinnedText,
  pinnedLoaded,
  onQuickAdd,
  onSettle,
  settlingId,
}: {
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
      <CardHead title="Relationship controls" />
      <div style={{ padding: '20px 24px' }}>
        <Eyebrow>Quick add</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {QUICK_ADD.map((qa) => (
            <QuickAddRow key={qa.kind} label={qa.label} onClick={() => onQuickAdd(qa.kind)} />
          ))}
        </div>

        <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid #E8E5DF' }}>
          <Eyebrow>Open commitments</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            {rows.length === 0 ? (
              <span style={{ fontSize: 14, color: '#667085' }}>Nothing outstanding.</span>
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

        <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid #E8E5DF' }}>
          <Eyebrow>Pinned account note</Eyebrow>
          {/* While loading, a skeleton — the old fixture fallback was a
              sentence of invented client preference that read exactly like a
              real pinned note. Once the fetch settles with nothing, the honest
              answer is that there isn't one. */}
          {pinnedLoaded ? (
            <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
              {pinnedText ?? 'No pinned note yet — pin an activity to keep it here.'}
            </p>
          ) : (
            <div style={{ marginTop: 10, maxWidth: 280 }}>
              <PfSkeleton />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function QuickAddRow({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '11px 14px',
        borderRadius: 8,
        textAlign: 'left',
        background: hover ? '#F2F0EB' : '#FAF9F6',
        border: hover ? '1px solid #E0DCD4' : '1px solid #E8E5DF',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#667085', flex: '0 0 auto' }} aria-hidden />
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#344054' }}>{label}</span>
      <UIcon name="Plus" size={16} color="#667085" style={{ flex: '0 0 auto' }} />
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
  const [hover, setHover] = useState(false);
  const toneTitle = TONE_TITLE[cm.tone];
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', gap: 10 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* The dot was color-only — a named title/label carries the urgency for
          anyone who cannot rely on the color. */}
      <span
        role="img"
        aria-label={toneTitle}
        title={toneTitle}
        style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flex: '0 0 auto' }}
      />
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#344054', textWrap: 'pretty' }}>{cm.label}</span>
      {/* Settling writes `settledAt` through the same activity PATCH the pin
          action uses, which is what takes the row off this rail for good. */}
      {onSettle ? (
        <button
          type="button"
          onClick={onSettle}
          disabled={settling}
          aria-label={`Settle ${cm.label}`}
          style={{
            flex: '0 0 auto',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '.03em',
            textTransform: 'uppercase',
            color: settling ? '#98A2B3' : hover ? '#101828' : '#667085',
            whiteSpace: 'nowrap',
          }}
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
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        background: active ? '#F2F0EB' : hover ? '#FAF9F6' : 'transparent',
        border: active ? '1px solid #E0DCD4' : '1px solid transparent',
        color: active ? '#101828' : '#667085',
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
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
