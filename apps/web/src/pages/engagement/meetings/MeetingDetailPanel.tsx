import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Plus, Users, X } from 'lucide-react';
import { PrepTab } from './PrepTab.js';
import { NotesTab } from './NotesTab.js';
import { DebriefTab } from './DebriefTab.js';
import {
  useAssignMeetingClient,
  useClientOptions,
  useUnshareArtifacts,
  type ShareArtifactRef,
} from './meetings-api.js';
import { formatMeetingDayTitle, formatTimeRange, isAllDayMeeting } from './meetings-format.js';
import {
  Ava,
  JoinButton,
  type MeetingStatus,
  ProviderTag,
  SectionLabel,
  SendMeriButton,
  canShare,
  initialsOf,
  meetingStatus,
  showSendMeri,
} from './meetings-ui.js';
import { approvedDebrief, isCancelledMeeting, type DetailTab, type Meeting } from './meetings-types.js';
import { EngagementDialog } from './EngagementDialog.js';
import { SharedMeetingsSection } from './SharedMeetingsSection.js';
// Confirm/toast chrome is injected per surface (AntD on the canonical
// Meetings page, EngagementDialog + Capiro toasts on vNext) — this shared
// file deliberately imports no antd. See meeting-panel-chrome.tsx.
import { useMeetingPanelChrome } from './meeting-panel-chrome.js';

/**
 * Tab-strip dot color — reskin phase (navy design), intentional behavior
 * change, not an oversight: the dot used to mean COMPLETION (the artifact
 * exists — see meetingStatus()/MeetingStatus above, which is unchanged and
 * still drives OTHER completion signals like the Meetings-list P/N/D badges).
 * The design calls for the dot on THIS tab strip specifically to mean
 * APPROVAL instead: navy once approved, amber once something exists but
 * isn't approved yet, gray while nothing exists yet. Reuses the same
 * generic --accent/--notable/--ink-4 vars the rest of this file already reads
 * (navy/amber/gray on os.capiro.ai via the vNext retheme, original tones on
 * app.capiro.ai) rather than introducing new ones. */
type TabDotTone = 'navy' | 'warn' | 'gray';
function tabDotTone(exists: boolean, approved: boolean): TabDotTone {
  if (approved) return 'navy';
  if (exists) return 'warn';
  return 'gray';
}
const TAB_DOT_COLOR: Record<TabDotTone, string> = {
  navy: 'var(--accent)',
  warn: 'var(--notable)',
  gray: 'var(--ink-4)',
};

/**
 * Phase 2 §3.e — replaces the binary Private/Shared toggle (which unshared
 * EVERYTHING in one click) with an explicit per-artifact control: a count of
 * what's currently shared, a button that opens ShareConfirmation to add
 * more, and (only when something is shared) an "Unshare all" action that
 * requires confirmation and shows exactly what it will unshare.
 */
function ShareArtifactsControl({ m, onOpenShare }: { m: Meeting; onOpenShare: () => void }) {
  const chrome = useMeetingPanelChrome();
  const unshare = useUnshareArtifacts();
  const shareable = canShare(m);
  const sharedItems: ShareArtifactRef[] = [
    ...m.preps.filter((p) => p.sharedAt != null).map((p) => ({ type: 'prep' as const, id: p.id })),
    ...m.notes.filter((n) => n.sharedAt != null).map((n) => ({ type: 'note' as const, id: n.id })),
    ...m.debriefs
      .filter((d) => d.sharedAt != null)
      .map((d) => ({ type: 'debrief' as const, id: d.id })),
    ...m.attachments
      .filter((a) => a.sharedAt != null)
      .map((a) => ({ type: 'attachment' as const, id: a.id })),
  ];

  const confirmUnshareAll = () => {
    chrome.confirm({
      title: `Unshare ${sharedItems.length} artifact${sharedItems.length === 1 ? '' : 's'}?`,
      content: `This removes ${sharedItems.length === 1 ? 'it' : 'them'} from ${m.client?.name ?? 'the client'}'s Documents and your firm's Meeting Library. This cannot be undone from here — you'd need to re-share.`,
      okText: 'Unshare all',
      danger: true,
      onOk: async () => {
        try {
          await unshare.mutateAsync({ meetingId: m.id, artifacts: sharedItems });
          chrome.success('Unshared.');
        } catch {
          chrome.error('Could not unshare.');
        }
      },
    });
  };

  return (
    <div
      style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}
    >
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <button
          type="button"
          className="btn sm"
          disabled={!shareable}
          title={shareable ? undefined : 'Assign a client to share'}
          onClick={onOpenShare}
          style={{ gap: 6 }}
        >
          <Users size={13} />
          Share artifacts
          {sharedItems.length > 0 && (
            <span className="pill success" style={{ fontSize: 9 }}>
              {sharedItems.length} shared
            </span>
          )}
        </button>
        {sharedItems.length > 0 && (
          <button type="button" className="btn sm" onClick={confirmUnshareAll}>
            Unshare all
          </button>
        )}
      </div>
      {!shareable && (
        <span style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>Assign a client to share</span>
      )}
    </div>
  );
}

/** The client pill / "Assign client" affordance — assigns or overrides the
 *  meeting's client (spec §6: sharing requires a client). Wired to PUT /meetings/:id. */
function ClientAssign({ meeting }: { meeting: Meeting }) {
  const chrome = useMeetingPanelChrome();
  const [editing, setEditing] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState(meeting.client?.id ?? '');
  const clients = useClientOptions(editing);
  const assign = useAssignMeetingClient();

  useEffect(() => {
    if (editing) setSelectedClientId(meeting.client?.id ?? '');
  }, [editing, meeting.client?.id]);

  const currentClientId = meeting.client?.id ?? '';
  const save = async () => {
    try {
      await assign.mutateAsync({ meetingId: meeting.id, clientId: selectedClientId || null });
      chrome.success('Client updated for this meeting.');
      setEditing(false);
    } catch {
      chrome.error('Could not update the meeting client.');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={`engagement-disclosure-button engagement-client-assignment-trigger${
          meeting.client ? ' pill info' : ''
        }`}
        title={meeting.client ? 'Change client assignment' : 'Assign a client'}
      >
        {!meeting.client ? <Plus size={12} /> : null}
        <span>{meeting.client?.name ?? 'Assign client'}</span>
        <span aria-hidden="true">›</span>
      </button>
      <EngagementDialog
        open={editing}
        eyebrow="Meeting · relationship"
        title="Client assignment"
        description="Associate this meeting with the client whose context, artifacts, and reporting should receive it."
        width={540}
        busy={assign.isPending}
        busyLabel="Updating the meeting client…"
        error={assign.isError ? 'Could not update the meeting client. Try again.' : null}
        dirty={selectedClientId !== currentClientId}
        onClose={() => setEditing(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={assign.isPending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={assign.isPending}
              onClick={() => void save()}
            >
              {assign.isPending ? 'Saving…' : 'Save assignment'}
            </button>
          </>
        }
      >
        <label className="engagement-dialog__field">
          Client
          <select
            autoFocus
            value={selectedClientId}
            disabled={clients.isLoading || assign.isPending}
            onChange={(event) => setSelectedClientId(event.target.value)}
          >
            <option value="">No client / internal</option>
            {(clients.data ?? []).map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
          <small>Sharing requires a client. Internal meetings may remain unassigned.</small>
        </label>
        {meeting.client ? (
          <SharedMeetingsSection clientId={meeting.client.id} clientName={meeting.client.name} />
        ) : null}
      </EngagementDialog>
    </>
  );
}

export function MeetingDetailPanel({
  meeting: m,
  open,
  onClose,
  aiConfigured,
  activeTab,
  onTabChange,
  onSendMeri,
  onRequestShare,
  layout = 'overlay',
}: {
  meeting: Meeting | null;
  open: boolean;
  onClose: () => void;
  aiConfigured: boolean;
  /** Controlled by the parent (EngagementPage owns the URL — Phase 2 §2a3).
   *  This panel no longer keeps its own copy of the active tab. */
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onSendMeri: (m: Meeting) => void;
  onRequestShare: (m: Meeting) => void;
  /**
   * How the panel positions itself.
   *
   * `overlay` (the default, and what app.capiro.ai's canonical Meetings page
   * keeps) is the historical behaviour: an absolutely-positioned slide-over
   * with a scrim, a drop shadow and a translateX transition.
   *
   * `inline` is the vNext Engagement treatment (UI-parity §5.1): the panel is
   * an ordinary in-flow block that fills its container, with no scrim, no
   * shadow, no radius and no transform — its parent `<aside>` owns the
   * sticky positioning and scrolling. Passing it also switches the header to
   * the mono when-line and 22px title the same section specifies.
   */
  layout?: 'overlay' | 'inline';
}) {
  const inline = layout === 'inline';
  const [attOpen, setAttOpen] = useState(false);

  const status: MeetingStatus = m
    ? meetingStatus(m)
    : { prep: false, notes: false, debrief: false };

  // Collapse the attendees disclosure when a different meeting opens. Picking
  // the most-relevant tab for a freshly opened meeting is now the caller's
  // job (MeetingsV2's openMeeting) so it only fires once per meeting-open and
  // never clobbers an explicit `?detail=` deep link or a manual tab change.
  useEffect(() => {
    setAttOpen(false);
  }, [m?.id]);

  // Debrief is locked until the meeting itself is over — debriefing something
  // that hasn't happened yet doesn't make sense, Meri notetaker or not. "Over"
  // means the scheduled end passed OR Meri detected the call ended early (all
  // participants left, meri 'attended'/'done') OR Meri definitively won't
  // produce anything (meri 'failed' — consent declined, provider error,
  // no-show; no reason to keep waiting on the scheduled end time).
  const debriefLocked = m
    ? !isCancelledMeeting(m) && new Date(m.endsAt).getTime() > Date.now() &&
      m.meri !== 'attended' &&
      m.meri !== 'done' &&
      m.meri !== 'failed'
    : false;

  // Direct URL navigation (?detail=debrief) could otherwise land on a locked
  // tab without ever going through the tab button's disabled state. Routing
  // this through onTabChange (rather than local state) lets the parent
  // canonicalize the URL too, so a bookmarked/shared debrief link on an
  // unfinished meeting doesn't keep claiming `detail=debrief`.
  useEffect(() => {
    if (activeTab === 'debrief' && debriefLocked) onTabChange('prep');
  }, [activeTab, debriefLocked, onTabChange]);

  if (!m) return null;

  const shared = m.visibility === 'shared';
  const prep = m.preps[0] ?? null;
  const tabs: { k: DetailTab; label: string; dot: TabDotTone; disabled?: boolean }[] = [
    { k: 'prep', label: 'Prep', dot: tabDotTone(status.prep, prep?.status === 'approved') },
    { k: 'notes', label: 'Meeting Notes', dot: tabDotTone(status.notes, m.notesApproved) },
    {
      k: 'debrief',
      label: 'Debrief',
      dot: tabDotTone(status.debrief, Boolean(approvedDebrief(m))),
      disabled: debriefLocked,
    },
  ];

  return (
    <>
      {/* Overlay (scoped to the meetings content region). The inline layout has
          no scrim at all — UI-parity §5.1: "No backdrop, no scrim". */}
      {!inline && (
        <div
          onClick={onClose}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(12,26,56,0.34)',
            zIndex: 40,
            opacity: open ? 1 : 0,
            pointerEvents: open ? 'auto' : 'none',
            transition: 'opacity 0.2s',
          }}
        />
      )}
      {/* Panel */}
      <div
        style={{
          ...(inline
            ? {
                position: 'static',
                width: '100%',
                // The <aside> owns sticky/scroll; the panel just fills it.
                minHeight: '100%',
              }
            : {
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                width: 'min(680px,92%)',
                zIndex: 50,
                borderLeft: '1px solid var(--border-1)',
                boxShadow: '-8px 0 44px rgba(12,26,56,0.16)',
                transform: open ? 'translateX(0)' : 'translateX(100%)',
                transition: 'transform 0.26s cubic-bezier(0.22,1,0.36,1)',
              }),
          background: 'var(--bg-surface)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 24px 0',
            borderBottom: '1px solid var(--border-1)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 14,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  // Reskin phase: the design's meta/time-date lines are mono
                  // (IBM Plex Mono on os.capiro.ai via the vNext retheme's
                  // --font-mono mapping); this is the one such line in the
                  // panel's own header (as opposed to inside a tab body).
                  // Inline layout takes the full mono LABEL treatment —
                  // UI-parity §5.2 renders this line as 11px uppercase, not
                  // 11.5px sentence case.
                  fontFamily: 'var(--font-mono)',
                  fontVariantNumeric: 'tabular-nums',
                  ...(inline
                    ? {
                        fontSize: 11,
                        fontWeight: 500,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase' as const,
                        color: '#98A2B3',
                      }
                    : { fontSize: 11.5, color: 'var(--ink-3)' }),
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  flexWrap: 'wrap',
                }}
              >
                {/* One clock in both layouts. The `inline` (vNext) branch
                    used to render a 24-hour range while the row 12px to its
                    left renders a 12-hour clock, so a 14:00 meeting read
                    "2:00 PM" in the row and "14:00–14:30" here. `overlay`
                    (app.capiro.ai) already called formatTimeRange, so this
                    only changes the vNext surface. */}
                <span>
                  {formatMeetingDayTitle(m.startsAt, m.endsAt)} ·{' '}
                  {isAllDayMeeting(m.startsAt, m.endsAt)
                    ? 'All day'
                    : formatTimeRange(m.startsAt, m.endsAt)}
                </span>
                {inline ? (
                  <span aria-hidden="true">·</span>
                ) : (
                  <span
                    style={{
                      width: 3,
                      height: 3,
                      borderRadius: '50%',
                      background: 'var(--border-strong)',
                    }}
                  />
                )}
                <ProviderTag m={m} />
              </div>
              <h1
                style={{
                  // UI-parity §5.2: 22/30/600/-.01em in the inline drawer.
                  ...(inline
                    ? {
                        fontSize: 22,
                        lineHeight: '30px',
                        fontWeight: 600,
                        letterSpacing: '-0.01em',
                        margin: '6px 0 10px',
                      }
                    : {
                        fontSize: 19,
                        lineHeight: 1.28,
                        fontWeight: 700,
                        letterSpacing: '-0.015em',
                        margin: '0 0 10px',
                      }),
                  color: 'var(--ink-1)',
                }}
              >
                {m.subject}
              </h1>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="btn sm btn-ghost"
              style={
                inline
                  ? {
                      // UI-parity §5.2: a 28x28 quiet icon button.
                      display: 'inline-grid',
                      placeItems: 'center',
                      width: 28,
                      height: 28,
                      padding: 0,
                      flexShrink: 0,
                      borderRadius: 6,
                      color: '#667085',
                    }
                  : { padding: 6, flexShrink: 0 }
              }
            >
              <X size={16} />
            </button>
          </div>

          {/* UI-parity §5.3/§5.4 collapse the overlay layout's three header
              rows into two: an action row (Send Meri · Join · spacer · client)
              and a meta row (Attendees ‹-› Share artifacts). The overlay
              layout keeps its original three-row order untouched. */}
          {inline ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                  marginTop: 14,
                  marginBottom: 14,
                }}
              >
                {showSendMeri(m) && (
                  <SendMeriButton m={m} onClick={() => onSendMeri(m)} size="sm" />
                )}
                <JoinButton m={m} size="sm" variant="secondary" />
                <div style={{ flex: 1, minWidth: 12 }} />
                <ClientAssign key={m.id} meeting={m} />
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                  marginBottom: 14,
                }}
              >
                <button
                  type="button"
                  className="engagement-disclosure-button"
                  onClick={() => setAttOpen(true)}
                >
                  <Users size={16} />
                  Attendees · {m.attendees.length}
                  <span aria-hidden="true">›</span>
                </button>
                <ShareArtifactsControl m={m} onOpenShare={() => onRequestShare(m)} />
              </div>
            </>
          ) : (
            <>
              {(showSendMeri(m) || (m.isVirtual && m.joinLink)) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                  {showSendMeri(m) && (
                    <SendMeriButton m={m} onClick={() => onSendMeri(m)} size="sm" />
                  )}
                  <JoinButton m={m} size="sm" />
                </div>
              )}

              {/* client + share */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                  marginBottom: 14,
                }}
              >
                <ClientAssign key={m.id} meeting={m} />
                <div style={{ flex: 1, minWidth: 12 }} />
                <ShareArtifactsControl m={m} onOpenShare={() => onRequestShare(m)} />
              </div>

              {/* Attendees window */}
              <div style={{ marginBottom: 14 }}>
                <button
                  type="button"
                  className="engagement-disclosure-button"
                  onClick={() => setAttOpen(true)}
                >
                  <Users size={15} />
                  Attendees · {m.attendees.length}
                  <span aria-hidden="true">›</span>
                </button>
              </div>
            </>
          )}
          <EngagementDialog
            open={attOpen}
            eyebrow="Meeting · people"
            title="Attendees"
            description={`${m.attendees.length} attendee${m.attendees.length === 1 ? '' : 's'} recorded for this meeting.`}
            width={620}
            onClose={() => setAttOpen(false)}
            footer={
              <button type="button" className="btn" onClick={() => setAttOpen(false)}>
                Close
              </button>
            }
          >
            {m.attendees.length === 0 ? (
              <div className="engagement-dialog-empty">No attendees recorded.</div>
            ) : (
              <div className="engagement-dialog__list">
                {m.attendees.map((attendee) => (
                  <div className="engagement-dialog__list-row" key={attendee.id}>
                    <span className="engagement-attendee-avatar" aria-hidden="true">
                      {initialsOf(attendee.name || attendee.email)}
                    </span>
                    <div>
                      <strong>{attendee.name || attendee.email || 'Unknown attendee'}</strong>
                      <span>
                        {[attendee.role, attendee.email].filter(Boolean).join(' · ') ||
                          'No additional details'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </EngagementDialog>

          {/* Live-share note */}
          {shared && m.client && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: '8px 12px',
                borderRadius: '8px 8px 0 0',
                background: 'var(--success-soft)',
                fontSize: 11.5,
                color: 'var(--success)',
                alignItems: 'center',
              }}
            >
              <Users size={13} />
              <span>
                Saved to{' '}
                <Link
                  to={`/clients?clientId=${m.client.id}&tab=documents`}
                  onClick={onClose}
                  style={{ color: 'var(--success)', fontWeight: 700, textDecoration: 'underline' }}
                >
                  {m.client.name} · Documents
                </Link>{' '}
                — visible to your org.
              </span>
            </div>
          )}

          {isCancelledMeeting(m) && (
            <p role="status" style={{ color: 'var(--ink-3)', fontSize: 13 }}>
              Cancelled meeting. Existing materials remain available; no prep or debrief is required.
            </p>
          )}

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0, marginTop: shared ? 10 : 2 }}>
            {tabs.map((t) => {
              const on = activeTab === t.k;
              return (
                <button
                  key={t.k}
                  type="button"
                  disabled={t.disabled}
                  onClick={() => !t.disabled && onTabChange(t.k)}
                  title={t.disabled ? 'Debrief unlocks once this meeting ends' : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    border: 'none',
                    background: 'none',
                    // UI-parity §5.5: 10px/12px padding on a 2px gap strip,
                    // rather than the overlay layout's 24px right margin.
                    ...(inline
                      ? { padding: '10px 12px', marginRight: 2 }
                      : { padding: '11px 0 12px', marginRight: 24 }),
                    cursor: t.disabled ? 'not-allowed' : 'pointer',
                    opacity: t.disabled ? 0.5 : 1,
                    fontFamily: 'var(--font-sans)',
                    borderBottom: on ? '2px solid var(--accent)' : '2px solid transparent',
                    marginBottom: -1,
                  }}
                >
                  <span
                    style={{
                      fontSize: inline ? 14 : 13.5,
                      fontWeight: on ? (inline ? 600 : 700) : 500,
                      color: on ? 'var(--ink-1)' : 'var(--ink-3)',
                    }}
                  >
                    {t.label}
                  </span>
                  {t.disabled && <Lock size={11} style={{ color: 'var(--ink-3)' }} />}
                  <span
                    title={
                      t.dot === 'navy'
                        ? 'Approved'
                        : t.dot === 'warn'
                          ? 'Not yet approved'
                          : 'Not started'
                    }
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: TAB_DOT_COLOR[t.dot],
                    }}
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab content */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '20px 24px 40px',
            background: 'var(--bg-canvas)',
          }}
        >
          {activeTab === 'prep' && <PrepTab meeting={m} aiConfigured={aiConfigured} />}
          {activeTab === 'notes' && (
            <NotesTab
              meeting={m}
              onSendMeri={onSendMeri}
              onGoToDebrief={() => onTabChange('debrief')}
            />
          )}
          {activeTab === 'debrief' && <DebriefTab meeting={m} />}
        </div>
      </div>
    </>
  );
}
