import { App, Button, Popconfirm } from 'antd';
import { AudioOutlined, CheckCircleFilled, RobotOutlined } from '@ant-design/icons';
import { SendMeriButton } from '../meeting-actions.js';
import { useCancelNotetaker } from './meetings-api.js';
import { eligibleForMeri, type Meeting } from './meetings-types.js';

/**
 * Meeting Notes tab = the Meri notetaker surface. Notes are Meri's factual
 * record of the call; when captured, the takeaways live in Debrief.
 */
export function NotesTab({
  meeting,
  onSendMeri,
  onGoToDebrief,
}: {
  meeting: Meeting;
  onSendMeri: (m: Meeting) => void;
  onGoToDebrief: () => void;
}) {
  const { message } = App.useApp();
  const cancel = useCancelNotetaker();

  if (meeting.meri === 'scheduled' || meeting.meri === 'attending') {
    return (
      <div className="mtg-empty-tab">
        <RobotOutlined style={{ fontSize: 22, color: 'var(--accent)' }} />
        <p style={{ marginTop: 10 }}>
          <strong>Meri Attending.</strong> Meri will attend this meeting and take notes. Meeting
          notes will populate here automatically after Meri attends and summarizes the call.
        </p>
        <Popconfirm
          title="Cancel Meri?"
          description="Meri will leave the call and won't capture notes."
          okText="Cancel Meri"
          okButtonProps={{ danger: true }}
          onConfirm={async () => {
            await cancel.mutateAsync(meeting.id);
            message.success('Meri cancelled.');
          }}
        >
          <Button danger loading={cancel.isPending}>
            Cancel Meri
          </Button>
        </Popconfirm>
      </div>
    );
  }

  if (meeting.meri === 'done') {
    return (
      <div className="mtg-empty-tab">
        <CheckCircleFilled style={{ fontSize: 22, color: 'var(--success)' }} />
        <p style={{ marginTop: 10 }}>
          Meri captured this meeting and drafted a debrief from the transcript.
        </p>
        <Button type="primary" onClick={onGoToDebrief}>
          View the debrief
        </Button>
      </div>
    );
  }

  // No active/finished notetaker.
  if (eligibleForMeri(meeting)) {
    return (
      <div className="mtg-empty-tab">
        <AudioOutlined style={{ fontSize: 22, color: 'var(--accent)' }} />
        <p style={{ marginTop: 10 }}>
          No notes yet. Send Meri to attend this meeting and capture notes for you.
        </p>
        <SendMeriButton onClick={() => onSendMeri(meeting)} />
      </div>
    );
  }

  return (
    <div className="mtg-empty-tab">
      <p>
        This is an in-person meeting, so Meri can&apos;t attend. Capture your takeaways in{' '}
        <Button type="link" style={{ padding: 0 }} onClick={onGoToDebrief}>
          Debrief
        </Button>
        .
      </p>
    </div>
  );
}
