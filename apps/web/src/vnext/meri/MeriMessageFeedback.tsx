import { useEffect, useRef, useState } from 'react';
import {
  FEEDBACK_REASON_CODES,
  FEEDBACK_REASON_LABELS,
  type FeedbackReasonCode,
  type MessageFeedbackPayload,
} from '../../components/chat/message-feedback-shared.js';
import { MeriIcon } from './meri-icons.js';

/**
 * MeriMessageFeedback — per-answer thumbs + "what should Meri improve?"
 * dialog for the vNext thread. Re-skin of components/chat/MessageFeedback.tsx
 * (which renders legacy `action-proposal-dialog` chrome): identical rating
 * semantics — up toggles up/null, a second down-click clears, a first
 * down-click opens the reasons dialog — identical payload (rating + optional
 * reasons + note trimmed to 1000 chars) and identical focus management
 * (dialog focuses Cancel on open, the trigger regains focus on close). Reason
 * codes and labels come from the shared UI-free module, so the two surfaces
 * cannot drift on the feedback contract.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

export function MeriMessageFeedback({
  currentRating,
  onSubmit,
}: {
  currentRating?: 'up' | 'down' | null;
  onSubmit: (payload: MessageFeedbackPayload) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<FeedbackReasonCode[]>([]);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const submitDown = async () => {
    setSubmitting(true);
    try {
      await onSubmit({
        rating: 'down',
        ...(reasons.length ? { reasons } : {}),
        ...(note.trim() ? { note: note.trim().slice(0, 1000) } : {}),
      });
      close();
    } finally {
      setSubmitting(false);
    }
  };

  const toggleReason = (reason: FeedbackReasonCode) => {
    setReasons((current) =>
      current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason],
    );
  };

  const thumbStyle = (active: boolean) => ({
    width: 32,
    padding: 0,
    ...(active
      ? {
          background: 'var(--meri-accent-soft, #F2F0EB)',
          borderColor: 'var(--meri-border-strong, #E0DCD4)',
        }
      : {}),
  });

  return (
    <div
      aria-label="Response feedback"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
    >
      <button
        type="button"
        className="vnext-meri__inline-action-btn"
        aria-label="Helpful"
        title="Helpful"
        aria-pressed={currentRating === 'up'}
        style={thumbStyle(currentRating === 'up')}
        onClick={() => void onSubmit({ rating: currentRating === 'up' ? null : 'up' })}
      >
        <MeriIcon name="ThumbsUp" size={13} />
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="vnext-meri__inline-action-btn"
        aria-label="Not helpful"
        title="Not helpful"
        aria-pressed={currentRating === 'down'}
        style={thumbStyle(currentRating === 'down')}
        onClick={() => {
          if (currentRating === 'down') void onSubmit({ rating: null });
          else setOpen(true);
        }}
      >
        <MeriIcon name="ThumbsDown" size={13} />
      </button>

      {open && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80, // --meri-z-modal
            display: 'grid',
            placeItems: 'center',
            padding: 24,
            background: 'var(--m-scrim, rgba(12, 17, 29, 0.55))',
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="meri-feedback-dialog-title"
            style={{
              width: '100%',
              maxWidth: 460,
              borderRadius: 12,
              background: 'var(--meri-surface, #ffffff)',
              border: '1px solid var(--meri-border, #E8E5DF)',
              boxShadow: 'var(--m-shadow-modal, 0 24px 48px -12px rgba(16, 24, 40, 0.3))',
              padding: '18px 20px 16px',
            }}
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10,
                fontWeight: 500,
                letterSpacing: '.1em',
                color: 'var(--meri-text-muted, #667085)',
              }}
            >
              RESPONSE FEEDBACK
            </div>
            <h3
              id="meri-feedback-dialog-title"
              style={{
                margin: '7px 0 0',
                fontSize: 16,
                lineHeight: '23px',
                fontWeight: 600,
                color: 'var(--meri-ink, #101828)',
              }}
            >
              What should Meri improve?
            </h3>
            <p
              style={{
                margin: '5px 0 14px',
                fontSize: 13,
                lineHeight: '19px',
                color: 'var(--meri-text-muted, #667085)',
              }}
            >
              Select any reasons that apply. Do not include confidential source text in the note.
            </p>
            <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
              <legend
                style={{
                  padding: 0,
                  fontFamily: MONO,
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: 'var(--meri-text-secondary, #344054)',
                }}
              >
                REASON
              </legend>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  gap: '7px 12px',
                  marginTop: 9,
                }}
              >
                {FEEDBACK_REASON_CODES.map((reason) => (
                  <label
                    key={reason}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                      color: 'var(--meri-text-secondary, #344054)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={reasons.includes(reason)}
                      onChange={() => toggleReason(reason)}
                      style={{ accentColor: 'var(--meri-ink, #101828)', margin: 0 }}
                    />
                    {FEEDBACK_REASON_LABELS[reason]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label style={{ display: 'block', marginTop: 14 }}>
              <span
                style={{
                  display: 'block',
                  fontFamily: MONO,
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: 'var(--meri-text-secondary, #344054)',
                }}
              >
                OPTIONAL NOTE
              </span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.currentTarget.value.slice(0, 1000))}
                maxLength={1000}
                rows={3}
                placeholder="Briefly describe the problem without pasting sensitive material."
                style={{
                  width: '100%',
                  marginTop: 7,
                  padding: '9px 11px',
                  border: '1px solid var(--meri-border-strong, #E0DCD4)',
                  borderRadius: 8,
                  background: 'var(--meri-surface, #ffffff)',
                  font: 'inherit',
                  fontSize: 13,
                  lineHeight: '19px',
                  color: 'var(--meri-ink, #101828)',
                  resize: 'vertical',
                }}
              />
              <span
                style={{
                  display: 'block',
                  marginTop: 4,
                  textAlign: 'right',
                  fontFamily: MONO,
                  fontSize: 9.5,
                  letterSpacing: '.06em',
                  color: 'var(--meri-text-faint, #98A2B3)',
                }}
              >
                {note.length}/1000
              </span>
            </label>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                marginTop: 12,
              }}
            >
              <button
                ref={closeRef}
                type="button"
                className="vnext-meri__inline-action-btn"
                onClick={close}
                disabled={submitting}
              >
                CANCEL
              </button>
              <button
                type="button"
                className="vnext-meri__inline-action-btn"
                onClick={() => void submitDown()}
                disabled={submitting}
                style={{
                  backgroundImage: 'var(--m-metal-bg)',
                  boxShadow: 'var(--m-gradient-primary-sheen), var(--m-gradient-primary-shadow)',
                  color: '#ffffff',
                }}
              >
                {submitting ? 'SAVING…' : 'SUBMIT FEEDBACK'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
