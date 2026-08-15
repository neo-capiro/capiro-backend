/**
 * Phase 6 → canonical promotion, the missing producer (Gap 1).
 *
 * `Phase6CycleCertificationInputV1.projections` has always accepted an array
 * of `Phase6NativeProjectionV1`, and `projectPhase6ProjectionsV1` has always
 * consumed one — but nothing in production code ever built one from real
 * stage-extraction output, and nothing ever computed `nativeIdentityHash`.
 * See docs/defense-budget/PHASE-7-ARCHITECTURE-GAPS.md Gap 1 for the full
 * diagnosis. This module is that producer.
 *
 * ---------------------------------------------------------------------------
 * Scope, updated by Phase 7 Gap 5 decisions B1/B2/B3
 * ---------------------------------------------------------------------------
 *
 * Session 9 covered `stage_position` from `emitStageRowsV1`'s output (HASC,
 * SASC, HAC-D, SAC-D, NDAA conference, appropriations conference) and
 * `stage_action` for identity-scoped actions only.
 *
 * This pass closes three of the four remaining items, each exactly as narrow
 * as Neo's decision specified — plumbing where the vocabulary already existed,
 * one real identity design where it did not:
 *
 *   - `buildEnactedStagePositionProjectionV1` (B1) — threads the *existing*
 *     `DefenseBudgetEnactmentProofV1` through for `public_law` /
 *     `continuing_resolution` positions. No second proof model. Fails closed
 *     with no default if a governed position has none.
 *   - `buildExecutionStagePositionProjectionV1` (B2) — threads the *existing*
 *     `ExecutionRecordV1` metric/asOfDate/cumulative fields through for
 *     `execution` positions. No new metric vocabulary. Fails closed if any of
 *     the three is absent — which `executionRecordV1Schema` already makes
 *     structurally impossible, so this function's own checks are a second,
 *     defense-in-depth read of a guarantee the source schema already gives.
 *   - `buildStageActionProjectionV1` (B3) — no longer refuses a package-scope,
 *     account-scope, or transfer-pair action outright. It now falls back to
 *     `deriveActionScopeIdentityV1` (`phase6-action-scope-identity-v1.ts`) for
 *     the three shapes that function recognizes, and still refuses — by name,
 *     never by guessing — the one shape it does not: an action naming only one
 *     side of a transfer.
 *
 * Left for a later pass: `vehicle_proof`, `native_line_binding`,
 * `provision_link`, `enactment_proof` (the projection *kind*, not the proof
 * object B1 threads) — not attempted this pass either, same as before.
 *
 * Every refusal in this module is explicit (see the `*RefusalV1` result arms)
 * rather than a silent drop — consistent with invariant 11 ("no unsupported
 * item is silently dropped") even though these are refused one layer upstream
 * of the promotion planner itself.
 */
import { moneyToMillionsString } from '../contracts/decimal-string.js';
import type { MoneyUnitV1, MoneyValueV1 } from '../contracts/extraction-artifact-v1.js';
import type { DefenseBudgetStageActionV1 } from '../stages/appropriations/actions/defense-budget-stage-action-v1.js';
import { nativeIdentityHashV1 } from '../stages/budget-line-reference-v1.js';
import type { StagePositionV1 } from '../stages/stage-row-emitter-v1.js';
import { STAGE_TRACK, type StageV1 } from '../stages/stage-vocabulary-v1.js';
import type {
  DefenseBudgetEnactmentProofV1,
  EnactedLineCandidateV1,
} from '../stages/enacted/enactment-proof-v1.js';
import type { ExecutionCompositionV1 } from '../stages/post-enactment/reprogramming-execution-v1.js';
import {
  deriveActionScopeIdentityV1,
  phase6ActionScopeIdentityHashV1,
  type Phase6ActionScopeIdentityV1,
  type Phase6ActionVehicleClassV1,
} from './phase6-action-scope-identity-v1.js';
import {
  phase6ProjectionIdV1,
  type Phase6NativeProjectionV1,
} from './phase6-native-projection-v1.js';

/**
 * Everything about *where this row came from* that the row/action data itself
 * does not carry. Reload these from persistence (source-document, artifact,
 * verification-run records) at the call site — never accept them from an
 * untrusted caller, for the same reason Workstream A's eligibility service
 * reloads its own proof rather than trusting a caller-supplied object.
 */
export interface Phase6ProjectionProvenanceV1 {
  verificationCandidateId: string;
  verificationRunId: string;
  artifactId: string;
  artifactContentSha256: string;
  sourceDocumentId: string;
  sourcePdfSha256: string;
  sourceProfileHash: string;
  evidenceIds: string[];
}

const STAGES_BUILT_BY_ROW_EMITTER: ReadonlySet<StageV1> = new Set([
  'hasc',
  'sasc',
  'hac_d',
  'sac_d',
  'ndaa_conference',
  'appropriations_conference',
]);

function toMoneyValueV1(value: string, unit: MoneyUnitV1): MoneyValueV1 {
  return {
    originalValue: value,
    originalUnit: unit,
    valueMillions: moneyToMillionsString(value, unit),
  };
}

/** `nativeIdentityHash | fiscalYear | stage | field-or-action-key`, matching the mapping registry's documented key order. */
function naturalKeyV1(parts: readonly (string | number)[]): string {
  return parts.map(String).join('|');
}

export type StagePositionProjectionRefusalReasonV1 = 'stage_not_supported' | 'missing_fiscal_year';

export interface StagePositionProjectionRefusalV1 {
  reason: StagePositionProjectionRefusalReasonV1;
  detail: string;
}

export type StagePositionProjectionResultV1 =
  | { ok: true; projection: Phase6NativeProjectionV1 }
  | { ok: false; refusal: StagePositionProjectionRefusalV1 };

/**
 * `emitStageRowsV1` only emits a `StagePositionV1` for an `accepted` binding
 * (see `stage-row-emitter-v1.ts`'s own contract), so `bindingStatus` here is
 * always `'accepted'` — this function has no path to emit anything else.
 */
export function buildStagePositionProjectionV1(
  position: StagePositionV1,
  stage: StageV1,
  provenance: Phase6ProjectionProvenanceV1,
  projectionStatus: Phase6NativeProjectionV1['projectionStatus'],
): StagePositionProjectionResultV1 {
  if (!STAGES_BUILT_BY_ROW_EMITTER.has(stage)) {
    return {
      ok: false,
      refusal: {
        reason: 'stage_not_supported',
        detail: `stage "${stage}" is not built by this producer pass; see Gap 1 remaining work`,
      },
    };
  }
  if (position.fiscalYear == null) {
    return {
      ok: false,
      refusal: {
        reason: 'missing_fiscal_year',
        detail: 'a stage position with no fiscal year cannot be projected',
      },
    };
  }

  const nativeIdentityHash = nativeIdentityHashV1(position.identity);
  const naturalKey = naturalKeyV1([nativeIdentityHash, position.fiscalYear, stage, position.field]);
  // Idempotency additionally pins the exact source row, so replaying the same
  // document twice recognizes the same projection rather than colliding on a
  // shared natural key from a different row.
  const idempotencyKey = `phase6:${naturalKey}:${provenance.artifactId}:${position.rowIndex}`;

  const projection: Phase6NativeProjectionV1 = {
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: phase6ProjectionIdV1({ naturalKey, idempotencyKey }),
    naturalKey,
    idempotencyKey,
    projectionKind: 'stage_position',
    verificationCandidateId: provenance.verificationCandidateId,
    verificationRunId: provenance.verificationRunId,
    artifactId: provenance.artifactId,
    artifactContentSha256: provenance.artifactContentSha256,
    sourceDocumentId: provenance.sourceDocumentId,
    sourcePdfSha256: provenance.sourcePdfSha256,
    sourceProfileHash: provenance.sourceProfileHash,
    nativeIdentityHash,
    track: STAGE_TRACK[stage],
    stage,
    fundingField: position.field,
    money: toMoneyValueV1(position.value, position.unit),
    directOrDerived: position.provenance,
    evidenceIds: [...provenance.evidenceIds].sort(),
    bindingStatus: 'accepted',
    projectionStatus,
    payload: { fiscalYear: position.fiscalYear },
    canonicalWriteAllowed: false,
  };
  return { ok: true, projection };
}

export type StageActionProjectionRefusalReasonV1 =
  | 'no_single_native_identity'
  | 'incomplete_transfer_endpoint'
  | 'no_scope_present';

export interface StageActionProjectionRefusalV1 {
  reason: StageActionProjectionRefusalReasonV1;
  detail: string;
}

export type StageActionProjectionResultV1 =
  | { ok: true; projection: Phase6NativeProjectionV1 }
  | { ok: false; refusal: StageActionProjectionRefusalV1 };

/**
 * The action's `vehicleClass` is asserted rather than inferred: it is a
 * field `DefenseBudgetStageActionV1` already carries, and
 * `Phase6ActionVehicleClassV1` is the identical enum by a different name
 * (this module's own boundary — `phase6-action-scope-identity-v1.ts` does not
 * import the stage-action contract). A mismatch here means the two enums have
 * drifted, which a test in this module's spec asserts against.
 */
function toPhase6ActionVehicleClassV1(
  value: DefenseBudgetStageActionV1['vehicleClass'],
): Phase6ActionVehicleClassV1 {
  return value;
}

/**
 * `canonical_stage_action`'s mapping-registry entry carries no money axis
 * (Workstream J: "an action carries no funding field at all", enforced again
 * by `projectPhase6ProjectionsV1` refusing any `stage_action` that sets
 * `.money`). So the action's signed amount is preserved as plain-string
 * `payload` attributes, not as a typed `MoneyValueV1` — that is a structural
 * property of the destination, not data loss: it is exactly what stops an
 * action amount from being promotable as an absolute position.
 *
 * Phase 7 Gap 5 decision B3: an action with no single native `identity` is no
 * longer refused outright. `deriveActionScopeIdentityV1` recognizes the other
 * three shapes the action's own schema already validates — package scope,
 * account scope, and a two-sided transfer — and this function's
 * `nativeIdentityHash` becomes `phase6ActionScopeIdentityHashV1` of whichever
 * one applies. An action naming only one side of a transfer still refuses, by
 * name, because that is the one shape this pass genuinely cannot identify
 * without inferring the missing endpoint.
 */
export function buildStageActionProjectionV1(
  action: DefenseBudgetStageActionV1,
  provenance: Phase6ProjectionProvenanceV1,
  projectionStatus: Phase6NativeProjectionV1['projectionStatus'],
): StageActionProjectionResultV1 {
  let nativeIdentityHash: string;
  /** Recorded on the payload below so a reader can tell a scope-derived
   *  identity from a single native line without re-deriving it. */
  let identityScopeKind: 'NATIVE_LINE' | Phase6ActionScopeIdentityV1['kind'];
  if (action.identity != null) {
    nativeIdentityHash = nativeIdentityHashV1(action.identity);
    identityScopeKind = 'NATIVE_LINE';
  } else {
    const derived = deriveActionScopeIdentityV1({
      packageScope: action.packageScope,
      accountScope: action.accountScope,
      sourceIdentity: action.sourceIdentity,
      destinationIdentity: action.destinationIdentity,
      vehicleClass: toPhase6ActionVehicleClassV1(action.vehicleClass),
      fiscalYear: action.fiscalYear,
      stage: action.stage,
    });
    if (!derived.ok) {
      return { ok: false, refusal: { reason: derived.reason, detail: derived.detail } };
    }
    nativeIdentityHash = phase6ActionScopeIdentityHashV1(derived.identity);
    identityScopeKind = derived.identity.kind;
  }

  const naturalKey = naturalKeyV1([
    nativeIdentityHash,
    action.fiscalYear,
    action.stage,
    action.actionType,
    action.actionId,
  ]);
  const idempotencyKey = `phase6:${naturalKey}:${provenance.artifactId}`;

  const payload: Phase6NativeProjectionV1['payload'] = {
    fiscalYear: action.fiscalYear,
    actionType: action.actionType,
    actionKey: action.actionId,
    direction: action.direction,
    identityScopeKind,
  };
  if (action.signedValueMillions != null) payload.signedValueMillions = action.signedValueMillions;
  if (action.amount != null) {
    payload.originalValue = action.amount.originalValue;
    payload.originalUnit = action.amount.originalUnit;
  }
  if (action.baseline != null) payload.baselineValueMillions = action.baseline.valueMillions;
  if (action.after != null) payload.afterValueMillions = action.after.valueMillions;
  // `narrative` is a consumed payload key: projectPhase6ProjectionsV1 promotes
  // it to the typed `values.textValue` axis rather than a generic attribute.
  if (action.rationale != null) payload.narrative = action.rationale;

  const projection: Phase6NativeProjectionV1 = {
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: phase6ProjectionIdV1({ naturalKey, idempotencyKey }),
    naturalKey,
    idempotencyKey,
    projectionKind: 'stage_action',
    verificationCandidateId: provenance.verificationCandidateId,
    verificationRunId: provenance.verificationRunId,
    artifactId: provenance.artifactId,
    artifactContentSha256: provenance.artifactContentSha256,
    sourceDocumentId: provenance.sourceDocumentId,
    sourcePdfSha256: provenance.sourcePdfSha256,
    sourceProfileHash: provenance.sourceProfileHash,
    nativeIdentityHash,
    track: action.track,
    stage: action.stage,
    directOrDerived: action.directOrDerived,
    evidenceIds: [...action.evidenceIds].sort(),
    bindingStatus: 'accepted',
    projectionStatus,
    payload,
    canonicalWriteAllowed: false,
  };
  return { ok: true, projection };
}

/* ------------------------------------------------------------------ */
/* B1 — enacted positions (public_law / continuing_resolution)         */
/* ------------------------------------------------------------------ */

export type EnactedStagePositionProjectionRefusalReasonV1 =
  | 'candidate_not_accepted'
  | 'proof_fiscal_year_mismatch'
  | 'continuing_resolution_without_explicit_line_authority';

export interface EnactedStagePositionProjectionRefusalV1 {
  reason: EnactedStagePositionProjectionRefusalReasonV1;
  detail: string;
}

export type EnactedStagePositionProjectionResultV1 =
  | { ok: true; projection: Phase6NativeProjectionV1 }
  | { ok: false; refusal: EnactedStagePositionProjectionRefusalV1 };

/**
 * Phase 7 Gap 5 decision B1. Threads the existing `DefenseBudgetEnactmentProofV1`
 * through to a persisted `stage_position` projection for `public_law` /
 * `continuing_resolution` — the two stages `buildStagePositionProjectionV1`
 * has always refused with `stage_not_supported`, because that function is fed
 * only `emitStageRowsV1`'s row-emitter output and enacted lines never flow
 * through the row emitter.
 *
 * `EnactedLineCandidateV1` is the real input instead — the composer-facing
 * candidate type `enacted-composer-v1.ts` already validates each candidate
 * against the same proof before allowing it to contribute to enacted funding
 * (`assertCandidateAgainstProofV1`). This function performs the same two
 * checks that composer performs, so a candidate that would already fail
 * `composeEnactedStageV1` fails here identically rather than slipping through
 * a second, looser path into the projection.
 *
 * Deliberately NOT attempted here: how `EnactedLineCandidateV1` rows are
 * produced from real extraction in the first place. That is
 * `composeEnactedStageV1`'s own concern, upstream of this function, and
 * remains open — this function's contract is "given a real candidate and a
 * real proof, build the projection correctly," not "discover the candidate."
 *
 * The proof's identifying hashes and type are preserved on the payload, not
 * only its bare ID, because "thread the proof through" means a reader of the
 * persisted projection can see what governed it without a second lookup:
 * `publicLawNumber`, `enactmentProofType`, and both source SHAs travel with
 * the row.
 */
export function buildEnactedStagePositionProjectionV1(
  candidate: EnactedLineCandidateV1,
  stage: Extract<StageV1, 'public_law' | 'continuing_resolution'>,
  proof: DefenseBudgetEnactmentProofV1,
  provenance: Phase6ProjectionProvenanceV1,
  projectionStatus: Phase6NativeProjectionV1['projectionStatus'],
): EnactedStagePositionProjectionResultV1 {
  // Mirrors assertCandidateAgainstProofV1: only an accepted candidate can
  // create enacted funding. A candidate/unresolved/conflicting binding status
  // is a Gap-1-shaped refusal for this row, not a promotable enacted value.
  if (candidate.bindingStatus !== 'accepted') {
    return {
      ok: false,
      refusal: {
        reason: 'candidate_not_accepted',
        detail: `candidate ${candidate.candidateId} has binding status "${candidate.bindingStatus}", not "accepted"; it cannot create enacted funding`,
      },
    };
  }
  if (proof.fiscalYear !== candidate.fiscalYear) {
    return {
      ok: false,
      refusal: {
        reason: 'proof_fiscal_year_mismatch',
        detail: `proof fiscal year ${proof.fiscalYear} does not match candidate ${candidate.candidateId}'s fiscal year ${candidate.fiscalYear}`,
      },
    };
  }
  // Matches phase6NativeProjectionV1Schema's own superRefine, which refuses a
  // continuing-resolution stage_position with payload.explicitLineAuthority
  // !== true. Checked here too so the refusal names the real cause instead of
  // surfacing as an opaque ZodError from the projection's own parse.
  if (stage === 'continuing_resolution' && proof.explicitLineAuthority !== true) {
    return {
      ok: false,
      refusal: {
        reason: 'continuing_resolution_without_explicit_line_authority',
        detail:
          'a continuing resolution cannot become a line-level enacted position without ' +
          'explicit line authority on its proof',
      },
    };
  }

  const nativeIdentityHash = nativeIdentityHashV1(candidate.identity);
  const naturalKey = naturalKeyV1([nativeIdentityHash, candidate.fiscalYear, stage, 'enacted']);
  const idempotencyKey = `phase6:${naturalKey}:${provenance.artifactId}`;

  const payload: Phase6NativeProjectionV1['payload'] = {
    fiscalYear: candidate.fiscalYear,
    publicLawNumber: proof.publicLawNumber,
    enactmentProofType: proof.proofType,
    publicLawSourceSha256: proof.publicLawSource.sourceSha256,
    lineDetailSourceSha256: proof.lineDetailSource.sourceSha256,
    ...(stage === 'continuing_resolution' ? { explicitLineAuthority: true } : {}),
  };

  const projection: Phase6NativeProjectionV1 = {
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: phase6ProjectionIdV1({ naturalKey, idempotencyKey }),
    naturalKey,
    idempotencyKey,
    projectionKind: 'stage_position',
    verificationCandidateId: provenance.verificationCandidateId,
    verificationRunId: provenance.verificationRunId,
    artifactId: provenance.artifactId,
    artifactContentSha256: provenance.artifactContentSha256,
    sourceDocumentId: provenance.sourceDocumentId,
    sourcePdfSha256: provenance.sourcePdfSha256,
    sourceProfileHash: provenance.sourceProfileHash,
    nativeIdentityHash,
    track: STAGE_TRACK[stage],
    stage,
    fundingField: 'enacted',
    money: candidate.money,
    directOrDerived: 'direct',
    evidenceIds: [...candidate.evidenceIds].sort(),
    bindingStatus: 'accepted',
    projectionStatus,
    enactmentProofId: proof.proofId,
    payload,
    canonicalWriteAllowed: false,
  };
  return { ok: true, projection };
}

/* ------------------------------------------------------------------ */
/* B2 — execution positions                                            */
/* ------------------------------------------------------------------ */

export type ExecutionStagePositionProjectionRefusalReasonV1 = 'no_executed_position';

export interface ExecutionStagePositionProjectionRefusalV1 {
  reason: ExecutionStagePositionProjectionRefusalReasonV1;
  detail: string;
}

export type ExecutionStagePositionProjectionResultV1 =
  | { ok: true; projection: Phase6NativeProjectionV1 }
  | { ok: false; refusal: ExecutionStagePositionProjectionRefusalV1 };

/**
 * Phase 7 Gap 5 decision B2. Threads the existing execution metric / as-of-date
 * / cumulative fields through — no new vocabulary, no new decision.
 * `composeExecutionRecordV1` already builds `executedPosition` with exactly
 * these fields whenever its source profile says the record maps to the
 * `executed` funding field; this function's whole job is carrying that object,
 * plus the underlying record's evidence, into a `Phase6NativeProjectionV1` the
 * same way every other stage does.
 *
 * Takes the whole `ExecutionCompositionV1` rather than just `executedPosition`
 * so `record.evidenceIds` — required and non-empty on `ExecutionRecordV1`, but
 * absent from the narrower `executedPosition` shape — travels with it. A
 * caller whose composition has no `executedPosition` has nothing to project
 * and gets `no_executed_position`, not a silently empty projection.
 *
 * `phase6NativeProjectionV1Schema`'s own superRefine already refuses an
 * execution `stage_position` missing `payload.executionMetric` /
 * `payload.asOfDate` / `payload.cumulative` — this function cannot construct a
 * projection missing them in the first place, since `executedPosition`'s own
 * type requires all three. That schema check is defense-in-depth for a
 * hand-built payload elsewhere, not a gap this function has to work around.
 */
export function buildExecutionStagePositionProjectionV1(
  composition: ExecutionCompositionV1,
  provenance: Phase6ProjectionProvenanceV1,
  projectionStatus: Phase6NativeProjectionV1['projectionStatus'],
): ExecutionStagePositionProjectionResultV1 {
  const { executedPosition } = composition;
  if (executedPosition == null) {
    return {
      ok: false,
      refusal: {
        reason: 'no_executed_position',
        detail:
          'this execution record does not map to the executed funding field for this source ' +
          'profile; there is nothing to project',
      },
    };
  }

  const nativeIdentityHash = nativeIdentityHashV1(executedPosition.identity);
  const naturalKey = naturalKeyV1([
    nativeIdentityHash,
    executedPosition.fiscalYear,
    'execution',
    executedPosition.field,
  ]);
  const idempotencyKey = `phase6:${naturalKey}:${provenance.artifactId}`;

  const projection: Phase6NativeProjectionV1 = {
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: phase6ProjectionIdV1({ naturalKey, idempotencyKey }),
    naturalKey,
    idempotencyKey,
    projectionKind: 'stage_position',
    verificationCandidateId: provenance.verificationCandidateId,
    verificationRunId: provenance.verificationRunId,
    artifactId: provenance.artifactId,
    artifactContentSha256: provenance.artifactContentSha256,
    sourceDocumentId: provenance.sourceDocumentId,
    sourcePdfSha256: provenance.sourcePdfSha256,
    sourceProfileHash: provenance.sourceProfileHash,
    nativeIdentityHash,
    track: STAGE_TRACK.execution,
    stage: 'execution',
    fundingField: executedPosition.field,
    money: executedPosition.money,
    directOrDerived: 'direct',
    evidenceIds: [...composition.record.evidenceIds].sort(),
    bindingStatus: 'accepted',
    projectionStatus,
    payload: {
      fiscalYear: executedPosition.fiscalYear,
      executionMetric: executedPosition.metric,
      asOfDate: executedPosition.asOfDate,
      cumulative: executedPosition.cumulative,
    },
    canonicalWriteAllowed: false,
  };
  return { ok: true, projection };
}
