import { useEffect } from 'react';
import { App, Form, Radio } from 'antd';
import { X } from 'lucide-react';
import { NotetakerConsentFields, extractMeetingJoinUrl } from '../meeting-actions.js';
import { useDispatchNotetaker } from './meetings-api.js';
import { MeriGlyph } from './meetings-ui.js';
import type { Meeting } from './meetings-types.js';

interface FormValues {
  meetingUrl: string;
  authorizedToRecord: boolean;
  allPartiesWillBeNotified: boolean;
  timing: 'schedule' | 'now';
}

/**
 * "Send Meri to take notes?" — prototype-styled consent card (custom overlay,
 * scoped to the meetings content so it never blanks the page) wrapping the
 * compliance-reviewed consent form (NotetakerConsentFields — the single source
 * of that copy) plus scheduling (spec §4.2: schedule at start vs join now).
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
  const startInFuture = meeting ? new Date(meeting.startsAt).getTime() > Date.now() : false;

  useEffect(() => {
    if (open && meeting) {
      form.setFieldsValue({
        meetingUrl: meeting.joinLink ?? extractMeetingJoinUrl(meeting) ?? '',
        authorizedToRecord: false,
        allPartiesWillBeNotified: false,
        timing: startInFuture ? 'schedule' : 'now',
      });
    }
  }, [open, meeting, startInFuture, form]);

  if (!open || !meeting) return null;

  const submit = async () => {
    const values = await form.validateFields();
    await dispatch.mutateAsync({
      meetingId: meeting.id,
      meetingUrl: values.meetingUrl,
      authorizedToRecord: values.authorizedToRecord,
      allPartiesWillBeNotified: values.allPartiesWillBeNotified,
      joinAt: values.timing === 'schedule' ? meeting.startsAt : undefined,
    });
    message.success(
      values.timing === 'schedule' ? 'Meri scheduled for this meeting.' : 'Meri is joining now.',
    );
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(12,26,56,0.34)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backdropFilter: 'blur(1.5px)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: 480,
          maxHeight: '90%',
          overflow: 'auto',
          borderRadius: 12,
          padding: 0,
          boxShadow: '0 20px 60px rgba(12,26,56,0.28)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-1)',
          }}
        >
          <MeriGlyph size={26} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-1)' }}>
              Send Meri to take notes
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{meeting.subject}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn sm btn-ghost"
            style={{ padding: 6 }}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div style={{ padding: '16px 20px' }}>
          <Form form={form} layout="vertical">
            <NotetakerConsentFields />
            {startInFuture ? (
              <Form.Item name="timing" label="When should Meri join?">
                <Radio.Group>
                  <Radio value="schedule">At meeting start (scheduled)</Radio>
                  <Radio value="now">Now</Radio>
                </Radio.Group>
              </Form.Item>
            ) : (
              <Form.Item name="timing" hidden>
                <input type="hidden" />
              </Form.Item>
            )}
          </Form>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '13px 20px',
            borderTop: '1px solid var(--border-1)',
            background: 'var(--bg-surface-2)',
          }}
        >
          <button type="button" onClick={onClose} className="btn sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!(authorized && notified) || dispatch.isPending}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              border: 'none',
              borderRadius: 7,
              padding: '7px 15px',
              cursor: !(authorized && notified) ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
              fontWeight: 600,
              background: '#0C1A38',
              color: '#F5F2EB',
              opacity: !(authorized && notified) ? 0.4 : 1,
            }}
          >
            <MeriGlyph size={16} />
            {dispatch.isPending ? 'Sending…' : 'Send Meri'}
          </button>
        </div>
      </div>
    </div>
  );
}
