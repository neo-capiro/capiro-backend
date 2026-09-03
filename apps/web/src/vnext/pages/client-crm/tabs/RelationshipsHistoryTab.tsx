import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import {
  CardHead,
  Eyebrow,
  PfSkeleton,
  Pill,
  PILL,
  UIcon,
  type PillTone,
} from '../portfolio-primitives.js';
import { formatDateShort } from '../../../lib/labels.js';
import {
  LogActivityModal,
  type ActivityItem,
  type Kind as ActivityKind,
} from '../ClientCrmHistory.js';
import { EmailComposeModal } from '../EmailComposeModal.js';
import { getMailThread, type MailRecipient, type MailThread } from '../mail-api.js';
import { dayKey } from '../../../../pages/engagement/meetings/meetings-format.js';
import { useMe } from '../../../../lib/me.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import './relationships-history-tab.css';

/**
 * Relationships / History sub-tab (spec §8.3).
 *
 * The timeline reads the real `/api/clients/:id/activity` union (recorded CRM
 * activity + meetings + attachments + outreach). Quick-add rows open the
 * canonical LogActivityModal pre-set to their kind; pin/settle mutations
 * write through the same endpoints as the canonical tab.
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
  // "Reply", not "Email": the row's primary action addresses ONE person and
  // copies nobody. Reply all is a second, separate control (see HistEntry's
  // `onActionAll`) rather than what this button quietly does.
  email: { mark: 'E', label: 'Email thread', group: 'Email', action: 'Reply' },
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
  /**
   * Reply-all, offered ONLY on an email-thread row and ONLY as a second
   * control. #1445 made the single email action a silent reply-all, which
   * widens the audience of any thread that cc'd opposing counsel or Hill
   * staff — unrecoverable the instant Send is pressed. The narrow reply stays
   * primary; this is the deliberate opt-in.
   */
  onActionAll?: () => void;
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
  const toast = useCapiroToast();
  // Second identity signal for the is-me test in `openEmailThread`. A thread's
  // `connectionEmail` is nullable on its own (see mail-api.ts), and when it is
  // null a single-equality test excludes nobody at all. `/api/me` is already
  // fetched app-wide with staleTime 30s, so this is a cache read, not a
  // request.
  const me = useMe();
  // Optional at `user` as well as at `data`: this is read during render, and a
  // stale or partially-shaped cached /me payload is a real case in this app
  // (MeResponse's own notes call out older cached shapes).
  const myAccountEmail = me.data?.user?.email ?? null;
  const [filter, setFilter] = useState<GroupFilter>('All');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState<ActivityKind | null>(null);
  const [replyTarget, setReplyTarget] = useState<{
    to: MailRecipient;
    cc: MailRecipient[];
    threadId: string;
    subject: string;
    /**
     * True when neither identity signal resolved, so NOTHING was excluded as
     * "me" and the recipients below may include the sender (or miss the person
     * they meant to reach). Surfaced as an inline notice in the compose window
     * — see EmailComposeModal's `identityUnconfirmed`.
     */
    identityUnconfirmed: boolean;
  } | null>(null);
  // Which timeline row (if any) is expanded to show its full message — a
  // single id, so opening one always closes whichever was open before.
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
    if (item.sourceType === 'meeting') {
      // `/engagement/meetings/:id` canonicalizes to `?meeting=<id>` with no
      // `date` param (engagement-route-state.ts's canonicalEngagementLocation),
      // so the calendar's cursor kept its own default (today) regardless of
      // which day the meeting actually fell on — landing on "today" for a
      // meeting from 10 days ago instead of that meeting's own date. The
      // Timeline row already knows the real date (occurredAt); pass it
      // through explicitly rather than relying on the meeting resolving
      // client-side after navigation and jumping the calendar retroactively.
      navigate(`/engagement/meetings/${item.sourceId}?date=${dayKey(new Date(item.occurredAt))}`);
    } else if (item.sourceType === 'attachment') navigate(`/clients?clientId=${client.id}&tab=files`);
    else if (item.sourceType === 'outreach') navigate(`/outreach/${item.sourceId}`);
    else if (item.sourceType === 'mail_thread' && item.sourceId)
      void openEmailThread(item.sourceId, 'reply');
  };

  // Opens the compose window pre-filled to reply on this thread, rather than
  // the old redirect to a generic Meetings list scoped by clientId — this
  // component's activity mapping doesn't carry a participant address, so the
  // real one comes from the thread's own detail (GET mail-threads/:id).
  //
  // `mode` is the user's stated intent, never inferred: 'reply' addresses one
  // person and copies nobody; 'replyAll' additionally cc's everyone else who
  // was on that message. #1445 offered one control and always built the
  // reply-all, so a private reply silently widened to the whole thread.
  //
  // Either way the caller's own addresses are excluded, which is the fix
  // #1445 was actually for: the old code replied to the last message's sender
  // unconditionally, so a thread whose newest message you had sent yourself
  // addressed the "reply" back to you.
  const openEmailThread = async (threadId: string, mode: ReplyMode) => {
    try {
      const thread = await getMailThread(api, threadId);
      const mySelf = selfAddresses(thread.connectionEmail, myAccountEmail);
      const { to, cc } = buildReplyRecipients(thread, mySelf, mode);
      if (!to) {
        toast.error('Could not find who to reply to on this thread.');
        return;
      }
      setReplyTarget({
        to,
        cc,
        threadId,
        subject: thread.subject ? `Re: ${thread.subject}` : 'Re:',
        // Neither signal resolved — the connection recorded no account email
        // and /api/me has none either. The window still opens (a working
        // action beats a blocked one), but the compose window says so, since
        // silently excluding nobody is how the reply-to-yourself bug returns.
        identityUnconfirmed: mySelf.size === 0,
      });
    } catch {
      toast.error('Could not open this email thread.');
    }
  };

  // Real activity mapped to the design's entry shape. Loading, error and empty
  // states stay honest; the visual harness owns any deterministic fixtures.
  const entries: HistEntry[] = useMemo(() => {
    return all.map((item) => {
      const view = KIND_VIEW[item.kind];
      const recorded = item.origin === 'recorded';
      // Narrowed out here rather than inside the closure below, so the handler
      // captures a `string` instead of re-widening to `string | null`.
      const threadId = item.sourceType === 'mail_thread' ? item.sourceId : null;
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
        // Reply-all is a separate, secondary control on email rows only —
        // never the meaning of the primary action.
        onActionAll:
          !recorded && threadId ? () => void openEmailThread(threadId, 'replyAll') : undefined,
        source: item,
      };
    });
    // `myAccountEmail` is load-bearing, not cosmetic: the handlers above
    // capture `openEmailThread`, which closes over it. `all` is a stable React
    // Query reference once the activity query settles, so without this dep the
    // memo freezes at that moment and a later /api/me resolution never reaches
    // the click handler — dropping the second identity signal in exactly the
    // case it exists for (a thread whose connectionEmail is null).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, genuinelyEmpty, client.id, myAccountEmail]);

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
      <TimelineAndControlsCard
        entries={shown}
        noActivityYet={genuinelyEmpty}
        loading={activity.isLoading}
        failed={activity.isError}
        commitments={openCommitments}
        pinnedText={pinnedNote ? maskJoinUrls(pinnedNote.body ?? pinnedNote.title) : null}
        pinnedLoaded={loaded}
        filter={filter}
        query={query}
        onFilter={setFilter}
        onQuery={setQuery}
        onQuickAdd={(kind) => setAdding(kind)}
        onSettle={(id) => mutate.mutate({ id, settled: true })}
        settlingId={mutate.isPending ? (mutate.variables?.id ?? null) : null}
        expandedId={expandedId}
        onToggleExpand={(id) => setExpandedId((current) => (current === id ? null : id))}
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

      {replyTarget ? (
        <EmailComposeModal
          open
          onClose={() => setReplyTarget(null)}
          to={[replyTarget.to]}
          threadId={replyTarget.threadId}
          defaultSubject={replyTarget.subject}
          defaultCc={replyTarget.cc}
          identityUnconfirmed={replyTarget.identityUnconfirmed}
          clientId={client.id}
          clientName={client.name}
          onSent={() => void qc.invalidateQueries({ queryKey: ['client-activity', client.id] })}
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
  loading,
  failed,
  commitments,
  pinnedText,
  pinnedLoaded,
  filter,
  query,
  onFilter,
  onQuery,
  onQuickAdd,
  onSettle,
  settlingId,
  expandedId,
  onToggleExpand,
}: {
  entries: HistEntry[];
  noActivityYet: boolean;
  loading: boolean;
  failed: boolean;
  commitments: ActivityItem[];
  pinnedText: string | null;
  pinnedLoaded: boolean;
  filter: GroupFilter;
  query: string;
  onFilter: (filter: GroupFilter) => void;
  onQuery: (query: string) => void;
  onQuickAdd: (kind: ActivityKind) => void;
  onSettle: (id: string) => void;
  settlingId: string | null;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
}) {
  const rows: CommitmentRow[] = commitments.map((item) => ({
    id: item.id,
    label: item.title,
    when: item.dueAt ? formatDay(item.dueAt) : 'No due date',
    tone: commitmentTone(item.dueAt),
    settleable: Boolean(item.dueAt),
  }));

  return (
    <section className="rel-hist-card">
      <CardHead title="Account relationship timeline" />
      <div className="rel-hist-filterbar">
        <label className="rel-hist-search">
          <UIcon name="SearchLg" size={15} color="#667085" />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            aria-label="Search history"
            placeholder="Search history"
            className="rel-hist-search-input"
          />
        </label>
        <div className="rel-hist-filtergroup" role="group" aria-label="Timeline filters">
          {GROUP_FILTERS.map((group) => (
            <FilterChip
              key={group}
              label={group}
              active={filter === group}
              onClick={() => onFilter(group)}
            />
          ))}
        </div>
      </div>

      <div className="rel-hist-grid-flush">
        <div className="rel-hist-timeline">
          {loading ? (
            <p className="rel-hist-empty-msg">Loading client activity…</p>
          ) : failed ? (
            <p className="rel-hist-empty-msg">Client activity is temporarily unavailable.</p>
          ) : entries.length === 0 ? (
            <p className="rel-hist-empty-msg">
              {noActivityYet ? 'No activity recorded for this client yet.' : 'No activity matches this filter.'}
            </p>
          ) : (
            entries.map((entry, index) => (
              <TimelineEntry
                key={entry.id}
                entry={entry}
                last={index === entries.length - 1}
                expanded={expandedId === entry.id}
                onToggleExpand={() => onToggleExpand(entry.id)}
              />
            ))
          )}
        </div>

        <aside className="rel-hist-rail" aria-label="Relationship controls">
          <h4 className="rel-hist-rail-title">Relationship controls</h4>
          <div className="rel-hist-rail-section rel-hist-rail-section--first">
            <Eyebrow>Quick add</Eyebrow>
            <div className="rel-hist-rail-list">
              {QUICK_ADD.map((quickAdd) => (
                <QuickAddRow
                  key={quickAdd.kind}
                  label={quickAdd.label}
                  onClick={() => onQuickAdd(quickAdd.kind)}
                />
              ))}
            </div>
          </div>

          <div className="rel-hist-rail-divider">
            <Eyebrow>Open commitments</Eyebrow>
            <div className="rel-hist-rail-commitments">
              {!pinnedLoaded ? (
                <span className="rel-hist-muted-note">Loading commitments…</span>
              ) : rows.length === 0 ? (
                <span className="rel-hist-muted-note">Nothing outstanding.</span>
              ) : (
                rows.map((commitment) => (
                  <CommitmentLine
                    key={commitment.id}
                    row={commitment}
                    settling={settlingId === commitment.id}
                    {...(commitment.settleable ? { onSettle: () => onSettle(commitment.id) } : {})}
                  />
                ))
              )}
            </div>
          </div>

          <div className="rel-hist-rail-divider">
            <Eyebrow>Pinned account note</Eyebrow>
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
        </aside>
      </div>
    </section>
  );
}

function TimelineEntry({
  entry,
  last,
  expanded,
  onToggleExpand,
}: {
  entry: HistEntry;
  last: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  // Only an email thread has a full message worth expanding to read — every
  // other kind already shows its complete title/body inline.
  const threadId = entry.source?.sourceType === 'mail_thread' ? entry.source.sourceId : null;
  return (
    <article className="rel-hist-row">
      <span className="rel-hist-node-rail" aria-hidden>
        <span className="rel-hist-node">
          <UIcon name={iconForGroup(entry.group)} size={18} color="#475467" />
        </span>
        {!last ? <span className="rel-hist-node-connector" /> : null}
      </span>
      <span className="rel-hist-row-content">
        <span className="rel-hist-row-header">
          <span className="rel-hist-row-kind">{entry.kind}</span>
          <span className="rel-hist-row-date">{entry.date}</span>
          <span className="rel-hist-spacer" />
          {threadId ? (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-expanded={expanded}
              className="rel-hist-row-action"
            >
              {expanded ? 'Show less' : 'Read more'}
            </button>
          ) : null}
          {entry.onAction ? (
            <button type="button" onClick={entry.onAction} className="rel-hist-row-action">
              {entry.action}
            </button>
          ) : null}
          {/* Two controls, not one: #1445 collapsed Reply and Reply all into a
              single "Email" action that always did the reply-all, so a user
              intending a private reply copied everyone on the last message
              unless they spotted the pre-filled Cc. Reply stays primary;
              Reply all is visibly secondary and opt-in. */}
          {entry.onActionAll ? (
            <button
              type="button"
              onClick={entry.onActionAll}
              className="rel-hist-row-action rel-hist-row-action--secondary"
            >
              Reply all
            </button>
          ) : null}
        </span>
        <span className="rel-hist-row-title">{entry.title}</span>
        {entry.body ? <span className="rel-hist-row-body">{entry.body}</span> : null}
        {expanded && threadId ? <EmailThreadPreview threadId={threadId} /> : null}
        <span className="rel-hist-row-meta">
          <span className="rel-hist-row-avatar" aria-hidden>{entry.mark}</span>
          {entry.meta}
        </span>
      </span>
    </article>
  );
}

/**
 * The full message history for one email thread, fetched only while its row
 * is expanded (unmounting on collapse, so a thread never loads before someone
 * actually asks to read it). The timeline row itself only ever shows the
 * thread's short snippet — this is the "read the message more" view.
 */
function EmailThreadPreview({ threadId }: { threadId: string }) {
  const api = useApi();
  const threadQ = useQuery({
    queryKey: ['mail-thread-detail', threadId],
    queryFn: () => getMailThread(api, threadId),
  });

  if (threadQ.isLoading) return <p className="rel-hist-thread-status">Loading messages…</p>;
  if (threadQ.isError || !threadQ.data) {
    return <p className="rel-hist-thread-status">Could not load this thread.</p>;
  }

  return (
    <div className="rel-hist-thread-preview">
      {threadQ.data.messages.map((message) => (
        <div key={message.id} className="rel-hist-thread-message">
          <div className="rel-hist-thread-message-head">
            <span className="rel-hist-thread-message-from">
              {message.fromName ? `${message.fromName} <${message.fromEmail}>` : (message.fromEmail ?? 'Unknown sender')}
            </span>
            <span className="rel-hist-thread-message-date">
              {formatDay(message.sentAt ?? message.receivedAt ?? message.createdAt)}
            </span>
          </div>
          <p className="rel-hist-thread-message-body">{message.bodyText || '(no message text)'}</p>
        </div>
      ))}
    </div>
  );
}

function iconForGroup(group: string): string {
  if (group === 'Meetings') return 'Calendar2';
  if (group === 'Email') return 'Mail01';
  if (group === 'Outreach') return 'Send01';
  if (group === 'Notes') return 'MessageTextSquare01';
  return 'File04';
}


function QuickAddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rel-hist-quickadd">
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

/** Reply width, as stated by the user's click — never inferred. */
type ReplyMode = 'reply' | 'replyAll';

/**
 * One comparable form of an address: trimmed and lower-cased. Returns '' for
 * anything that is not a usable address, so a non-string Json entry or a bare
 * display name can never match anything.
 *
 * Deliberately does NOT strip a `+tag` from the local part. Nothing in this
 * codebase establishes that every tenant's provider routes plus-addressed mail
 * to the base mailbox, and treating them as equal can only DROP a recipient
 * from a reply — silently, and possibly a legitimate one.
 */
function normalizeAddress(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return '';
  return trimmed;
}

/**
 * Every address that counts as "me", from both identity signals this client
 * has: the thread's own connected-mailbox address (`connection.accountEmail`)
 * and the signed-in user's account email from `/api/me`.
 *
 * There are two because `connectionEmail` is independently nullable (see
 * mail-api.ts's MailThread), and the single-signal test this replaces excluded
 * NOBODY whenever it was null — silently restoring the reply-to-yourself bug
 * it was written to fix.
 *
 * An EMPTY set means the caller's identity is unknown. Callers must surface
 * that rather than treat it as "nothing to exclude" (see openEmailThread).
 *
 * Honestly NOT covered, and not coverable with the data we store: mailbox
 * ALIASES (Exchange proxyAddresses, Graph `mail` vs `userPrincipalName`, Gmail
 * sendAs) and DELEGATED/SHARED mailboxes, whose own address is neither signal.
 * Both need an address list persisted per connection and exposed on the thread
 * detail — its own ticket. Firm-domain identity ("anyone @capiro.ai is us") is
 * deliberately not inferred: a colleague is a legitimate reply recipient.
 */
function selfAddresses(...candidates: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeAddress(candidate);
    if (normalized) out.add(normalized);
  }
  return out;
}

/** Accumulates usable, de-duplicated, non-self addresses in the order added. */
function recipientPool(mySelf: Set<string>) {
  const seen = new Set<string>();
  const list: MailRecipient[] = [];
  const add = (rawEmail: unknown, rawName?: unknown) => {
    const key = normalizeAddress(rawEmail);
    if (!key || mySelf.has(key) || seen.has(key)) return;
    seen.add(key);
    // The normalized form is for comparison only — the address handed to
    // compose stays as the provider wrote it, since lower-casing someone
    // else's local part is not ours to do.
    const email = typeof rawEmail === 'string' ? rawEmail.trim() : key;
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined;
    list.push({ email, name });
  };
  return { add, list };
}

/**
 * Reply recipients for a thread, `mode` deciding how wide:
 *   'reply'    → one address and no Cc at all;
 *   'replyAll' → that address as To, everyone else on the same message's
 *                from/to/cc as Cc.
 * `mySelf` is excluded from both, so a reply is never addressed back to the
 * caller's own mailbox.
 *
 * `toRecipients`/`ccRecipients` are Prisma `Json` columns served through
 * unvalidated, so they can be a non-array or hold non-objects (see
 * mail-api.ts). Guarded the way the API's own recipient reader guards them; an
 * unreadable entry is skipped rather than thrown over. The unguarded `for…of`
 * this replaces threw "is not iterable" and surfaced as the misleading
 * "Could not open this email thread."
 *
 * The scan walks from the END of the message list, which `getMailThread`
 * orders ascending by `sentAt` — NOT reliably chronological, since Postgres
 * sorts NULLs last in ASC and a received-only message has no `sentAt`. So this
 * is "the last message with a usable other party", not "the newest". Reading
 * only the final message (the #1445 behaviour) meant a thread whose last
 * message had no other party — a note mailed to yourself, a bounce, a calendar
 * reply — opened no compose window at all on a thread that plainly had someone
 * to reply to further up. The thread's own `participants` roster is the last
 * resort for the same reason.
 */
function buildReplyRecipients(
  thread: MailThread,
  mySelf: Set<string>,
  mode: ReplyMode,
): { to: MailRecipient | null; cc: MailRecipient[] } {
  const split = (pool: MailRecipient[]) => {
    const [to, ...rest] = pool;
    return to ? { to, cc: mode === 'replyAll' ? rest : [] } : null;
  };

  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    const pool = recipientPool(mySelf);
    pool.add(message.fromEmail, message.fromName);
    for (const key of ['toRecipients', 'ccRecipients'] as const) {
      const list: unknown = message[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as { email?: unknown; name?: unknown };
        pool.add(record.email, record.name);
      }
    }
    const picked = split(pool.list);
    if (picked) return picked;
  }

  const participants = Array.isArray(thread.participants) ? thread.participants : [];
  const roster = recipientPool(mySelf);
  for (const participant of participants) {
    if (!participant || typeof participant !== 'object') continue;
    roster.add(participant.email, participant.name);
  }
  return split(roster.list) ?? { to: null, cc: [] };
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
