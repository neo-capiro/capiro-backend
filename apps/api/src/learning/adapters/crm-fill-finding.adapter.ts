import type { TenantContext } from '@capiro/shared';
import type { CaptureLearningSignalInput, SteeringLayer } from '@capiro/meriv2-core';

export interface CrmFillFindingSignalSource {
  findingId: string;
  runId: string;
  clientId: string;
  /** 'profile_field' | 'government_identity' | 'person' | 'facility' | 'capability' | 'lda_identity' | 'lda_history' | 'program_element' */
  kind: string;
  targetKey: string;
  /** 'public_web' | 'website' | 'synced_email' | 'sam_gov' | 'lda' | 'program_elements' */
  source: string;
  confidence: number;
}

const PEOPLE_KINDS = new Set(['person']);

function proposedLayerFor(kind: string): SteeringLayer {
  return PEOPLE_KINDS.has(kind) ? 'client-people' : 'client-steering';
}

/**
 * Builds a LearningSignal from a human admin accepting a Fill-with-Meri
 * finding. Pure function — no I/O, no promotion. Called from
 * `ClientProfileFillService.applyFindings` right after a finding is
 * successfully applied and marked accepted, on the SAME transaction, using
 * data already loaded for that finding (no second query).
 *
 * `evidenceRefs` point at the finding/run rows only — the finding's
 * `proposed_value_jsonb`/`evidence_jsonb` bodies are not duplicated here.
 */
export function buildCrmFillFindingAcceptedSignal(
  ctx: TenantContext,
  finding: CrmFillFindingSignalSource,
  observedAt: Date,
): CaptureLearningSignalInput {
  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: finding.clientId,
    sourceSurface: 'crm.fill_with_meri',
    sourceObjectType: 'client_profile_fill_finding',
    sourceObjectId: finding.findingId,
    sourceRunId: finding.runId,
    signalType: 'crm_finding_accepted',
    proposedMemoryLayer: proposedLayerFor(finding.kind),
    proposedMemoryClass: null,
    evidenceRefs: [
      { type: 'client_profile_fill_finding', id: finding.findingId },
      { type: 'client_profile_fill_run', id: finding.runId },
    ],
    confidence: Number.isFinite(finding.confidence) ? finding.confidence : null,
    // Not scored in 27A — a human accepted evidence-backed content, but
    // authority-tier assignment is later-phase (27B/27D) work, same
    // reasoning as the Meri adapter.
    sourceAuthority: null,
    sensitivity: 'normal',
    provenanceKind: 'human_explicit',
    provenance: { kind: finding.kind, targetKey: finding.targetKey, source: finding.source },
    governanceRequirement: 'human_required',
    observedAt,
  };
}

/**
 * Builds a LearningSignal from a human admin rejecting a finding. Same
 * shape as the accepted signal but a distinct `signalType` — a rejection is
 * a genuinely different judgment (this proposed fact was wrong or
 * inapplicable), valuable input for 27C's contradiction detection, not a
 * duplicate of the accept path.
 */
export function buildCrmFillFindingRejectedSignal(
  ctx: TenantContext,
  finding: CrmFillFindingSignalSource,
  observedAt: Date,
): CaptureLearningSignalInput {
  return {
    ...buildCrmFillFindingAcceptedSignal(ctx, finding, observedAt),
    signalType: 'crm_finding_rejected',
  };
}
