import type { TenantContext } from '@capiro/shared';
import type { RecordQualityTelemetryEventInput } from '@capiro/meriv2-core';
import type { NormalizedFeedback } from '../../meri/meri-feedback.helpers.js';

export interface MeriFeedbackTelemetrySource {
  messageId: string;
  clientId: string | null;
  /** From the message's own metadata, if the turn was Context-Plane-backed. */
  contextPacketId: string | null;
}

/**
 * Builds a QualityTelemetryEvent from an explicit Meri message rating.
 * Mirrors `buildMeriFeedbackSignal`'s contract exactly — same call site
 * (`MeriService.recordMessageFeedback`), same "clearing a rating isn't a new
 * event" rule, same reason not to copy the free-text note (only whether one
 * was left).
 */
export function buildMeriFeedbackTelemetryEvent(
  ctx: TenantContext,
  source: MeriFeedbackTelemetrySource,
  feedback: NormalizedFeedback,
  observedAt: Date,
): RecordQualityTelemetryEventInput | null {
  if (feedback.rating === null) return null;

  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: source.clientId,
    surface: 'meri',
    operation: 'meri.message.feedback',
    eventType: feedback.rating === 'up' ? 'feedback_positive' : 'feedback_negative',
    artifactType: 'meri_message',
    artifactId: source.messageId,
    contextPacketId: source.contextPacketId,
    provenance: { reasons: feedback.reasons, hasNote: feedback.note !== null },
    observedAt,
  };
}
