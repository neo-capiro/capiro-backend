/**
 * Phase 7 Workstream C — `defense_budget_promotion_plan_v1`.
 *
 * A pure, read-only statement of exactly what a promotion would do: every row
 * it would insert, supersede, leave alone, correct, or refuse, with the hashes
 * an executor must reproduce.
 *
 * Three properties make the plan usable as an authorization subject:
 *
 * 1. **It writes nothing.** The planner takes the current active snapshot's
 *    rows as an input value, not as a database handle. There is no Prisma
 *    import in this module and an architecture test enforces that, so planning
 *    can run under ordinary application read credentials with no access to the
 *    promoter role.
 * 2. **It is deterministic.** Items are sorted by canonical entity, natural
 *    key, and source projection before hashing, so the same facts presented in
 *    any order produce a byte-identical plan hash. That is what lets an
 *    authorization bind to a plan by hash.
 * 3. **It refuses rather than resolves.** Duplicate keys, conflicting values,
 *    drifted rows, missing parents, unsupported mappings, candidate identity
 *    bindings, enacted positions with no proof, and collisions with a live
 *    manual override are all recorded as `BLOCKED` items. Nothing is dropped
 *    and nothing is decided by last-write-wins.
 *
 * Money never becomes a `number` here. Values arrive as canonical decimal
 * strings and are compared as strings through the canonical serializer, so
 * "1.10" and "1.1" are distinguishable and no comparison rounds.
 */
import { z } from 'zod';
import {
  sha256CanonicalJson,
  stripUndefinedProperties,
  type JsonValue,
} from '../contracts/canonical-json.js';
import {
  type BudgetFamilyV1,
  type FundingFieldV1,
  type MoneyUnitV1,
} from '../contracts/extraction-artifact-v1.js';
import type { StageAuthorityV1 } from '../stages/stage-vocabulary-v1.js';
import {
  DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
  lookupCanonicalMappingV1,
  parentEntityOfV1,
  validateFundingFieldForMappingV1,
  type CanonicalEntityV1,
  type CanonicalMappingEntryV1,
  type CompatibilityModeV1,
} from './canonical-mapping-registry-v1.js';
import type { PromotionScopeV1 } from './promotion-eligibility-v1.js';

export const DEFENSE_BUDGET_PROMOTION_PLAN_SCHEMA_VERSION =
  'defense_budget_promotion_plan_v1' as const;

/* ------------------------------------------------------------------ */
/* C1. Vocabulary                                                      */
/* ------------------------------------------------------------------ */

export const PROMOTION_OPERATION_V1_VALUES = [
  'INSERT',
  'SUPERSEDE',
  'UNCHANGED',
  'CORRECTION',
  'BLOCKED',
] as const;
export const promotionOperationV1Schema = z.enum(PROMOTION_OPERATION_V1_VALUES);
export type PromotionOperationV1 = z.infer<typeof promotionOperationV1Schema>;

/**
 * Why this promotion is running. The mode is an input, not an inference: an
 * operator states that a run is a baseline hydration or a correction, and the
 * plan's alert behaviour follows from that declaration rather than from a
 * heuristic about how many rows changed.
 */
export const PROMOTION_MODE_V1_VALUES = [
  'baseline_hydration',
  'new_cycle',
  'correction',
  'rollback',
] as const;
export const promotionModeV1Schema = z.enum(PROMOTION_MODE_V1_VALUES);
export type PromotionModeV1 = z.infer<typeof promotionModeV1Schema>;

/**
 * What this item is permitted to do downstream. Every value except `eligible`
 * means no client alert can be produced, and each names *why* so an operator
 * can tell a deliberately quiet hydration from an entity that never alerts.
 */
export const ALERT_DISPOSITION_V1_VALUES = [
  'eligible',
  'none',
  'suppressed_hydration',
  'suppressed_correction',
  'suppressed_rollback',
  'suppressed_not_alertable',
] as const;
export const alertDispositionV1Schema = z.enum(ALERT_DISPOSITION_V1_VALUES);
export type AlertDispositionV1 = z.infer<typeof alertDispositionV1Schema>;

export const PLAN_BLOCK_REASON_V1_VALUES = [
  'unsupported_mapping',
  'duplicate_natural_key',
  'conflicting_duplicate_values',
  'active_row_drift',
  'missing_dependency_row',
  'manual_override_collision',
  'candidate_identity_link',
  'missing_enactment_proof',
  'field_authority_violation',
] as const;
export const planBlockReasonV1Schema = z.enum(PLAN_BLOCK_REASON_V1_VALUES);
export type PlanBlockReasonV1 = z.infer<typeof planBlockReasonV1Schema>;

/* ------------------------------------------------------------------ */
/* C2. Inputs                                                          */
/* ------------------------------------------------------------------ */

/** Exact money, as three strings. Never a number. */
export interface CanonicalMoneyV1 {
  originalValue: string;
  originalUnit: MoneyUnitV1;
  valueMillions: string;
}

/**
 * The typed value axes a canonical row may carry. Every numeric axis is a
 * canonical decimal string; `quantity` and `unitCostDollars` are separate from
 * `money` so a count can never be summed as dollars.
 */
export interface CanonicalRowValuesV1 {
  money?: CanonicalMoneyV1 | null;
  quantity?: string | null;
  unitCostDollars?: string | null;
  textValue?: string | null;
  dateValue?: string | null;
  attributes?: Record<string, string | boolean | null>;
}

/** Provenance copied verbatim from the upstream projection. */
export interface CanonicalLineageV1 {
  sourceAssertionId: string;
  evidenceIds: string[];
  artifactId: string;
  artifactContentSha256: string;
  verificationCandidateId: string;
  verificationRunId: string;
  sourceDocumentId: string;
  sourcePdfSha256: string;
}

/** One verified projection offered for promotion. */
export interface PromotionProjectionInputV1 {
  projectionId: string;
  projectionHash: string;
  /** Namespaced mapping-registry key, e.g. `non_rdte:OmSagYear`. */
  projectionKind: string;
  naturalKey: string;
  /** Natural key of the structural parent, when the destination has one. */
  parentNaturalKey?: string | null;
  fiscalYear?: number | null;
  fundingField?: FundingFieldV1 | null;
  stageAuthority?: StageAuthorityV1 | null;
  bindingStatus?: 'accepted' | 'candidate' | 'unresolved' | 'conflicting' | 'not_applicable';
  enactmentProofId?: string | null;
  directOrDerived: 'direct' | 'derived' | 'not_applicable';
  values: CanonicalRowValuesV1;
  lineage: CanonicalLineageV1;
}

/** A row already present in the active snapshot. Supplied read-only. */
export interface PriorCanonicalRowV1 {
  canonicalEntity: CanonicalEntityV1;
  naturalKey: string;
  rowHash: string;
  snapshotId: string;
}

/** A governed human override that a new snapshot must not silently overwrite. */
export interface ManualOverlayV1 {
  canonicalEntity: CanonicalEntityV1;
  naturalKey: string;
  fiscalYear?: number | null;
  fundingField?: FundingFieldV1 | null;
  status: 'active' | 'expired' | 'revoked';
}

export interface PromotionPlanInputV1 {
  planId: string;
  eligibilityHash: string;
  scope: PromotionScopeV1;
  mode: PromotionModeV1;
  proposedSnapshotId: string;
  /** What eligibility expected to be active. */
  expectedActiveSnapshotId: string | null;
  /** What is actually active right now, read read-only. */
  actualActiveSnapshotId: string | null;
  mappingRegistryHash: string;
  projections: PromotionProjectionInputV1[];
  priorRows?: PriorCanonicalRowV1[];
  overlays?: ManualOverlayV1[];
}

/* ------------------------------------------------------------------ */
/* C3. Plan shape                                                      */
/* ------------------------------------------------------------------ */

export interface PromotionPlanItemV1 {
  sourceProjectionId: string;
  sourceProjectionHash: string;
  projectionKind: string;
  canonicalEntity: CanonicalEntityV1 | null;
  canonicalNaturalKey: string;
  family: BudgetFamilyV1 | null;
  fiscalYear: number | null;
  fundingField: FundingFieldV1 | null;
  operation: PromotionOperationV1;
  priorRowHash: string | null;
  proposedRowHash: string | null;
  reason: string;
  blockReason: PlanBlockReasonV1 | null;
  alertDisposition: AlertDispositionV1;
  compatibilityEffect: CompatibilityModeV1 | null;
}

export interface PromotionPlanCountsV1 {
  total: number;
  insert: number;
  supersede: number;
  unchanged: number;
  correction: number;
  blocked: number;
  alertEligible: number;
}

export interface PromotionPlanDiffBucketV1 {
  key: string;
  insert: number;
  supersede: number;
  unchanged: number;
  correction: number;
  blocked: number;
}

export interface DefenseBudgetPromotionPlanV1 {
  schemaVersion: typeof DEFENSE_BUDGET_PROMOTION_PLAN_SCHEMA_VERSION;
  planId: string;
  mappingRegistryVersion: string;
  mappingRegistryHash: string;
  eligibilityHash: string;
  scope: PromotionScopeV1;
  mode: PromotionModeV1;
  expectedActiveSnapshotId: string | null;
  proposedSnapshotId: string;
  items: PromotionPlanItemV1[];
  counts: PromotionPlanCountsV1;
  diffsByFamily: PromotionPlanDiffBucketV1[];
  diffsByEntity: PromotionPlanDiffBucketV1[];
  diffsByFiscalYear: PromotionPlanDiffBucketV1[];
  diffsByFundingField: PromotionPlanDiffBucketV1[];
  blockReasonCounts: { reason: PlanBlockReasonV1; count: number }[];
  /** True when any item is blocked. A blocked plan may not be authorized. */
  blocked: boolean;
  planHash: string;
}

/* ------------------------------------------------------------------ */
/* C4. Row hashing                                                     */
/* ------------------------------------------------------------------ */

const rowKey = (entity: CanonicalEntityV1, naturalKey: string): string => `${entity} ${naturalKey}`;

/**
 * Deterministic hash of the canonical row a projection proposes.
 *
 * Only the fields that constitute canonical truth participate: identity, the
 * typed value axes, and the fiscal-year/funding-field coordinates. Lineage is
 * deliberately excluded — two projections that carry the same value from two
 * different pages are the same canonical row, and including their evidence IDs
 * would make an `UNCHANGED` row look changed on every re-extraction.
 */
export function proposedRowHashV1(input: {
  canonicalEntity: CanonicalEntityV1;
  naturalKey: string;
  fiscalYear: number | null;
  fundingField: FundingFieldV1 | null;
  values: CanonicalRowValuesV1;
}): string {
  const attributes = input.values.attributes ?? {};
  const sortedAttributes: Record<string, string | boolean | null> = {};
  for (const key of Object.keys(attributes).sort((a, b) => a.localeCompare(b))) {
    const value = attributes[key];
    if (value === undefined) continue;
    sortedAttributes[key] = value;
  }

  return sha256CanonicalJson(
    stripUndefinedProperties({
      canonicalEntity: input.canonicalEntity,
      naturalKey: input.naturalKey,
      fiscalYear: input.fiscalYear,
      fundingField: input.fundingField,
      money: input.values.money ?? null,
      quantity: input.values.quantity ?? null,
      unitCostDollars: input.values.unitCostDollars ?? null,
      textValue: input.values.textValue ?? null,
      dateValue: input.values.dateValue ?? null,
      attributes: sortedAttributes,
    }) as unknown as JsonValue,
  );
}

/* ------------------------------------------------------------------ */
/* C5. Planner                                                         */
/* ------------------------------------------------------------------ */

interface StagedItem {
  input: PromotionProjectionInputV1;
  entry: CanonicalMappingEntryV1 | null;
  entity: CanonicalEntityV1 | null;
  proposedRowHash: string | null;
  block: { reason: PlanBlockReasonV1; detail: string } | null;
}

/**
 * Build the promotion plan.
 *
 * Pure: the same input value always produces the same plan, including the
 * hash. Nothing here reads a clock, a random source, or a database.
 */
export function buildPromotionPlanV1(input: PromotionPlanInputV1): DefenseBudgetPromotionPlanV1 {
  const priorRows = input.priorRows ?? [];
  const overlays = input.overlays ?? [];

  const priorByKey = new Map<string, PriorCanonicalRowV1>();
  for (const row of priorRows) priorByKey.set(rowKey(row.canonicalEntity, row.naturalKey), row);

  /* Whole-plan drift: eligibility expected a different snapshot to be active
   * than the one actually active. Every item is blocked, because the diff was
   * computed against rows that are no longer current. */
  const snapshotDrift = input.expectedActiveSnapshotId !== input.actualActiveSnapshotId;

  /* ---- Stage 1: resolve mapping, validate, compute proposed hashes ---- */

  const staged: StagedItem[] = input.projections.map((projection) => {
    const lookup = lookupCanonicalMappingV1(projection.projectionKind);
    if (!lookup.supported) {
      return {
        input: projection,
        entry: null,
        entity: null,
        proposedRowHash: null,
        block: { reason: 'unsupported_mapping', detail: lookup.detail },
      };
    }

    const entry = lookup.entry;
    const entity = entry.canonicalEntity;
    const fiscalYear = projection.fiscalYear ?? null;
    const fundingField = projection.fundingField ?? null;

    const fieldCheck = validateFundingFieldForMappingV1(
      entry,
      fundingField,
      projection.stageAuthority ?? undefined,
    );
    if (!fieldCheck.supported) {
      return {
        input: projection,
        entry,
        entity,
        proposedRowHash: null,
        block: { reason: 'field_authority_violation', detail: fieldCheck.detail },
      };
    }

    const binding = projection.bindingStatus ?? 'not_applicable';
    if (binding === 'candidate' || binding === 'conflicting' || binding === 'unresolved') {
      return {
        input: projection,
        entry,
        entity,
        proposedRowHash: null,
        block: {
          reason: 'candidate_identity_link',
          detail: `binding status "${binding}" is not canonical; only accepted bindings may be promoted`,
        },
      };
    }

    if (
      entry.requiresEnactmentProof &&
      fundingField === 'enacted' &&
      (projection.enactmentProofId == null || projection.enactmentProofId === '')
    ) {
      return {
        input: projection,
        entry,
        entity,
        proposedRowHash: null,
        block: {
          reason: 'missing_enactment_proof',
          detail: 'an enacted position requires its enactment proof',
        },
      };
    }

    return {
      input: projection,
      entry,
      entity,
      proposedRowHash: proposedRowHashV1({
        canonicalEntity: entity,
        naturalKey: projection.naturalKey,
        fiscalYear,
        fundingField,
        values: projection.values,
      }),
      block: null,
    };
  });

  /* ---- Stage 2: cross-item detection ---- */

  // Duplicate natural keys. Same key twice is always blocking: identical
  // proposals are a planning defect, and differing proposals would require a
  // last-wins rule, which this system does not have.
  const byKey = new Map<string, StagedItem[]>();
  for (const item of staged) {
    if (item.entity == null) continue;
    const key = rowKey(item.entity, item.input.naturalKey);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(item);
    else byKey.set(key, [item]);
  }
  for (const [, bucket] of byKey) {
    if (bucket.length < 2) continue;
    const hashes = new Set(bucket.map((item) => item.proposedRowHash));
    const conflicting = hashes.size > 1;
    for (const item of bucket) {
      if (item.block != null) continue;
      item.block = conflicting
        ? {
            reason: 'conflicting_duplicate_values',
            detail: `${bucket.length} projections propose different values for the same canonical row`,
          }
        : {
            reason: 'duplicate_natural_key',
            detail: `${bucket.length} projections propose the same canonical row`,
          };
    }
  }

  // Parent rows must exist, either already active or created by this same plan.
  const availableParents = new Set<string>();
  for (const row of priorRows) availableParents.add(rowKey(row.canonicalEntity, row.naturalKey));
  for (const item of staged) {
    if (item.entity == null || item.block != null) continue;
    availableParents.add(rowKey(item.entity, item.input.naturalKey));
  }
  for (const item of staged) {
    if (item.entity == null || item.block != null) continue;
    const parent = parentEntityOfV1(item.entity);
    if (parent == null) continue;
    const parentKey = item.input.parentNaturalKey ?? null;
    if (parentKey == null || parentKey === '') {
      item.block = {
        reason: 'missing_dependency_row',
        detail: `${item.entity} requires a ${parent} parent but no parent natural key was supplied`,
      };
      continue;
    }
    if (!availableParents.has(rowKey(parent, parentKey))) {
      item.block = {
        reason: 'missing_dependency_row',
        detail: `${item.entity} references ${parent} "${parentKey}", which is neither active nor created by this plan`,
      };
    }
  }

  // A live manual override must not be silently overwritten by official data.
  const activeOverlays = new Set<string>();
  for (const overlay of overlays) {
    if (overlay.status !== 'active') continue;
    activeOverlays.add(
      [
        overlay.canonicalEntity,
        overlay.naturalKey,
        overlay.fiscalYear ?? '',
        overlay.fundingField ?? '',
      ].join(' '),
    );
  }

  /* ---- Stage 3: operations, alerts, and assembly ---- */

  const items: PromotionPlanItemV1[] = staged.map((item) => {
    const projection = item.input;
    const entity = item.entity;
    const entry = item.entry;
    const fiscalYear = projection.fiscalYear ?? null;
    const fundingField = projection.fundingField ?? null;
    const prior =
      entity != null ? (priorByKey.get(rowKey(entity, projection.naturalKey)) ?? null) : null;

    let block = item.block;

    // Drift blocks everything that would otherwise change a row: the prior
    // hashes this plan diffed against are not the rows that are live.
    if (block == null && snapshotDrift) {
      block = {
        reason: 'active_row_drift',
        detail: `plan expected active snapshot ${
          input.expectedActiveSnapshotId ?? '(baseline/none)'
        } but ${input.actualActiveSnapshotId ?? '(baseline/none)'} is active`,
      };
    }

    // A prior row carried from a snapshot other than the live one is drift too.
    if (block == null && prior != null && input.actualActiveSnapshotId != null) {
      if (prior.snapshotId !== input.actualActiveSnapshotId) {
        block = {
          reason: 'active_row_drift',
          detail: `prior row for "${projection.naturalKey}" belongs to snapshot ${prior.snapshotId}, not the active ${input.actualActiveSnapshotId}`,
        };
      }
    }

    let operation: PromotionOperationV1;
    if (block != null) {
      operation = 'BLOCKED';
    } else if (prior == null) {
      operation = 'INSERT';
    } else if (prior.rowHash === item.proposedRowHash) {
      operation = 'UNCHANGED';
    } else if (input.mode === 'correction') {
      operation = 'CORRECTION';
    } else {
      operation = 'SUPERSEDE';
    }

    // Only a change to an overridden coordinate collides; an unchanged official
    // value beneath a live override is not a conflict.
    if (
      block == null &&
      entity != null &&
      (operation === 'SUPERSEDE' || operation === 'CORRECTION') &&
      activeOverlays.has(
        [entity, projection.naturalKey, fiscalYear ?? '', fundingField ?? ''].join(' '),
      )
    ) {
      block = {
        reason: 'manual_override_collision',
        detail:
          'the official value changed beneath an active manual override; resolve the override before promoting',
      };
      operation = 'BLOCKED';
    }

    const alertDisposition = classifyAlertV1({
      operation,
      mode: input.mode,
      alertEligible: entry?.alertEligible ?? false,
    });

    return {
      sourceProjectionId: projection.projectionId,
      sourceProjectionHash: projection.projectionHash,
      projectionKind: projection.projectionKind,
      canonicalEntity: entity,
      canonicalNaturalKey: projection.naturalKey,
      family: entry?.family ?? null,
      fiscalYear,
      fundingField,
      operation,
      priorRowHash: prior?.rowHash ?? null,
      proposedRowHash: operation === 'BLOCKED' ? null : item.proposedRowHash,
      reason: block?.detail ?? reasonForOperationV1(operation),
      blockReason: block?.reason ?? null,
      alertDisposition,
      compatibilityEffect: entry?.compatibility ?? null,
    };
  });

  // Deterministic order. Sorting before hashing is what makes a reordered input
  // produce an identical plan hash.
  items.sort(comparePlanItemsV1);

  const counts = countOperationsV1(items);
  const plan: Omit<DefenseBudgetPromotionPlanV1, 'planHash'> = {
    schemaVersion: DEFENSE_BUDGET_PROMOTION_PLAN_SCHEMA_VERSION,
    planId: input.planId,
    mappingRegistryVersion: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
    mappingRegistryHash: input.mappingRegistryHash,
    eligibilityHash: input.eligibilityHash,
    scope: input.scope,
    mode: input.mode,
    expectedActiveSnapshotId: input.expectedActiveSnapshotId,
    proposedSnapshotId: input.proposedSnapshotId,
    items,
    counts,
    diffsByFamily: bucketBy(items, (item) => item.family ?? '(unmapped)'),
    diffsByEntity: bucketBy(items, (item) => item.canonicalEntity ?? '(unmapped)'),
    diffsByFiscalYear: bucketBy(items, (item) =>
      item.fiscalYear == null ? '(none)' : String(item.fiscalYear),
    ),
    diffsByFundingField: bucketBy(items, (item) => item.fundingField ?? '(none)'),
    blockReasonCounts: countBlockReasonsV1(items),
    blocked: counts.blocked > 0,
  };

  return { ...plan, planHash: promotionPlanHashV1(plan) };
}

/** Deterministic hash of a plan, excluding the hash field itself. */
export function promotionPlanHashV1(plan: Omit<DefenseBudgetPromotionPlanV1, 'planHash'>): string {
  return sha256CanonicalJson(stripUndefinedProperties(plan) as unknown as JsonValue);
}

/* ------------------------------------------------------------------ */
/* C6. Classification helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Alert behaviour for one item.
 *
 * Order is the policy. Suppression by run mode is checked before entity
 * eligibility, so a baseline hydration of a million money rows produces no
 * client alerts regardless of how alertable those rows are — which is the
 * Phase 7 requirement that initial hydration never generates false alerts.
 */
export function classifyAlertV1(input: {
  operation: PromotionOperationV1;
  mode: PromotionModeV1;
  alertEligible: boolean;
}): AlertDispositionV1 {
  if (input.operation === 'BLOCKED' || input.operation === 'UNCHANGED') return 'none';
  if (input.mode === 'baseline_hydration') return 'suppressed_hydration';
  if (input.mode === 'correction') return 'suppressed_correction';
  if (input.mode === 'rollback') return 'suppressed_rollback';
  if (!input.alertEligible) return 'suppressed_not_alertable';
  return 'eligible';
}

function reasonForOperationV1(operation: PromotionOperationV1): string {
  switch (operation) {
    case 'INSERT':
      return 'no active row for this canonical natural key';
    case 'UNCHANGED':
      return 'proposed row hash equals the active row hash';
    case 'SUPERSEDE':
      return 'active row exists with a different hash';
    case 'CORRECTION':
      return 'correction run: active row exists with a different hash';
    case 'BLOCKED':
      return 'blocked';
    default: {
      const exhaustive: never = operation;
      throw new Error(`unhandled operation: ${String(exhaustive)}`);
    }
  }
}

function comparePlanItemsV1(a: PromotionPlanItemV1, b: PromotionPlanItemV1): number {
  const entityA = a.canonicalEntity ?? '';
  const entityB = b.canonicalEntity ?? '';
  if (entityA !== entityB) return entityA.localeCompare(entityB);
  if (a.canonicalNaturalKey !== b.canonicalNaturalKey) {
    return a.canonicalNaturalKey.localeCompare(b.canonicalNaturalKey);
  }
  const fyA = a.fiscalYear ?? -1;
  const fyB = b.fiscalYear ?? -1;
  if (fyA !== fyB) return fyA - fyB;
  const fieldA = a.fundingField ?? '';
  const fieldB = b.fundingField ?? '';
  if (fieldA !== fieldB) return fieldA.localeCompare(fieldB);
  return a.sourceProjectionId.localeCompare(b.sourceProjectionId);
}

function countOperationsV1(items: PromotionPlanItemV1[]): PromotionPlanCountsV1 {
  const counts: PromotionPlanCountsV1 = {
    total: items.length,
    insert: 0,
    supersede: 0,
    unchanged: 0,
    correction: 0,
    blocked: 0,
    alertEligible: 0,
  };
  for (const item of items) {
    if (item.operation === 'INSERT') counts.insert += 1;
    else if (item.operation === 'SUPERSEDE') counts.supersede += 1;
    else if (item.operation === 'UNCHANGED') counts.unchanged += 1;
    else if (item.operation === 'CORRECTION') counts.correction += 1;
    else counts.blocked += 1;
    if (item.alertDisposition === 'eligible') counts.alertEligible += 1;
  }
  return counts;
}

function countBlockReasonsV1(
  items: PromotionPlanItemV1[],
): { reason: PlanBlockReasonV1; count: number }[] {
  const tally = new Map<PlanBlockReasonV1, number>();
  for (const item of items) {
    if (item.blockReason == null) continue;
    tally.set(item.blockReason, (tally.get(item.blockReason) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
}

function bucketBy(
  items: PromotionPlanItemV1[],
  keyOf: (item: PromotionPlanItemV1) => string,
): PromotionPlanDiffBucketV1[] {
  const buckets = new Map<string, PromotionPlanDiffBucketV1>();
  for (const item of items) {
    const key = keyOf(item);
    let bucket = buckets.get(key);
    if (bucket == null) {
      bucket = { key, insert: 0, supersede: 0, unchanged: 0, correction: 0, blocked: 0 };
      buckets.set(key, bucket);
    }
    if (item.operation === 'INSERT') bucket.insert += 1;
    else if (item.operation === 'SUPERSEDE') bucket.supersede += 1;
    else if (item.operation === 'UNCHANGED') bucket.unchanged += 1;
    else if (item.operation === 'CORRECTION') bucket.correction += 1;
    else bucket.blocked += 1;
  }
  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------------ */
/* C7. Execution expectations                                          */
/* ------------------------------------------------------------------ */

export interface PromotionExecutionExpectationV1 {
  canonicalEntity: CanonicalEntityV1;
  naturalKey: string;
  rowHash: string;
  operation: Extract<PromotionOperationV1, 'INSERT' | 'SUPERSEDE' | 'CORRECTION'>;
}

/**
 * The exact rows Workstream E is authorized to stage, with the hash each must
 * reproduce. `UNCHANGED` and `BLOCKED` items are absent by construction, so an
 * executor working from this list cannot write a row the plan did not
 * authorize and cannot skip one it did.
 */
export function buildExecutionExpectationsV1(
  plan: DefenseBudgetPromotionPlanV1,
): PromotionExecutionExpectationV1[] {
  const expectations: PromotionExecutionExpectationV1[] = [];
  for (const item of plan.items) {
    if (
      item.operation !== 'INSERT' &&
      item.operation !== 'SUPERSEDE' &&
      item.operation !== 'CORRECTION'
    ) {
      continue;
    }
    if (item.canonicalEntity == null || item.proposedRowHash == null) continue;
    expectations.push({
      canonicalEntity: item.canonicalEntity,
      naturalKey: item.canonicalNaturalKey,
      rowHash: item.proposedRowHash,
      operation: item.operation,
    });
  }
  return expectations;
}
