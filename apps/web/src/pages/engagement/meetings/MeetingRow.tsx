import { CheckCircleFilled, RightOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { SendMeriButton, MeriAttendingPill } from '../meeting-actions.js';
import { providerLabel } from './meetings-format.js';
import {
  artifactStatus,
  eligibleForMeri,
  type ArtifactKind,
  type Meeting,
} from './meetings-types.js';

const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  prep: 'Prep',
  notes: 'Notes',
  debrief: 'Debrief',
};

/** The Meri action for a row: Send button, Attending pill, or nothing. */
function MeriAction({
  meeting,
  onSendMeri,
}: {
  meeting: Meeting;
  onSendMeri: (m: Meeting) => void;
}) {
  if (!eligibleForMeri(meeting)) return null;
  if (meeting.meri === 'scheduled' || meeting.meri === 'attending') return <MeriAttendingPill />;
  if (meeting.meri === 'done') return null;
  return <SendMeriButton onClick={() => onSendMeri(meeting)} />;
}

function SubLine({ meeting }: { meeting: Meeting }) {
  const bits: string[] = [];
  if (meeting.client) bits.push(meeting.client.name);
  if (meeting.isVirtual) {
    bits.push(providerLabel(meeting.provider) ?? 'Virtual');
    if (!meeting.joinLink) bits.push('link not detected');
  } else {
    bits.push('In person');
  }
  return (
    <div className="mtg-row-sub">
      <VideoCameraOutlined />
      <span>{bits.join(' · ')}</span>
    </div>
  );
}

/** A single meeting row (Day + List views). Rows never carry Join — that lives
 *  in the detail panel header (spec §3). */
export function MeetingRow({
  meeting,
  selected,
  onSelect,
  onSendMeri,
}: {
  meeting: Meeting;
  selected: boolean;
  onSelect: (m: Meeting) => void;
  onSendMeri: (m: Meeting) => void;
}) {
  const status = artifactStatus(meeting);
  return (
    <div
      className={`mtg-row${selected ? ' is-selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(meeting)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(meeting);
        }
      }}
    >
      <div className="mtg-row-time">
        {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
          new Date(meeting.startsAt),
        )}
      </div>
      <div className="mtg-row-main">
        <div className="mtg-row-title">{meeting.subject}</div>
        <SubLine meeting={meeting} />
        <div className="mtg-row-meri">
          <MeriAction meeting={meeting} onSendMeri={onSendMeri} />
        </div>
      </div>
      <div className="mtg-row-right">
        <div className="mtg-artifacts">
          {(Object.keys(ARTIFACT_LABELS) as ArtifactKind[]).map((kind) => (
            <span key={kind} className={`mtg-artifact-pill${status[kind] ? ' is-complete' : ''}`}>
              {status[kind] ? <CheckCircleFilled /> : null}
              {ARTIFACT_LABELS[kind]}
            </span>
          ))}
        </div>
        <RightOutlined className="mtg-row-chevron" />
      </div>
    </div>
  );
}
