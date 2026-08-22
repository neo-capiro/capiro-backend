import type { TenantContext } from '@capiro/shared';
import type { RecordQualityTelemetryEventInput } from '@capiro/meriv2-core';

export interface CrmFillFindingTelemetrySource {
  findingId: string;
  clientId: string;
  kind: string;
  source: string;
}

/**
 * Builds a QualityTelemetryEvent from a human admin's accept/reject decision
 * on a Fill-with-Meri finding. Pure function — no I/O — mirroring
 * `buildCrmFillFindingAcceptedSignal`'s shape, called from the SAME call
 * site (`ClientProfileFillService.captureFillFindingSignal`) right after the
 * LearningSignal capture attempt, using data already loaded for that
 * finding (no second query).
 *
 * Note: the real `client_profile_fill_finding.status` CHECK constraint only
 * allows `pending | accepted | rejected | informational` — the Phase 27E
 * handoff's assumed vocabulary (duplicate/corrected/conflicted) does not
 * exist in this table today, so only `accepted`/`rejected` are represented
 * here, matching what `captureFillFindingSignal` is actually called for.
 *
 * Does not attempt to backfill `learningSignalId`: the LearningSignal this
 * finding also produces (via `crm-fill-finding.adapter.ts`) is independently
 * correlatable later by matching `(tenantId, sourceObjectType=
 * 'client_profile_fill_finding', sourceObjectId=findingId)` on
 * `learning_signal` against `(tenantId, artifactType='crm_fill_finding',
 * artifactId=findingId)` here — a deliberate MVP simplification, not a
 * missing requirement.
 */
export function buildCrmFillFindingTelemetryEvent(
  ctx: TenantContext,
  finding: CrmFillFindingTelemetrySource,
  outcome: 'accepted' | 'rejected',
  observedAt: Date,
): RecordQualityTelemetryEventInput {
  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: finding.clientId,
    surface: 'crm_fill',
    operation: 'crm_fill.finding.decide',
    eventType: outcome === 'accepted' ? 'approved' : 'rejected',
    artifactType: 'crm_fill_finding',
    artifactId: finding.findingId,
    // No per-finding ContextPacket exists — findings come from an
    // extraction pipeline run, not a live generation with a resolved
    // packet. Recording `unknown` (i.e. omitting it) rather than guessing.
    contextPacketId: null,
    provenance: { kind: finding.kind, source: finding.source },
    observedAt,
  };
}
