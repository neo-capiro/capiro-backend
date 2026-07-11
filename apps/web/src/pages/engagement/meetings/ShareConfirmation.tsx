import { App } from 'antd';
import { createPortal } from 'react-dom';
import { FileStack, FolderOpen, Info, Users } from 'lucide-react';
import { useMe } from '../../../lib/me.js';
import { useShareMeeting } from './meetings-api.js';
import type { Meeting } from './meetings-types.js';

/**
 * Share confirmation (spec §6.2) — a port of the prototype ShareConfirm: states
 * WHAT is shared, WHERE it appears, and WHO can see it before applying, with the
 * co-share notice when someone else already shared this meeting. Rendered via
 * portal as a true full-viewport modal (same treatment as SendMeriModal) so it
 * can never be cropped by an ancestor's bounds.
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

  if (!open || !meeting) return null;
  const clientName = meeting.client?.name ?? null;
  const coShared = Boolean(meeting.sharedBy) && meeting.sharedBy?.userId !== me.data?.user.id;

  const rows = [
    {
      icon: <FileStack size={17} />,
      k: "What's shared",
      v: 'The full meeting record — Prep, Meeting Notes, and Debrief (each as it’s approved).',
    },
    {
      icon: <FolderOpen size={17} />,
      k: 'Where it appears',
      v: `${clientName ?? 'the client'} → Documents, and your firm’s Meeting Library.`,
    },
    { icon: <Users size={17} />, k: 'Who can see it', v: 'Everyone in your organization.' },
  ];

  const confirm = async () => {
    await share.mutateAsync(meeting.id);
    message.success(`Saved to ${clientName ?? 'the client'} · Documents.`);
    onClose();
  };

  return createPortal(
    <div
      onClick={onClose}
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
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: 440,
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
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: 'var(--success-soft)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--success)',
            }}
          >
            <Users size={16} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-1)' }}>
              Share with your organization?
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{meeting.subject}</div>
          </div>
        </div>
        <div style={{ padding: '8px 20px 4px' }}>
          {rows.map((r, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 12,
                padding: '12px 0',
                borderBottom: i < rows.length - 1 ? '1px solid var(--border-1)' : 'none',
              }}
            >
              <span style={{ color: 'var(--ink-3)', marginTop: 1, flexShrink: 0 }}>{r.icon}</span>
              <div>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--ink-3)',
                    marginBottom: 2,
                  }}
                >
                  {r.k}
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-1)' }}>{r.v}</div>
              </div>
            </div>
          ))}
        </div>
        {coShared && (
          <div
            style={{
              margin: '4px 20px 0',
              display: 'flex',
              gap: 9,
              padding: '10px 12px',
              background: 'var(--notable-soft)',
              border: '1px solid var(--notable)',
              borderRadius: 8,
            }}
          >
            <Info size={15} style={{ color: 'var(--notable)', marginTop: 1, flexShrink: 0 }} />
            <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-1)' }}>
              <strong>{meeting.sharedBy?.name ?? 'A colleague'}</strong> already shared this meeting
              to {clientName ?? 'this client'}. Your materials are added <strong>alongside</strong>{' '}
              theirs under the same meeting record — nothing is overwritten.
            </div>
          </div>
        )}
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
            onClick={confirm}
            disabled={!clientName || share.isPending}
            className="btn sm"
            style={{ gap: 6, background: 'var(--success)', color: '#fff', border: 'none' }}
          >
            <Users size={13} />
            {share.isPending ? 'Sharing…' : 'Share'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
