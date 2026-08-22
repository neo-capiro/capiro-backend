import type { TenantContext } from '@capiro/shared';
import type { CaptureLearningSignalInput, LearningSignalType } from '@capiro/meriv2-core';
import type { NormalizedFeedback } from '../../meri/meri-feedback.helpers.js';

export interface MeriFeedbackSignalSource {
  messageId: string;
  conversationId: string;
  clientId: string | null;
  /** From the message's own metadata, if the turn was Context-Plane-backed. Reference only. */
  contextPacketId: string | null;
}

/**
 * Builds a LearningSignal from an explicit Meri message rating (thumbs
 * up/down + optional reason codes). Pure function — no I/O, no promotion,
 * no writes — called from `MeriService.recordMessageFeedback` AFTER the
 * existing `clio_messages.metadata_jsonb.feedback` write succeeds, reusing
 * the same loaded message row and already-normalized feedback rather than a
 * second DB read.
 *
 * Deliberately does NOT copy the user's free-text note into the signal —
 * only whether one was left (`provenance.hasNote`). The note itself stays
 * where it already lives, on the message row; the signal is a pointer, not
 * a second copy. (`LearningSignalCandidateService` resolves the note text
 * fresh from `clio_messages` at candidate-generation time — see its
 * `resolveFactText` — so it can still reach a governed, human-reviewed
 * candidate without ever being duplicated onto this row.)
 */
export function buildMeriFeedbackSignal(
  ctx: TenantContext,
  source: MeriFeedbackSignalSource,
  feedback: NormalizedFeedback,
  observedAt: Date,
): CaptureLearningSignalInput | null {
  // Clearing a rating (rating: null) removes a prior judgment; it isn't
  // itself a new signal to capture.
  if (feedback.rating === null) return null;

  const signalType: LearningSignalType =
    feedback.rating === 'up' ? 'meri_feedback_positive' : 'meri_feedback_negative';

  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: source.clientId,
    sourceSurface: 'meri.chat',
    sourceObjectType: 'clio_message',
    sourceObjectId: source.messageId,
    sourceRunId: null,
    signalType,
    // Best-guess proposal only (27A never promotes anything): feedback tied
    // to a client conversation is a candidate client-steering observation;
    // otherwise it's about how this user personally wants Meri to respond.
    proposedMemoryLayer: source.clientId ? 'client-steering' : 'user-voice',
    proposedMemoryClass: null,
    evidenceRefs: [
      { type: 'clio_message', id: source.messageId },
      { type: 'clio_conversation', id: source.conversationId },
    ],
    // Not scored in 27A — confidence/authority assignment is later-phase work.
    confidence: null,
    sourceAuthority: null,
    sensitivity: 'normal',
    provenanceKind: 'human_explicit',
    provenance: {
      reasons: feedback.reasons,
      hasNote: feedback.note !== null,
      contextPacketId: source.contextPacketId,
    },
    governanceRequirement: 'human_required',
    observedAt,
  };
}
