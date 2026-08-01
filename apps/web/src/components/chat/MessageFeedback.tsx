import { useEffect, useRef, useState } from 'react';

export const FEEDBACK_REASON_CODES = [
  'factually_wrong',
  'outdated',
  'wrong_client_context',
  'missed_source',
  'unsupported_claim',
  'too_generic',
  'bad_recommendation',
  'wrong_tone_or_format',
  'compliance_concern',
  'tool_or_action_failed',
] as const;

export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number];

const REASON_LABELS: Record<FeedbackReasonCode, string> = {
  factually_wrong: 'Factually wrong',
  outdated: 'Outdated',
  wrong_client_context: 'Wrong client context',
  missed_source: 'Missed source',
  unsupported_claim: 'Unsupported claim',
  too_generic: 'Too generic',
  bad_recommendation: 'Bad recommendation',
  wrong_tone_or_format: 'Wrong tone or format',
  compliance_concern: 'Compliance concern',
  tool_or_action_failed: 'Tool or action failed',
};

export interface MessageFeedbackPayload {
  rating: 'up' | 'down' | null;
  reasons?: FeedbackReasonCode[];
  note?: string;
}

export function MessageFeedback({
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

  return (
    <div className="meri-feedback-actions" aria-label="Response feedback">
      <button
        type="button"
        aria-label="Helpful"
        title="Helpful"
        aria-pressed={currentRating === 'up'}
        onClick={() => void onSubmit({ rating: currentRating === 'up' ? null : 'up' })}
      >
        👍
      </button>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Not helpful"
        title="Not helpful"
        aria-pressed={currentRating === 'down'}
        onClick={() => {
          if (currentRating === 'down') void onSubmit({ rating: null });
          else setOpen(true);
        }}
      >
        👎
      </button>

      {open && (
        <div className="action-proposal-dialog-backdrop" role="presentation">
          <section
            className="action-proposal-dialog feedback-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-dialog-title"
          >
            <h3 id="feedback-dialog-title">What should Meri improve?</h3>
            <p>Select any reasons that apply. Do not include confidential source text in the note.</p>
            <fieldset>
              <legend>Reason</legend>
              <div className="feedback-dialog__reasons">
                {FEEDBACK_REASON_CODES.map((reason) => (
                  <label key={reason}>
                    <input
                      type="checkbox"
                      checked={reasons.includes(reason)}
                      onChange={() => toggleReason(reason)}
                    />
                    {REASON_LABELS[reason]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="feedback-dialog__note">
              Optional note
              <textarea
                value={note}
                onChange={(event) => setNote(event.currentTarget.value.slice(0, 1000))}
                maxLength={1000}
                rows={3}
                placeholder="Briefly describe the problem without pasting sensitive material."
              />
              <span>{note.length}/1000</span>
            </label>
            <div className="action-proposal-dialog__actions">
              <button ref={closeRef} type="button" onClick={close} disabled={submitting}>
                Cancel
              </button>
              <button type="button" onClick={() => void submitDown()} disabled={submitting}>
                {submitting ? 'Saving…' : 'Submit feedback'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
