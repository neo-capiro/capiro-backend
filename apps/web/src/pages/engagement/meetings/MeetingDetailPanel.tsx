import { useEffect, useState } from 'react';
import { App, Drawer, Popconfirm } from 'antd';
import {
  CloseOutlined,
  DownOutlined,
  LockOutlined,
  RightOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { JoinLink, MeriAttendingPill } from '../meeting-actions.js';
import { PrepTab } from './PrepTab.js';
import { NotesTab } from './NotesTab.js';
import { DebriefTab } from './DebriefTab.js';
import { useUnshareMeeting } from './meetings-api.js';
import { formatDayTitle, formatTimeRange, providerLabel } from './meetings-format.js';
import { artifactStatus, eligibleForMeri, type Meeting } from './meetings-types.js';

type DetailTab = 'prep' | 'notes' | 'debrief';

export function MeetingDetailPanel({
  meeting,
  open,
  onClose,
  aiConfigured,
  initialTab,
  onSendMeri,
  onRequestShare,
}: {
  meeting: Meeting | null;
  open: boolean;
  onClose: () => void;
  aiConfigured: boolean;
  initialTab?: DetailTab;
  onSendMeri: (m: Meeting) => void;
  onRequestShare: (m: Meeting) => void;
}) {
  const { message } = App.useApp();
  const [tab, setTab] = useState<DetailTab>(initialTab ?? 'prep');
  const [attendeesOpen, setAttendeesOpen] = useState(false);
  const unshare = useUnshareMeeting();

  // Reset panel state whenever a different meeting is opened (spec §2, change 8).
  useEffect(() => {
    setTab(initialTab ?? 'prep');
    setAttendeesOpen(false);
  }, [meeting?.id, initialTab]);

  if (!meeting) return null;

  const status = artifactStatus(meeting);
  const shared = meeting.visibility === 'shared';
  const providerName = providerLabel(meeting.provider);

  const tabs: Array<{ key: DetailTab; label: string; dot: boolean }> = [
    { key: 'prep', label: 'Prep', dot: meeting.preps.length > 0 && !status.prep },
    {
      key: 'notes',
      label: 'Meeting Notes',
      dot: meeting.meri === 'scheduled' || meeting.meri === 'attending',
    },
    { key: 'debrief', label: 'Debrief', dot: meeting.debriefs.length > 0 && !status.debrief },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      closable={false}
      width={Math.min(720, window.innerWidth - 60)}
      rootClassName="redesign"
      destroyOnHidden
      styles={{ header: { display: 'none' }, body: { padding: '18px 22px' } }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="mtg-detail-meta">
            <span>{formatDayTitle(new Date(meeting.startsAt))}</span>
            <span>·</span>
            <span>{formatTimeRange(meeting.startsAt, meeting.endsAt)}</span>
            {providerName ? (
              <>
                <span>·</span>
                <VideoCameraOutlined />
                <span>{providerName}</span>
              </>
            ) : null}
            <JoinLink joinUrl={meeting.joinLink} meeting={meeting} />
          </div>
          <h2 className="mtg-detail-title">{meeting.subject}</h2>
          {eligibleForMeri(meeting) &&
          (meeting.meri === 'scheduled' || meeting.meri === 'attending') ? (
            <MeriAttendingPill />
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16 }}
        >
          <CloseOutlined />
        </button>
      </div>

      <div className="mtg-detail-clientbar">
        <span className="mtg-client-pill">{meeting.client?.name ?? 'No client'}</span>
        <div
          className="mtg-vis-toggle"
          role="group"
          aria-label="Sharing"
          title={meeting.client ? undefined : 'Associate a client to share'}
        >
          <button
            type="button"
            className={!shared ? 'active' : ''}
            onClick={() => {
              if (!shared) return;
              // Shared → Private handled by the Popconfirm below (this branch is a no-op).
            }}
          >
            {!shared ? <LockOutlined /> : null} Private
          </button>
          {shared ? (
            <Popconfirm
              title="Make this meeting private?"
              description="It will be removed from the client's Documents and the Library."
              okText="Make private"
              onConfirm={async () => {
                await unshare.mutateAsync(meeting.id);
                message.success('Meeting is private again.');
              }}
            >
              <button type="button" className="active is-shared">
                Shared
              </button>
            </Popconfirm>
          ) : (
            <button
              type="button"
              disabled={!meeting.client}
              onClick={() => onRequestShare(meeting)}
            >
              Shared
            </button>
          )}
        </div>
      </div>

      {shared && meeting.client ? (
        <div className="mtg-saved-line">
          <TeamOutlined />
          <span>
            Saved to{' '}
            <Link to="/clients" onClick={onClose}>
              {meeting.client.name} · Documents
            </Link>
          </span>
        </div>
      ) : null}

      <div className="mtg-attendees">
        <button
          type="button"
          className="mtg-attendees-head"
          onClick={() => setAttendeesOpen((v) => !v)}
        >
          <span>Attendees · {meeting.attendees.length}</span>
          {attendeesOpen ? <DownOutlined /> : <RightOutlined />}
        </button>
        {attendeesOpen ? (
          <div className="mtg-attendees-list">
            {meeting.attendees.length === 0 ? (
              <div className="mtg-attendee-meta">No attendees recorded.</div>
            ) : (
              meeting.attendees.map((a) => (
                <div className="mtg-attendee" key={a.id}>
                  <div className="mtg-attendee-name">{a.name || a.email || 'Unknown'}</div>
                  <div className="mtg-attendee-meta">
                    {[a.role, a.email].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      <div className="engagement-view-toggle" style={{ marginBottom: 14 }} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.dot ? (
              <span
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  marginLeft: 6,
                  verticalAlign: 'middle',
                }}
              />
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'prep' ? <PrepTab meeting={meeting} aiConfigured={aiConfigured} /> : null}
      {tab === 'notes' ? (
        <NotesTab
          meeting={meeting}
          onSendMeri={onSendMeri}
          onGoToDebrief={() => setTab('debrief')}
        />
      ) : null}
      {tab === 'debrief' ? <DebriefTab meeting={meeting} /> : null}
    </Drawer>
  );
}
