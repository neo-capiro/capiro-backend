export type FeedbackRating = 'up' | 'down' | null;

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

export interface NormalizedFeedback {
  rating: FeedbackRating;
  reasons: FeedbackReasonCode[];
  note: string | null;
}

const MAX_NOTE = 1000;
const REASON_SET = new Set<string>(FEEDBACK_REASON_CODES);

/**
 * Clamp the user-authored portion of a feedback event. Runtime/model/context
 * provenance is attached server-side from the persisted message metadata so a
 * browser cannot forge the evaluation dimensions used by Phase 4.
 */
export function normalizeFeedback(input: {
  rating?: unknown;
  reasons?: unknown;
  note?: unknown;
}): NormalizedFeedback {
  const rating: FeedbackRating =
    input.rating === 'up' ? 'up' : input.rating === 'down' ? 'down' : null;
  const reasons = Array.isArray(input.reasons)
    ? [...new Set(input.reasons.filter((value): value is FeedbackReasonCode =>
        typeof value === 'string' && REASON_SET.has(value),
      ))].slice(0, FEEDBACK_REASON_CODES.length)
    : [];
  let note: string | null = null;
  if (typeof input.note === 'string') {
    const trimmed = input.note.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    note = trimmed ? trimmed.slice(0, MAX_NOTE) : null;
  }
  return { rating, reasons, note };
}
