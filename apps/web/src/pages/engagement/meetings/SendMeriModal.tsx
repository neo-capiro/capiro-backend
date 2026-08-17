import { useEffect } from 'react';
import { App, Form } from 'antd';
import { Lock } from 'lucide-react';
import { NotetakerConsentFields, extractMeetingJoinUrl } from '../meeting-actions.js';
import { useDispatchNotetaker } from './meetings-api.js';
import { MeriGlyph } from './meetings-ui.js';
import type { Meeting } from './meetings-types.js';
import { EngagementDialog } from './EngagementDialog.js';

interface FormValues {
  meetingUrl: string;
  authorizedToRecord: boolean;
  allPartiesWillBeNotified: boolean;
}

/**
 * "Send Meri to take notes?" — wraps the compliance-reviewed consent form
 * (NotetakerConsentFields — the single source of that copy; do not edit its
 * wording here). Migrated onto the shared EngagementDialog shell (2026-08-16,
 * vNext Engagement reskin Phase 5): the previous hand-rolled `createPortal`
 * had NO Escape-key handling, no focus trap, and no scroll lock — the
 * highest-priority gap flagged for this modal and `ShareConfirmation`, since
 * between them they carry the heaviest product rules (consent-gated
 * recording, per-artifact sharing) of any Engagement modal. EngagementDialog
 * is already the real, current shell for every OTHER Meetings modal (Assign,
 * Attendees, Edit Prep/Notes/Debrief, Upload) — this brings the last two
 * holdouts in line, it does not introduce a new design system to
 * app.capiro.ai. As a side effect of EngagementDialog's own new
 * auto-detected portal target, this dialog (like every other
 * EngagementDialog) now also renders inside the vNext navy CSS scope on
 * os.capiro.ai instead of always portaling to document.body.
 */
export function SendMeriModal({
  meeting,
  open,
  onClose,
}: {
  meeting: Meeting | null;
  open: boolean;
  onClose: () => void;
}) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const dispatch = useDispatchNotetaker();
  const authorized = Form.useWatch('authorizedToRecord', form);
  const notified = Form.useWatch('allPartiesWillBeNotified', form);

  useEffect(() => {
    if (open && meeting) {
      form.setFieldsValue({
        meetingUrl: meeting.joinLink ?? extractMeetingJoinUrl(meeting) ?? '',
        authorizedToRecord: false,
        allPartiesWillBeNotified: false,
      });
    }
  }, [open, meeting, form]);

  const ready = Boolean(authorized && notified);

  const submit = async () => {
    if (!meeting) return;
    const values = await form.validateFields();
    await dispatch.mutateAsync({
      meetingId: meeting.id,
      meetingUrl: values.meetingUrl,
      authorizedToRecord: values.authorizedToRecord,
      allPartiesWillBeNotified: values.allPartiesWillBeNotified,
      joinAt: meeting.startsAt,
    });
    message.success('Meri is joining this meeting.');
    onClose();
  };

  return (
    <EngagementDialog
      open={open && meeting != null}
      eyebrow="Meeting · compliance"
      title="Send Meri to take notes"
      description={meeting?.subject}
      width={520}
      busy={dispatch.isPending}
      busyLabel="Scheduling Meri…"
      dirty={Boolean(authorized || notified)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={dispatch.isPending} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-accent"
            disabled={!ready || dispatch.isPending}
            onClick={() => void submit()}
          >
            <MeriGlyph size={16} tone="invert" />
            {dispatch.isPending ? 'Sending…' : 'Send Meri'}
          </button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          gap: 9,
          padding: '10px 12px',
          marginBottom: 16,
          background: 'var(--bg-sunken, #f9fafb)',
          borderRadius: 8,
        }}
      >
        <Lock size={14} style={{ color: 'var(--ink-3, #667085)', marginTop: 2, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-1, #101828)' }}>
            Private until you share it
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-3, #667085)' }}>
            You can share these notes with your organization at any time from the meeting panel.
          </div>
        </div>
      </div>
      <Form form={form} layout="vertical">
        <NotetakerConsentFields />
      </Form>
    </EngagementDialog>
  );
}
