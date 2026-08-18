/**
 * message-feedback-shared — UI-free feedback contract shared by both chat
 * surfaces.
 *
 * The reason-code union is part of the API contract for
 * POST /api/clio/messages/:id/feedback (useMeriChatController.submitFeedback);
 * the labels are the one human rendering of those codes. The legacy dialog
 * (MessageFeedback.tsx) and the vNext dialog (vnext/meri/
 * MeriMessageFeedback.tsx) must submit identical payloads and offer identical
 * reasons — this module is the single copy, held UI-free (no react, no CSS)
 * so the vNext surface never imports the legacy-styled component at runtime.
 * MessageFeedback re-exports everything so legacy consumers are unchanged.
 */

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

export const FEEDBACK_REASON_LABELS: Record<FeedbackReasonCode, string> = {
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
