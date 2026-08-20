/**
 * Phase 7 Workstream L — the generic snapshot-to-snapshot delta engine.
 *
 * `DeltaEngineService` computes deltas by re-reading mutable `program_element*`
 * tables and is PE-shaped throughout: a procurement quantity, an O&M workload
 * figure, or a MILCON cost category has nowhere to go in it. This replaces that
 * for canonical changes. It is generic because it works on the canonical row
 * substrate, which is one shape for every family — RDT&E, procurement, O&M,
 * MILCON, congressional stages, actions, project funding, quantities and unit
 * cost all arrive here as the same six value axes.
 *
 * `program_element_delta` is not removed. Six product surfaces read it —
 * `ProgramElementReadService`, the action recommender, product metrics — and
 * Workstream L's remit is to make the canonical delta *primary*, not to break
 * the compatibility layer that Workstream M is responsible for migrating.
 *
 * ---------------------------------------------------------------------------
 * Three decisions
 * ---------------------------------------------------------------------------
 *
 * **1. Identity and stage come from the canonical row, not the outbox row.**
 *
 * Workstream E writes `stage: null` on every outbox row. A delta that copied
 * that would carry a congressional funding field with no authority naming it,
 * and the delta table's stage-authority CHECK would refuse the insert — which
 * is the constraint working, but at the wrong layer and at drain time. The
 * canonical row already passed that same check when it was staged, so it is
 * both the correct source and the one that cannot disagree with itself.
 *
 * **2. What changed is decided by typed axes; whether anything changed is
 * decided by the row hash.**
 *
 * The typed axes — money, quantity, unit cost, text, date — are compared
 * exactly, as strings. Everything else a canonical row carries lives in
 * `attributes`, and rather than deserialize and canonicalize that JSON on every
 * row, a difference in `canonicalRowHash` with no typed axis moved *is* the
 * attributes axis. Exact, cheap, and it cannot miss a change: the hash covers
 * the whole row.
 *
 * **3. This engine emits no alerts and writes no `intelligence_change`.**
 *
 * Plan L.13. The old path emitted tenant `intelligence_change` rows straight
 * from outbox processing. Here the delta is a record of fact; whether it
 * reaches a client is a later, separately authorized fan-out reading
 * `alert_eligible`. Keeping emission out of this module is what makes "no
 * inline alert emission" checkable by reading one file.
 */
import { sha256Hex } from '../contracts/canonical-json.js';
import { parseCanonicalDecimalString } from '../contracts/decimal-string.js';
// One implementation of exact decimal subtraction in this repository, not
// three. `exact-arithmetic` imports nothing but `decimal-string`, so this is a
// leaf utility rather than a dependency on the verifier.
import { subtractDecimals } from '../verification/rules/arithmetic/exact-arithmetic.js';
// Pure, zero-import scoring shared with the PE delta engine and read service.
// Importing it keeps one definition of materiality in the product; it brings no
// Prisma, no Nest, and no legacy writer with it.
import {
  scoreMateriality,
  severityForScore,
  type DeltaStage,
} from '../../program-element/deltas/materiality-scorer.js';
import type { OutboxRowV1 } from './promotion-outbox-drain-v1.js';

/* ------------------------------------------------------------------ */
/* L5.1 Vocabulary                                                     */
/* ------------------------------------------------------------------ */

export const CANONICAL_DELTA_KIND_V1_VALUES = [
  'new_start',
  'termination',
  'increase',
  'decrease',
  'quantity_change',
  'unit_cost_change',
  'nonfinancial_change',
  'identity_change',
] as const;
export type CanonicalDeltaKindV1 = (typeof CANONICAL_DELTA_KIND_V1_VALUES)[number];

export const CANONICAL_DELTA_AXIS_V1_VALUES = [
  'money',
  'quantity',
  'unit_cost',
  'text',
  'date',
  'attributes',
] as const;
export type CanonicalDeltaAxisV1 = (typeof CANONICAL_DELTA_AXIS_V1_VALUES)[number];

/**
 * One side of a change, as the engine needs to see a canonical row.
 *
 * Every decimal is a canonical decimal string. Nothing here is a `number`: a
 * quantity that arrived as 3.0000 and a quantity of 3 are the same value and
 * must compare equal, which is what canonical form guarantees and what a float
 * round-trip would only usually preserve.
 */
export interface CanonicalRowValuesV1 {
  canonicalRowHash: string;
  family: string;
  fiscalYear: number | null;
  fundingField: string | null;
  stage: string | null;
  moneyOriginalValue: string | null;
  moneyValueMillions: string | null;
  quantity: string | null;
  unitCostDollars: string | null;
  textValue: string | null;
  dateValue: string | null;
}

export interface CanonicalDeltaRecordV1 {
  deltaKey: string;
  activationId: string;
  outboxId: string;
  oldSnapshotId: string | null;
  newSnapshotId: string;
  canonicalEntity: string;
  canonicalNaturalKey: string;
  family: string;
  fiscalYear: number | null;
  fundingField: string | null;
  stage: string | null;
  deltaKind: CanonicalDeltaKindV1;
  changedAxes: CanonicalDeltaAxisV1[];
  oldMoneyOriginalValue: string | null;
  oldMoneyValueMillions: string | null;
  newMoneyOriginalValue: string | null;
  newMoneyValueMillions: string | null;
  moneyDeltaMillions: string | null;
  oldQuantity: string | null;
  newQuantity: string | null;
  oldUnitCostDollars: string | null;
  newUnitCostDollars: string | null;
  changeClassification: string;
  suppressAlert: boolean;
  alertEligible: boolean;
  materialityScore: string;
  materialityFactors: Record<string, number>;
  severity: 'info' | 'notable' | 'critical';
  sourceLineage: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* L5.2 Axes                                                           */
/* ------------------------------------------------------------------ */

/** Exact string comparison over canonical decimals. Null and absent are the same thing. */
function sameValue(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Which axes moved between two sides.
 *
 * `attributes` is the residual: the row hash covers everything, so a hash
 * difference that no typed axis explains must be attribute-shaped.
 */
export function changedAxesV1(
  prior: CanonicalRowValuesV1 | null,
  next: CanonicalRowValuesV1 | null,
): CanonicalDeltaAxisV1[] {
  if (prior == null || next == null) {
    // One side absent: every axis the present side carries is new or gone.
    const present = next ?? prior;
    if (present == null) return [];
    const axes: CanonicalDeltaAxisV1[] = [];
    if (present.moneyValueMillions != null) axes.push('money');
    if (present.quantity != null) axes.push('quantity');
    if (present.unitCostDollars != null) axes.push('unit_cost');
    if (present.textValue != null) axes.push('text');
    if (present.dateValue != null) axes.push('date');
    return axes.length > 0 ? axes : ['attributes'];
  }

  const axes: CanonicalDeltaAxisV1[] = [];
  if (
    !sameValue(prior.moneyValueMillions, next.moneyValueMillions) ||
    !sameValue(prior.moneyOriginalValue, next.moneyOriginalValue)
  ) {
    axes.push('money');
  }
  if (!sameValue(prior.quantity, next.quantity)) axes.push('quantity');
  if (!sameValue(prior.unitCostDollars, next.unitCostDollars)) axes.push('unit_cost');
  if (!sameValue(prior.textValue, next.textValue)) axes.push('text');
  if (!sameValue(prior.dateValue, next.dateValue)) axes.push('date');

  if (axes.length === 0 && prior.canonicalRowHash !== next.canonicalRowHash) {
    axes.push('attributes');
  }
  return axes;
}

/**
 * What kind of change this is.
 *
 * Money leads, because money is what the product alerts on. A value arriving
 * where there was none is a new start and a value going to zero is a
 * termination — both categorically notable regardless of size, which is why the
 * materiality scorer gives them a flat boost rather than scoring them purely on
 * magnitude.
 */
export function canonicalDeltaKindV1(
  prior: CanonicalRowValuesV1 | null,
  next: CanonicalRowValuesV1 | null,
  axes: CanonicalDeltaAxisV1[],
): CanonicalDeltaKindV1 {
  if (next == null) return 'termination';
  if (prior == null) {
    return next.moneyValueMillions != null ? 'new_start' : 'identity_change';
  }
  if (axes.includes('money')) {
    const before = prior.moneyValueMillions;
    const after = next.moneyValueMillions;
    if (after == null || after === '0') {
      return before == null || before === '0' ? 'nonfinancial_change' : 'termination';
    }
    if (before == null || before === '0') return 'new_start';
    return subtractDecimals(after, before).startsWith('-') ? 'decrease' : 'increase';
  }
  if (axes.includes('quantity')) return 'quantity_change';
  if (axes.includes('unit_cost')) return 'unit_cost_change';
  return 'nonfinancial_change';
}

/* ------------------------------------------------------------------ */
/* L5.3 Materiality                                                    */
/* ------------------------------------------------------------------ */

/** Which rung of the stage ladder a funding field sits on, for scoring only. */
export function materialityStageV1(fundingField: string | null): DeltaStage {
  switch (fundingField) {
    case 'enacted':
    case 'reprogrammed':
    case 'executed':
      return 'enacted';
    case 'conference':
    case 'ndaaConference':
      return 'conference';
    case 'hascMark':
    case 'sascMark':
    case 'hacDMark':
    case 'sacDMark':
      return 'marks';
    default:
      return 'pb';
  }
}

/**
 * The exact money delta as a ranking input.
 *
 * This is the one place a money figure becomes a JavaScript number, and it is
 * deliberate and contained: `scoreMateriality` produces a 0..1 heuristic used
 * to order and threshold alerts, not to state a value. The exact difference is
 * computed by `subtractDecimals` and stored exactly in `money_delta_millions`;
 * what leaves this function is a magnitude for a log curve, where the
 * difference between 412.7 and 412.700000001 cannot change any outcome.
 *
 * Nothing downstream may read the score as an amount, which is why the delta
 * record carries both and names them differently.
 */
function scoreInputsFromExactDeltaV1(
  before: string | null,
  after: string | null,
): { deltaAbsM: number | null; deltaPct: number | null; exactDelta: string | null } {
  if (before == null || after == null) {
    // One side absent. The magnitude is whichever side exists — the amount that
    // arrived on a new start, or the amount that went away on a termination.
    // Reading it from `after` alone would score the loss of a $900M program at
    // zero on the dollar axis and rank it below a rounding change.
    return {
      deltaAbsM: Math.abs(Number(after ?? before)),
      deltaPct: null,
      exactDelta: null,
    };
  }
  const exactDelta = subtractDecimals(after, before);
  const deltaAbsM = Math.abs(Number(exactDelta));
  const base = Math.abs(Number(before));
  const deltaPct = base > 0 ? deltaAbsM / base : null;
  return { deltaAbsM, deltaPct, exactDelta };
}

/* ------------------------------------------------------------------ */
/* L5.4 The delta                                                      */
/* ------------------------------------------------------------------ */

/**
 * Compute the delta for one outbox row, or `null` when there is nothing to
 * record.
 *
 * Returning null is a real outcome, not an error path. A rollback marker row
 * names no canonical identity at all, and an outbox row whose two sides are
 * byte-identical describes a change that did not happen; writing a delta for
 * either would put a row in front of an operator that says something moved when
 * nothing did.
 */
export function computeCanonicalDeltaV1(input: {
  outboxRow: OutboxRowV1;
  prior: CanonicalRowValuesV1 | null;
  next: CanonicalRowValuesV1 | null;
}): CanonicalDeltaRecordV1 | null {
  const { outboxRow, prior, next } = input;
  if (prior == null && next == null) return null;

  const axes = changedAxesV1(prior, next);
  if (axes.length === 0) return null;

  const identity = next ?? prior;
  /* c8 ignore next — both null is refused above. */
  if (identity == null) return null;

  const kind = canonicalDeltaKindV1(prior, next, axes);
  const { deltaAbsM, deltaPct, exactDelta } = scoreInputsFromExactDeltaV1(
    prior?.moneyValueMillions ?? null,
    next?.moneyValueMillions ?? null,
  );

  const materiality = scoreMateriality({
    deltaType: kind === 'new_start' || kind === 'termination' ? kind : 'mark_vs_request',
    deltaAbsM,
    deltaPct,
    stage: materialityStageV1(identity.fundingField),
  });

  // Both conditions, both ways. `suppressAlert` is the planner's decision
  // carried through the activation transaction; the classification is what the
  // database's own suppression check keys on. Requiring both means a row can
  // only become alert-eligible if nothing anywhere said it should not be.
  const alertEligible =
    !outboxRow.suppressAlert && outboxRow.changeClassification === 'material_change';

  return {
    deltaKey: `delta:${sha256Hex(`${outboxRow.dedupeKey} ${identity.canonicalRowHash}`)}`,
    activationId: outboxRow.activationId,
    outboxId: outboxRow.id,
    oldSnapshotId: outboxRow.oldSnapshotId,
    newSnapshotId: outboxRow.newSnapshotId,
    canonicalEntity: outboxRow.canonicalEntity,
    canonicalNaturalKey: outboxRow.canonicalNaturalKey,
    family: identity.family,
    fiscalYear: identity.fiscalYear,
    fundingField: identity.fundingField,
    stage: identity.stage,
    deltaKind: kind,
    changedAxes: axes,
    oldMoneyOriginalValue: prior?.moneyOriginalValue ?? null,
    oldMoneyValueMillions: prior?.moneyValueMillions ?? null,
    newMoneyOriginalValue: next?.moneyOriginalValue ?? null,
    newMoneyValueMillions: next?.moneyValueMillions ?? null,
    moneyDeltaMillions: exactDelta,
    oldQuantity: prior?.quantity ?? null,
    newQuantity: next?.quantity ?? null,
    oldUnitCostDollars: prior?.unitCostDollars ?? null,
    newUnitCostDollars: next?.unitCostDollars ?? null,
    changeClassification: outboxRow.changeClassification,
    suppressAlert: outboxRow.suppressAlert,
    alertEligible,
    // NUMERIC(6,5) in the database. Fixed to the stored scale here so the value
    // written and the value read back are the same string.
    materialityScore: parseCanonicalDecimalString(materiality.score.toFixed(5)),
    materialityFactors: materiality.factors,
    severity: severityForScore(materiality.score),
    sourceLineage: {
      outboxDedupeKey: outboxRow.dedupeKey,
      priorRowHash: prior?.canonicalRowHash ?? null,
      newRowHash: next?.canonicalRowHash ?? null,
      isCorrection: outboxRow.isCorrection,
      isRollback: outboxRow.isRollback,
    },
  };
}

/* ------------------------------------------------------------------ */
/* L5.5 The handler                                                    */
/* ------------------------------------------------------------------ */

/** Reads one side of a change out of a snapshot. */
export interface CanonicalRowLookupV1 {
  loadValues(
    snapshotId: string,
    canonicalEntity: string,
    canonicalNaturalKey: string,
  ): Promise<CanonicalRowValuesV1 | null>;
}

/** Persists a computed delta. Must be idempotent — a replayed drain recomputes the same record. */
export interface CanonicalDeltaWriterV1 {
  insertIfAbsent(record: CanonicalDeltaRecordV1): Promise<void>;
}

/**
 * The outbox handler: resolve both sides, compute, record. Nothing else.
 *
 * This is what `drainPromotionOutboxBatchV1` publishes each row to. A throw
 * here is a row failure and gets the policy's retry-or-quarantine treatment, so
 * a delta that cannot be computed holds its run out of `COMPLETED` rather than
 * disappearing — which is the whole reason the outbox exists rather than the
 * activation transaction doing this work inline.
 */
export function createCanonicalDeltaHandlerV1(
  lookup: CanonicalRowLookupV1,
  writer: CanonicalDeltaWriterV1,
): { publish(row: OutboxRowV1): Promise<void> } {
  return {
    async publish(row: OutboxRowV1): Promise<void> {
      const [prior, next] = await Promise.all([
        row.oldSnapshotId == null
          ? Promise.resolve(null)
          : lookup.loadValues(row.oldSnapshotId, row.canonicalEntity, row.canonicalNaturalKey),
        lookup.loadValues(row.newSnapshotId, row.canonicalEntity, row.canonicalNaturalKey),
      ]);

      const record = computeCanonicalDeltaV1({ outboxRow: row, prior, next });
      // Nothing to record is a success. A rollback marker names no canonical
      // identity, and a row whose sides are identical describes no change; both
      // are delivered, and neither leaves the run stuck.
      if (record == null) return;

      await writer.insertIfAbsent(record);
    },
  };
}
