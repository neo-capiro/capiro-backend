import { useEffect, useState } from 'react';
import { App, Select } from 'antd';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Lock, Plus, Users, X } from 'lucide-react';
import { PrepTab } from './PrepTab.js';
import { NotesTab } from './NotesTab.js';
import { DebriefTab } from './DebriefTab.js';
import {
  useAssignMeetingClient,
  useClientOptions,
  useUnshareArtifacts,
  type ShareArtifactRef,
} from './meetings-api.js';
import { formatDayTitle, formatTimeRange, isAllDayMeeting } from './meetings-format.js';
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
import type { DetailTab, Meeting } from './meetings-types.js';

/**
 * Phase 2 §3.e — replaces the binary Private/Shared toggle (which unshared
 * EVERYTHING in one click) with an explicit per-artifact control: a count of
 * what's currently shared, a button that opens ShareConfirmation to add
 * more, and (only when something is shared) an "Unshare all" action that
 * requires confirmation and shows exactly what it will unshare.
 */
function ShareArtifactsControl({ m, onOpenShare }: { m: Meeting; onOpenShare: () => void }) {
  const { modal, message } = App.useApp();
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
    modal.confirm({
      title: `Unshare ${sharedItems.length} artifact${sharedItems.length === 1 ? '' : 's'}?`,
      content: `This removes ${sharedItems.length === 1 ? 'it' : 'them'} from ${m.client?.name ?? 'the client'}'s Documents and your firm's Meeting Library. This cannot be undone from here — you'd need to re-share.`,
      okText: 'Unshare all',
      okButtonProps: { danger: true },
      rootClassName: 'redesign',
      onOk: async () => {
        try {
          await unshare.mutateAsync({ meetingId: m.id, artifacts: sharedItems });
          message.success('Unshared.');
        } catch {
          message.error('Could not unshare.');
        }
      },
    });
  };

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
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
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const clients = useClientOptions(editing);
  const assign = useAssignMeetingClient();

  if (editing) {
    return (
      <Select
        autoFocus
        open={editing}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setEditing(false);
        }}
        showSearch
        size="small"
        style={{ minWidth: 220 }}
        placeholder="Assign a client…"
        loading={clients.isLoading}
        defaultValue={meeting.client?.id}
        optionFilterProp="label"
        options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
        onBlur={() => setEditing(false)}
        onChange={async (clientId: string) => {
          setEditing(false);
          if (clientId === meeting.client?.id) return;
          await assign.mutateAsync({ meetingId: meeting.id, clientId });
          message.success('Client updated for this meeting.');
        }}
      />
    );
  }

  if (meeting.client) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Change client"
        className="pill info"
        style={{ fontSize: 11, border: 'none', cursor: 'pointer' }}
      >
        {meeting.client.name}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="btn sm"
      style={{ gap: 4, fontSize: 11.5, padding: '3px 9px' }}
    >
      <Plus size={11} />
      Assign client
    </button>
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
}) {
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
    ? new Date(m.endsAt).getTime() > Date.now() &&
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
  const tabs: { k: DetailTab; label: string; done: boolean; disabled?: boolean }[] = [
    { k: 'prep', label: 'Prep', done: status.prep },
    { k: 'notes', label: 'Meeting Notes', done: status.notes },
    { k: 'debrief', label: 'Debrief', done: status.debrief, disabled: debriefLocked },
  ];

  return (
    <>
      {/* Overlay (scoped to the meetings content region) */}
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
      {/* Panel */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(680px,92%)',
          background: 'var(--bg-surface)',
          zIndex: 50,
          borderLeft: '1px solid var(--border-1)',
          boxShadow: '-8px 0 44px rgba(12,26,56,0.16)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.26s cubic-bezier(0.22,1,0.36,1)',
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
                  fontSize: 11.5,
                  color: 'var(--ink-3)',
                  fontVariantNumeric: 'tabular-nums',
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  flexWrap: 'wrap',
                }}
              >
                <span>
                  {formatDayTitle(new Date(m.startsAt))} ·{' '}
                  {isAllDayMeeting(m.startsAt, m.endsAt)
                    ? 'All day'
                    : formatTimeRange(m.startsAt, m.endsAt)}
                </span>
                <span
                  style={{
                    width: 3,
                    height: 3,
                    borderRadius: '50%',
                    background: 'var(--border-strong)',
                  }}
                />
                <ProviderTag m={m} />
              </div>
              <h1
                style={{
                  fontSize: 19,
                  fontWeight: 700,
                  letterSpacing: '-0.015em',
                  margin: '0 0 10px',
                  lineHeight: 1.28,
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
              style={{ padding: 6, flexShrink: 0 }}
            >
              <X size={16} />
            </button>
          </div>

          {(showSendMeri(m) || (m.isVirtual && m.joinLink)) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              {showSendMeri(m) && <SendMeriButton m={m} onClick={() => onSendMeri(m)} size="sm" />}
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

          {/* Attendees (collapsible) */}
          <div style={{ marginBottom: 14 }}>
            <button
              type="button"
              onClick={() => setAttOpen((o) => !o)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                width: '100%',
                border: 'none',
                background: 'none',
                padding: 0,
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <SectionLabel style={{ marginBottom: 0 }}>
                Attendees · {m.attendees.length}
              </SectionLabel>
              {attOpen ? (
                <ChevronDown size={13} style={{ color: 'var(--ink-3)' }} />
              ) : (
                <ChevronRight size={13} style={{ color: 'var(--ink-3)' }} />
              )}
            </button>
            {attOpen && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  maxHeight: 170,
                  overflowY: 'auto',
                  margin: '9px -6px 0',
                  padding: '0 6px',
                }}
              >
                {m.attendees.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--ink-3)', padding: '7px 0' }}>
                    No attendees recorded.
                  </div>
                ) : (
                  m.attendees.map((a, i) => (
                    <div
                      key={a.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        minWidth: 0,
                        padding: '7px 0',
                        borderBottom:
                          i < m.attendees.length - 1 ? '1px solid var(--border-1)' : 'none',
                      }}
                    >
                      <Ava initials={initialsOf(a.name || a.email)} size={30} />
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: 'var(--ink-1)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {a.name || a.email || 'Unknown'}
                        </div>
                        {a.role && (
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--ink-2)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {a.role}
                          </div>
                        )}
                        {a.email && (
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--ink-3)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {a.email}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

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
                    padding: '11px 0 12px',
                    marginRight: 24,
                    cursor: t.disabled ? 'not-allowed' : 'pointer',
                    opacity: t.disabled ? 0.5 : 1,
                    fontFamily: 'var(--font-sans)',
                    borderBottom: on ? '2px solid var(--accent)' : '2px solid transparent',
                    marginBottom: -1,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: on ? 700 : 500,
                      color: on ? 'var(--ink-1)' : 'var(--ink-3)',
                    }}
                  >
                    {t.label}
                  </span>
                  {t.disabled && <Lock size={11} style={{ color: 'var(--ink-3)' }} />}
                  {t.done && (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: 'var(--success)',
                      }}
                    />
                  )}
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
