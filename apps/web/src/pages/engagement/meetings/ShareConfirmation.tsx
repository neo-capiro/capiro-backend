import { App, Modal } from 'antd';
import { CheckCircleFilled, TeamOutlined } from '@ant-design/icons';
import { useMe } from '../../../lib/me.js';
import { useShareMeeting } from './meetings-api.js';
import { artifactStatus, type Meeting } from './meetings-types.js';

const KIND_LABELS: Record<string, string> = { prep: 'Prep', notes: 'Notes', debrief: 'Debrief' };

/**
 * Share confirmation (spec §6.2): states WHAT is shared, WHERE it appears, and
 * WHO can see it, before applying. Includes the co-share notice for the case
 * where someone already shared this meeting (dormant in Phase 1 — no second
 * possible sharer yet — but rendered when the condition is met).
 */
export function ShareConfirmation({
  meeting,
  open,
  onClose,
}: {
  meeting: Meeting | null;
  open: boolean;
  onClose: () => void;
}) {
  const me = useMe();
  const { message } = App.useApp();
  const share = useShareMeeting();

  const status = meeting ? artifactStatus(meeting) : { prep: false, notes: false, debrief: false };
  const approved = (['prep', 'notes', 'debrief'] as const).filter((k) => status[k]);
  const clientName = meeting?.client?.name ?? null;

  const coShared =
    meeting?.visibility === 'shared' &&
    Boolean(meeting.sharedBy) &&
    meeting.sharedBy?.userId !== me.data?.user.id;

  const confirm = async () => {
    if (!meeting) return;
    await share.mutateAsync(meeting.id);
    message.success(`Saved to ${clientName ?? 'the client'} · Documents.`);
    onClose();
  };

  return (
    <Modal
      title="Share this meeting to the client?"
      open={open}
      onCancel={onClose}
      onOk={confirm}
      okText="Share"
      confirmLoading={share.isPending}
      okButtonProps={{ disabled: !clientName }}
      width={520}
      rootClassName="redesign"
      destroyOnHidden
    >
      {!clientName ? (
        <p style={{ color: 'var(--critical)' }}>
          This meeting isn&apos;t associated with a client yet. Associate a client before sharing.
        </p>
      ) : (
        <>
          {coShared ? (
            <div className="mtg-tab-banner" style={{ marginBottom: 14 }}>
              <TeamOutlined />
              <span>
                {meeting?.sharedBy?.name ?? 'A colleague'} has already shared this meeting —
                you&apos;re adding to the existing shared record, not creating a duplicate.
              </span>
            </div>
          ) : null}
          <p>
            <strong>What</strong> — the meeting record and its approved material:
          </p>
          <ul>
            {approved.length ? (
              approved.map((k) => (
                <li key={k}>
                  <CheckCircleFilled style={{ color: 'var(--success)', marginRight: 6 }} />
                  {KIND_LABELS[k]}
                </li>
              ))
            ) : (
              <li style={{ color: 'var(--ink-3)' }}>
                Nothing is approved yet — approve materials and they&apos;ll join this shared record
                automatically.
              </li>
            )}
          </ul>
          <p>
            <strong>Where</strong> — {clientName}&apos;s <strong>Documents</strong> tab and your
            firm&apos;s <strong>Meeting Library</strong>.
          </p>
          <p>
            <strong>Who</strong> — visible to your organization.
          </p>
        </>
      )}
    </Modal>
  );
}
