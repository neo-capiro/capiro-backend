/**
 * Phase 7 Gap 5 decisions A1-A3 — the Phase 6 projection-plan document, the
 * piece that let every other family file through
 * `persist-defense-budget-projection-plan-v1` while `committee` could not.
 *
 * Pure and read-only, matching decision A4's architecture: this module reads
 * nothing from a database. Its caller (a script, not this file) loads
 * `Phase6NativeProjectionV1` rows and passes them in; this module turns them
 * into the same structural shape `projection-plan-record-v1.ts`'s reader
 * already understands for every other family — `schemaVersion`, `cycleId`,
 * `fiscalYear`, `contentSha256`, `candidates[].operation` /
 * `.exclusionReason` / `.artifactContentSha256`.
 *
 * ---------------------------------------------------------------------------
 * A1 — one candidate boundary
 * ---------------------------------------------------------------------------
 *
 * One normalized `phase6_audit_projection` row is one candidate — never a
 * document, a committee, a family, a verification candidate, or a whole
 * cycle. That is the smallest unit that can independently be included,
 * excluded, or blocked, and it is already how every other Phase 6 consumer
 * (the promotion projection source, the eligibility read repository) treats
 * these rows.
 *
 * `superseded` rows are read but never become their own candidate: a
 * superseded row is not a competing fact about its natural key, it is a
 * historical one whose successor already represents current truth, and
 * including both would corrupt the same-natural-key duplicate analysis below.
 *
 * ---------------------------------------------------------------------------
 * A2 — what `operation` means here
 * ---------------------------------------------------------------------------
 *
 * Phase 6 does not diff against canonical rows — that is Phase 7's job, after
 * loading this immutable plan and applying the mapping registry. `operation`
 * on a Phase 6 candidate is the PRODUCER's own disposition, not a canonical
 * database operation:
 *
 *   insert   = fully bound, verified/certified, non-conflicting; hand this to
 *              Phase 7 for its own canonical-operation decision.
 *   no_op    = intentionally not promotable, retained for completeness with an
 *              explicit exclusionReason.
 *   conflict = two or more facts cannot resolve to one unambiguous projection.
 *   update   = UNUSED in this schema version. Nothing here ever emits it —
 *              Phase 6 has no producer-local prior-plan comparison to base an
 *              `update` on. A future schema version may define one; this one
 *              does not, on purpose, rather than emitting `update` because the
 *              enum happens to contain it.
 *
 * `insert` here is not a promise the row becomes a canonical INSERT. Phase 7
 * still determines INSERT / SUPERSEDE / UNCHANGED / CORRECTION / BLOCKED for
 * itself from the mapping registry and the active snapshot. That distinction
 * lives here, next to the mapping, so nobody downstream reads a Phase 6
 * `insert` as a canonical mutation.
 *
 * ---------------------------------------------------------------------------
 * A3 — bindingStatus / projectionStatus -> operation + exclusionReason
 * ---------------------------------------------------------------------------
 *
 * `projectionStatus` is checked first, because `candidate` and `blocked` are
 * producer-level states that pre-empt any binding question:
 *
 *   projectionStatus 'blocked'   -> no_op / phase6_projection_blocked
 *   projectionStatus 'candidate' -> no_op / artifact_needs_review (reusing the
 *                                   existing RDTE/non-RDTE reason for "not yet
 *                                   verified", per A3's instruction to prefer
 *                                   a precise existing reason over a new one)
 *   projectionStatus 'verified'  -> mapped from bindingStatus:
 *     accepted        -> insert / (none)
 *     candidate        -> no_op / unresolved_binding
 *     unresolved       -> no_op / unresolved_binding
 *     conflicting      -> conflict / binding_conflict
 *     not_applicable   -> no_op / unsupported_projection
 *
 * Same-natural-key duplicates are resolved exactly the way
 * `rdte-projection-planner-v1.ts`'s `dedupeCandidates` already resolves them —
 * mirrored deliberately, per A4's "existing composition policy" reference,
 * not reinvented:
 *
 *   - a group of size 1 maps straight through the table above;
 *   - same natural key + byte-identical normalized content (money + payload)
 *     collapses into ONE candidate, merging evidence, using the most-resolved
 *     member's mapping;
 *   - same natural key + differing content means every member of the group
 *     becomes its own `conflict` / `binding_conflict` candidate — never
 *     last-wins, and never silently dropped.
 *
 * Artifact binding follows A1's rule: a single-row candidate binds to that
 * row's own `artifactContentSha256`; a collapsed multi-artifact duplicate
 * binds to the deterministic hash of the sorted set of contributing artifact
 * hashes (the same `artifactSetSha256` computation
 * `projection-plan-record-v1.ts`'s own summary already performs), never to one
 * arbitrarily chosen constituent.
 */
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import type { Phase6NativeProjectionV1 } from './phase6-native-projection-v1.js';

export const PHASE6_PROJECTION_PLAN_SCHEMA_VERSION = 'phase6_committee_projection_plan_v1' as const;

export type Phase6PlanOperationV1 = 'insert' | 'no_op' | 'conflict';

export interface Phase6PlanCandidateV1 {
  operation: Phase6PlanOperationV1;
  exclusionReason?: string;
  artifactContentSha256: string;
  /** Every row this candidate represents — one, unless a same-content
   *  duplicate group collapsed into it. Lets a reader reconstruct the exact
   *  audit projection row(s) and their proof binding without a second query. */
  sourceProjectionIds: string[];
  naturalKey: string;
  projectionKind: Phase6NativeProjectionV1['projectionKind'];
  nativeIdentityHash: string;
  verificationCandidateId: string;
  verificationRunId: string;
  sourceDocumentId: string;
  sourcePdfSha256: string;
  enactmentProofId?: string;
}

export interface Phase6ProjectionPlanDocumentV1 {
  schemaVersion: typeof PHASE6_PROJECTION_PLAN_SCHEMA_VERSION;
  cycleId: string;
  fiscalYear: number;
  candidates: Phase6PlanCandidateV1[];
  contentSha256: string;
}

function sortedUniqueHashSetV1(hashes: readonly string[]): string {
  return sha256CanonicalJson(
    [...new Set(hashes)].sort((a, b) => a.localeCompare(b)) as unknown as JsonValue,
  );
}

/** Deep-enough equality for money + payload: both are plain records of
 *  primitive values, so key/value comparison is exact. */
function contentEqualV1(a: Phase6NativeProjectionV1, b: Phase6NativeProjectionV1): boolean {
  const moneyEqual = JSON.stringify(a.money ?? null) === JSON.stringify(b.money ?? null);
  const payloadEqual = JSON.stringify(a.payload) === JSON.stringify(b.payload);
  return moneyEqual && payloadEqual && a.fundingField === b.fundingField;
}

function mapVerifiedRowV1(row: Phase6NativeProjectionV1): {
  operation: Phase6PlanOperationV1;
  exclusionReason?: string;
} {
  switch (row.bindingStatus) {
    case 'accepted':
      return { operation: 'insert' };
    case 'candidate':
    case 'unresolved':
      return { operation: 'no_op', exclusionReason: 'unresolved_binding' };
    case 'conflicting':
      return { operation: 'conflict', exclusionReason: 'binding_conflict' };
    case 'not_applicable':
      return { operation: 'no_op', exclusionReason: 'unsupported_projection' };
  }
}

/** A3's producer-level dispatch, checked before the bindingStatus table. */
function mapRowV1(row: Phase6NativeProjectionV1): {
  operation: Phase6PlanOperationV1;
  exclusionReason?: string;
} {
  if (row.projectionStatus === 'blocked') {
    return { operation: 'no_op', exclusionReason: 'phase6_projection_blocked' };
  }
  if (row.projectionStatus === 'candidate') {
    return { operation: 'no_op', exclusionReason: 'artifact_needs_review' };
  }
  return mapVerifiedRowV1(row);
}

function toCandidateV1(row: Phase6NativeProjectionV1): Phase6PlanCandidateV1 {
  const { operation, exclusionReason } = mapRowV1(row);
  return {
    operation,
    ...(exclusionReason != null ? { exclusionReason } : {}),
    artifactContentSha256: row.artifactContentSha256,
    sourceProjectionIds: [row.projectionId],
    naturalKey: row.naturalKey,
    projectionKind: row.projectionKind,
    nativeIdentityHash: row.nativeIdentityHash,
    verificationCandidateId: row.verificationCandidateId,
    verificationRunId: row.verificationRunId,
    sourceDocumentId: row.sourceDocumentId,
    sourcePdfSha256: row.sourcePdfSha256,
    ...(row.enactmentProofId != null ? { enactmentProofId: row.enactmentProofId } : {}),
  };
}

/**
 * Collapse or split one natural-key group into its final candidate(s),
 * mirroring `rdte-projection-planner-v1.ts`'s `dedupeCandidates`: identical
 * content collapses to one candidate; differing content becomes a `conflict`
 * candidate per member, never last-wins.
 */
function resolveGroupV1(group: Phase6NativeProjectionV1[]): Phase6PlanCandidateV1[] {
  const only = group[0];
  if (only == null) return [];
  if (group.length === 1) return [toCandidateV1(only)];

  const sorted = [...group].sort((a, b) => a.projectionId.localeCompare(b.projectionId));
  const first = sorted[0]!;
  const allEqual = sorted.every((row) => contentEqualV1(row, first));

  if (allEqual) {
    // Prefer the most-resolved member's mapping: an 'accepted'/'verified' row
    // in the group should win over a 'candidate'/'unresolved' duplicate of the
    // exact same content, since they agree on the fact and one of them has
    // already been resolved.
    const resolved =
      sorted.find(
        (row) => row.projectionStatus === 'verified' && row.bindingStatus === 'accepted',
      ) ?? first;
    const { operation, exclusionReason } = mapRowV1(resolved);
    const artifactHashes = sorted.map((row) => row.artifactContentSha256);
    return [
      {
        operation,
        ...(exclusionReason != null ? { exclusionReason } : {}),
        artifactContentSha256:
          new Set(artifactHashes).size === 1
            ? artifactHashes[0]!
            : sortedUniqueHashSetV1(artifactHashes),
        sourceProjectionIds: sorted
          .map((row) => row.projectionId)
          .sort((a, b) => a.localeCompare(b)),
        naturalKey: resolved.naturalKey,
        projectionKind: resolved.projectionKind,
        nativeIdentityHash: resolved.nativeIdentityHash,
        verificationCandidateId: resolved.verificationCandidateId,
        verificationRunId: resolved.verificationRunId,
        sourceDocumentId: resolved.sourceDocumentId,
        sourcePdfSha256: resolved.sourcePdfSha256,
        ...(resolved.enactmentProofId != null
          ? { enactmentProofId: resolved.enactmentProofId }
          : {}),
      },
    ];
  }

  // Genuine disagreement: every member becomes its own conflict candidate.
  // Never last-wins, never dropped.
  return sorted.map((row) => ({
    ...toCandidateV1(row),
    operation: 'conflict' as const,
    exclusionReason: 'binding_conflict',
  }));
}

/**
 * Build the Phase 6 committee-family projection-plan document from already-
 * loaded native projection rows. `rows` should already be scoped to the
 * cycle/fiscal-year the caller intends to file a plan for — this function does
 * not filter by them, it only records them on the resulting document.
 */
export function buildPhase6ProjectionPlanDocumentV1(input: {
  cycleId: string;
  fiscalYear: number;
  rows: readonly Phase6NativeProjectionV1[];
}): Phase6ProjectionPlanDocumentV1 {
  const live = input.rows.filter((row) => row.projectionStatus !== 'superseded');

  const groups = new Map<string, Phase6NativeProjectionV1[]>();
  for (const row of live) {
    const group = groups.get(row.naturalKey) ?? [];
    group.push(row);
    groups.set(row.naturalKey, group);
  }

  const candidates = [...groups.values()]
    .flatMap(resolveGroupV1)
    .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));

  const withoutHash: Omit<Phase6ProjectionPlanDocumentV1, 'contentSha256'> = {
    schemaVersion: PHASE6_PROJECTION_PLAN_SCHEMA_VERSION,
    cycleId: input.cycleId,
    fiscalYear: input.fiscalYear,
    candidates,
  };
  return {
    ...withoutHash,
    contentSha256: sha256CanonicalJson(withoutHash as unknown as JsonValue),
  };
}
