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
 * Scope: what this closes, and what it deliberately does not
 * ---------------------------------------------------------------------------
 *
 * Covered: `stage_position` from `emitStageRowsV1`'s output — HASC, SASC,
 * HAC-D, SAC-D, NDAA conference, and appropriations conference — and
 * `stage_action` for identity-scoped actions (one native line, not a
 * package/account scope or a transfer pair).
 *
 * That is deliberately not the full seven-kind surface. Left for a follow-up
 * pass, with the specific reason each needs its own design rather than a
 * shared shortcut:
 *
 *   - `public_law` / `continuing_resolution` positions (the `enacted` field):
 *     require linking an `EnactmentProofV1` (`stages/enacted/`), which this
 *     module never receives. Building it here would mean either fabricating
 *     proof linkage or promoting an enacted value with none — both are
 *     exactly what the plan's enactment-proof invariant forbids.
 *   - `reprogramming` / `execution` positions: their source modules
 *     (`stages/post-enactment/reprogramming-execution-v1.ts`) have a
 *     different output shape this module has not read; `execution` also
 *     needs a metric/as-of-date/cumulative decision this module cannot make
 *     from a `StagePositionV1` alone.
 *   - package-scope, account-scope, and transfer-pair actions: they have no
 *     single native identity, so `nativeIdentityHash` — which every
 *     `canonical_stage_action` natural key leads with — has no defined value
 *     for them yet. Inventing a package/account pseudo-key under time
 *     pressure is the kind of decision the plan repeatedly says to stop and
 *     report rather than guess at.
 *   - `vehicle_proof`, `native_line_binding`, `provision_link`,
 *     `enactment_proof`: not attempted this pass.
 *
 * Every one of those refuses explicitly (see the `*RefusalV1` result arm)
 * rather than being silently dropped — consistent with invariant 11
 * ("no unsupported item is silently dropped") even though these are refused
 * one layer upstream of the promotion planner itself.
 */
import { moneyToMillionsString } from '../contracts/decimal-string.js';
import type { MoneyUnitV1, MoneyValueV1 } from '../contracts/extraction-artifact-v1.js';
import type { DefenseBudgetStageActionV1 } from '../stages/appropriations/actions/defense-budget-stage-action-v1.js';
import { nativeIdentityHashV1 } from '../stages/budget-line-reference-v1.js';
import type { StagePositionV1 } from '../stages/stage-row-emitter-v1.js';
import { STAGE_TRACK, type StageV1 } from '../stages/stage-vocabulary-v1.js';
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

export type StageActionProjectionRefusalReasonV1 = 'no_single_native_identity';

export interface StageActionProjectionRefusalV1 {
  reason: StageActionProjectionRefusalReasonV1;
  detail: string;
}

export type StageActionProjectionResultV1 =
  | { ok: true; projection: Phase6NativeProjectionV1 }
  | { ok: false; refusal: StageActionProjectionRefusalV1 };

/**
 * `canonical_stage_action`'s mapping-registry entry carries no money axis
 * (Workstream J: "an action carries no funding field at all", enforced again
 * by `projectPhase6ProjectionsV1` refusing any `stage_action` that sets
 * `.money`). So the action's signed amount is preserved as plain-string
 * `payload` attributes, not as a typed `MoneyValueV1` — that is a structural
 * property of the destination, not data loss: it is exactly what stops an
 * action amount from being promotable as an absolute position.
 */
export function buildStageActionProjectionV1(
  action: DefenseBudgetStageActionV1,
  provenance: Phase6ProjectionProvenanceV1,
  projectionStatus: Phase6NativeProjectionV1['projectionStatus'],
): StageActionProjectionResultV1 {
  if (action.identity == null) {
    return {
      ok: false,
      refusal: {
        reason: 'no_single_native_identity',
        detail:
          'this pass only projects identity-scoped actions; package/account-scoped and transfer-pair actions need their own scope-key convention (Gap 1 remaining work)',
      },
    };
  }

  const nativeIdentityHash = nativeIdentityHashV1(action.identity);
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
