import type { TenantContext } from '@capiro/shared';
import type { RecordQualityTelemetryEventInput } from '@capiro/meriv2-core';

export interface MeetingPrepTelemetrySource {
  prepId: string;
  clientId: string | null;
}

/**
 * Builds a QualityTelemetryEvent for a MeetingPrep lifecycle transition
 * (generated/edited/approved — the only three states this codebase actually
 * writes for MeetingPrep; `stale`/`failed` exist in the status vocabulary
 * but this phase only wires the states with a confirmed, understood write
 * site). Deliberately scoped to MeetingPrep only: MeetingDebrief/MeetingNote
 * bodies are encrypted client meeting content
 * (`notesCrypto.encrypt`/ciphertext columns) and are intentionally left
 * unwired this phase rather than risk any code path that could decrypt or
 * derive metrics from that content.
 *
 * No edit-metrics are computed here: `updateMeetingPrep` accepts a PARTIAL
 * field set, so a meaningful before/after diff would require comparing
 * per-field values across a partial update — not attempted in this phase
 * (section 16 of the Phase 27E plan: "only measure events/states the
 * product actually records").
 */
export function buildMeetingPrepTelemetryEvent(
  ctx: TenantContext,
  source: MeetingPrepTelemetrySource,
  eventType: 'generated' | 'edited' | 'approved',
  observedAt: Date,
): RecordQualityTelemetryEventInput {
  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: source.clientId,
    surface: 'meetings',
    operation: `meetings.prep.${eventType}`,
    eventType,
    artifactType: 'meeting_prep',
    artifactId: source.prepId,
    // No persisted context-packet linkage exists for MeetingPrep today
    // (generatedFrom carries a promptHash, not a ContextPacket id) —
    // recording unknown rather than guessing.
    contextPacketId: null,
    observedAt,
  };
}
