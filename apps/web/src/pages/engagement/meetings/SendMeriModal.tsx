import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { App, Form } from 'antd';
import { Lock, X } from 'lucide-react';
import { NotetakerConsentFields, extractMeetingJoinUrl } from '../meeting-actions.js';
import { useDispatchNotetaker } from './meetings-api.js';
import { MeriGlyph } from './meetings-ui.js';
import type { Meeting } from './meetings-types.js';

interface FormValues {
  meetingUrl: string;
  authorizedToRecord: boolean;
  allPartiesWillBeNotified: boolean;
}

/**
 * "Send Meri to take notes?" — prototype-styled consent card wrapping the
 * compliance-reviewed consent form (NotetakerConsentFields — the single source
 * of that copy; do not edit its wording here). Rendered via portal as a true
 * full-viewport modal so it can never be cropped by an ancestor's bounds.
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

  if (!open || !meeting) return null;

  const submit = async () => {
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

  return createPortal(
    // className="redesign" is required here: this is a raw createPortal to
    // document.body, so it sits OUTSIDE the page's <section className="...
    // redesign"> DOM subtree and doesn't inherit that scope's font/antd
    // overrides. Without it, NotetakerConsentFields' antd Typography/Form/
    // Checkbox render in the app's global default look (Public Sans + navy)
    // instead of this module's Hanken Grotesk + accent-blue design.
    <div
      onClick={onClose}
      className="redesign"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(12,26,56,0.34)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backdropFilter: 'blur(1.5px)',
        // var(--font-sans) is not a global token (it's only defined inside a
        // handful of OTHER unrelated component scopes) — use the real one.
        fontFamily: 'var(--font-sans-rd)',
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
          <div
            style={{
              display: 'flex',
              gap: 9,
              padding: '10px 12px',
              marginBottom: 16,
              background: 'var(--bg-sunken)',
              borderRadius: 8,
            }}
          >
            <Lock size={14} style={{ color: 'var(--ink-3)', marginTop: 2, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-1)' }}>
                Private until you share it
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-3)' }}>
                You can share these notes with your organization at any time from the meeting
                panel.
              </div>
            </div>
          </div>
          <Form form={form} layout="vertical">
            <NotetakerConsentFields />
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
    </div>,
    document.body,
  );
}
