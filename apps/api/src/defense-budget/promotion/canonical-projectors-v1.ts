/**
 * Phase 7 Workstreams F, G, and H — the RDT&E, procurement, and O&M canonical
 * projectors.
 *
 * A projector turns a verified Phase 4/5 projection candidate into the
 * `PromotionProjectionInputV1` the planner diffs and the engine stages. It is
 * the last place family knowledge is applied, and it applies **only** knowledge
 * Phases 4–6 already committed to: which target a candidate is for, what its
 * natural key is, and what values it carries. Nothing here re-reads a document,
 * re-derives an authority, or decides what a number means.
 *
 * Three rules make that safe:
 *
 * 1. **The registry decides the destination.** A projector never names a
 *    canonical entity; it names a projection kind and the Workstream B registry
 *    resolves it. That is what structurally prevents an O&M or procurement
 *    candidate from landing in RDT&E identity space — there is no mapping that
 *    would let it, and a test asserts no `non_rdte:*` kind resolves to a
 *    `canonical_rdte_*` entity.
 * 2. **A missing field blocks; it never defaults.** If the registry says an
 *    entity carries money and the candidate has no extractable money triple,
 *    the projector emits a refusal. A zero or an empty string would become a
 *    budget position reading "$0", which is worse than a blocked promotion.
 * 3. **No legacy writer is reachable.** These modules import no Prisma client,
 *    no `ProgramElementWriterService`, and no reconciliation service.
 *    Architecture tests enforce all three.
 *
 * Money stays exact throughout: the printed decimal string, its unit, and the
 * normalized millions string travel together as strings and are never parsed
 * into a JavaScript number.
 */
import {
  lookupCanonicalMappingV1,
  parentEntityOfV1,
  validateFundingFieldForMappingV1,
  type CanonicalEntityV1,
} from './canonical-mapping-registry-v1.js';
import type { Phase6NativeProjectionV1 } from '../phase6/phase6-native-projection-v1.js';
import type { StageAuthorityV1, StageV1 } from '../stages/stage-vocabulary-v1.js';
import type { FundingFieldV1 } from '../contracts/extraction-artifact-v1.js';
import type {
  CanonicalLineageV1,
  CanonicalMoneyV1,
  CanonicalRowValuesV1,
  PromotionProjectionInputV1,
} from './promotion-planner-v1.js';
import type { MoneyUnitV1 } from '../contracts/extraction-artifact-v1.js';
import { isCanonicalDecimalString } from '../contracts/decimal-string.js';

/* ------------------------------------------------------------------ */
/* FGH1. Candidate shape                                               */
/* ------------------------------------------------------------------ */

/**
 * The common shape of a Phase 4 or Phase 5 projection candidate. Both
 * `RdteProjectionCandidateV1` and `NonRdteProjectionCandidateV1` are
 * structurally assignable to this; it is declared here rather than imported as
 * a union so a projector cannot accidentally reach a family-specific field.
 */
export interface ProjectionCandidateInputV1 {
  candidateId: string;
  target: string;
  naturalKey: string;
  operation: string;
  reason: string;
  artifactId: string;
  artifactContentSha256: string;
  verificationCandidateId: string;
  verificationRunId: string;
  verificationDecisionId: string;
  sourceDocumentKey: string;
  sourcePdfSha256: string;
  assertionIds: string[];
  evidenceIds: string[];
  values: Record<string, string | number | boolean | null>;
  exclusionReason?: string;
}

export const PROJECTOR_REFUSAL_V1_VALUES = [
  'candidate_excluded',
  'candidate_not_projectable',
  'unsupported_target',
  'money_required_but_absent',
  'money_not_canonical_decimal',
  'quantity_not_canonical_decimal',
  'parent_key_absent',
  'fiscal_year_absent',
  'funding_field_absent',
  /* Workstream J — congressional lifecycle */
  'projection_not_verified',
  'binding_not_accepted',
  'stage_authority_violation',
  'continuing_resolution_without_line_authority',
  'enactment_proof_absent',
] as const;
export type ProjectorRefusalV1 = (typeof PROJECTOR_REFUSAL_V1_VALUES)[number];

export interface ProjectorRefusalRecordV1 {
  candidateId: string;
  target: string;
  naturalKey: string;
  reason: ProjectorRefusalV1;
  detail: string;
}

export interface ProjectorResultV1 {
  projections: PromotionProjectionInputV1[];
  /** Refusals are returned, never dropped, and block the promotion upstream. */
  refusals: ProjectorRefusalRecordV1[];
}

/* ------------------------------------------------------------------ */
/* FGH2. Shared extraction                                             */
/* ------------------------------------------------------------------ */

/** Keys the Phase 4/5 planners use for the normalized millions figure. */
const MONEY_MILLIONS_KEYS = ['valueMillions', 'amount', 'request', 'amountMillions'] as const;
/** Keys used for the fiscal year. */
const FISCAL_YEAR_KEYS = ['fiscalYear', 'fy', 'assertedFy'] as const;
/** Keys used for a free-text value. */
const TEXT_KEYS = ['title', 'description', 'narrative', 'textValue', 'scope'] as const;
/** Keys used for a date value. */
const DATE_KEYS = ['plannedDate', 'actualDate', 'asOfDate', 'exactDate', 'dateValue'] as const;

/**
 * Reads the first present key and reports WHICH key it used.
 *
 * The key matters: only the key actually consumed by a typed axis is removed
 * from the attribute bag. Removing every candidate key would silently discard
 * the ones that lost the race — which is how a milestone's `actualDate` would
 * vanish once `plannedDate` claimed the single date axis.
 */
function readStringWithKey(
  values: Record<string, string | number | boolean | null>,
  keys: readonly string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === 'string' && value.trim() !== '') return { key, value };
  }
  return null;
}

function readInteger(
  values: Record<string, string | number | boolean | null>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
}

/**
 * A decimal carried by a candidate. Planners emit these as strings; an integer
 * is accepted because a whole quantity is legitimately emitted as a number, and
 * converting an integer to its decimal string is exact. A non-integer number is
 * refused rather than converted — that is where float error would enter.
 */
function readDecimalString(
  values: Record<string, string | number | boolean | null>,
  keys: readonly string[],
): { ok: true; key: string; value: string } | { ok: false; detail: string } | null {
  for (const key of keys) {
    const value = values[key];
    if (value == null) continue;
    if (typeof value === 'string') {
      if (value.trim() === '') continue;
      return isCanonicalDecimalString(value)
        ? { ok: true, key, value }
        : { ok: false, detail: `${key}="${value}" is not a canonical decimal string` };
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        return {
          ok: false,
          detail: `${key}=${value} is a non-integer number; money and quantity must arrive as exact decimal strings`,
        };
      }
      return { ok: true, key, value: String(value) };
    }
  }
  return null;
}

const MONEY_UNITS: readonly string[] = ['dollars', 'thousands', 'millions'];

function extractMoney(
  values: Record<string, string | number | boolean | null>,
):
  | { ok: true; money: CanonicalMoneyV1 | null; consumed: string[] }
  | { ok: false; reason: ProjectorRefusalV1; detail: string } {
  const millions = readDecimalString(values, MONEY_MILLIONS_KEYS);
  const originalValue = values.originalValue;
  const originalUnit = values.originalUnit;

  if (millions == null && originalValue == null && originalUnit == null) {
    return { ok: true, money: null, consumed: [] };
  }
  if (millions != null && !millions.ok) {
    return { ok: false, reason: 'money_not_canonical_decimal', detail: millions.detail };
  }
  if (millions == null || typeof originalValue !== 'string' || typeof originalUnit !== 'string') {
    return {
      ok: false,
      reason: 'money_required_but_absent',
      detail:
        'a money value must carry all three of the normalized millions figure, the printed original value, and its unit',
    };
  }
  if (!MONEY_UNITS.includes(originalUnit)) {
    return {
      ok: false,
      reason: 'money_required_but_absent',
      detail: `unrecognized money unit "${originalUnit}"`,
    };
  }
  if (!isCanonicalDecimalString(originalValue)) {
    return {
      ok: false,
      reason: 'money_not_canonical_decimal',
      detail: `originalValue="${originalValue}" is not a canonical decimal string`,
    };
  }
  return {
    ok: true,
    money: {
      originalValue,
      originalUnit: originalUnit as MoneyUnitV1,
      valueMillions: millions.value,
    },
    consumed: [millions.key, 'originalValue', 'originalUnit'],
  };
}

/* ------------------------------------------------------------------ */
/* FGH3. The shared projector core                                     */
/* ------------------------------------------------------------------ */

export interface ProjectorContextV1 {
  /** `rdte` or `non_rdte` — the namespace the registry keys are under. */
  namespace: 'rdte' | 'non_rdte';
  /** Targets this projector is responsible for. Anything else is refused. */
  allowedTargets: readonly string[];
  /** Resolve the structural parent's natural key from the candidate. */
  parentNaturalKey: (candidate: ProjectionCandidateInputV1) => string | null;
  /** Funding field, when the destination owns one. */
  fundingField?: (candidate: ProjectionCandidateInputV1) => string | null;
}

/** Operations a Phase 4/5 planner marks as projectable. */
const PROJECTABLE_OPERATIONS = new Set(['insert', 'update', 'no_op']);

function projectOne(
  candidate: ProjectionCandidateInputV1,
  context: ProjectorContextV1,
): { projection: PromotionProjectionInputV1 } | { refusal: ProjectorRefusalRecordV1 } {
  const refuse = (reason: ProjectorRefusalV1, detail: string) => ({
    refusal: {
      candidateId: candidate.candidateId,
      target: candidate.target,
      naturalKey: candidate.naturalKey,
      reason,
      detail,
    },
  });

  // An excluded candidate is evidence of why it was excluded, never canonical.
  if (candidate.exclusionReason != null) {
    return refuse('candidate_excluded', `excluded upstream: ${candidate.exclusionReason}`);
  }
  if (!PROJECTABLE_OPERATIONS.has(candidate.operation)) {
    return refuse(
      'candidate_not_projectable',
      `operation "${candidate.operation}" is not projectable`,
    );
  }
  if (!context.allowedTargets.includes(candidate.target)) {
    return refuse(
      'unsupported_target',
      `${candidate.target} is not a target this projector is responsible for`,
    );
  }

  const projectionKind = `${context.namespace}:${candidate.target}`;
  const lookup = lookupCanonicalMappingV1(projectionKind);
  if (!lookup.supported) {
    return refuse('unsupported_target', lookup.detail);
  }
  const entry = lookup.entry;

  const money = extractMoney(candidate.values);
  if (!money.ok) return refuse(money.reason, money.detail);

  const entityCarriesMoney = entry.valueAxes.includes('money');
  const moneyIsRequired =
    entry.moneyRule === 'preserve_original_and_millions' && isPositionEntity(entry.canonicalEntity);
  if (moneyIsRequired && money.money == null) {
    return refuse(
      'money_required_but_absent',
      `${entry.canonicalEntity} is a funding position and must carry money`,
    );
  }
  if (money.money != null && !entityCarriesMoney) {
    return refuse(
      'money_required_but_absent',
      `${entry.canonicalEntity} carries no money axis but the candidate supplied a money value`,
    );
  }

  const quantity = readDecimalString(candidate.values, ['quantity', 'quantityValue']);
  if (quantity != null && !quantity.ok) {
    return refuse('quantity_not_canonical_decimal', quantity.detail);
  }
  const unitCost = readDecimalString(candidate.values, ['unitCostDollars']);
  if (unitCost != null && !unitCost.ok) {
    return refuse('quantity_not_canonical_decimal', unitCost.detail);
  }

  const parentEntity = parentEntityOfV1(entry.canonicalEntity);
  const parentNaturalKey = parentEntity == null ? null : context.parentNaturalKey(candidate);
  if (parentEntity != null && (parentNaturalKey == null || parentNaturalKey === '')) {
    return refuse(
      'parent_key_absent',
      `${entry.canonicalEntity} hangs from ${parentEntity} but the candidate names no parent`,
    );
  }

  const fundingField = context.fundingField?.(candidate) ?? null;
  if (entry.fieldAuthority.mode !== 'not_applicable' && fundingField == null) {
    return refuse(
      'funding_field_absent',
      `${entry.canonicalEntity} owns a funding field but the candidate supplies none`,
    );
  }

  /*
   * A Phase 4/5 candidate carries no stage authority — it came from a budget
   * request document, not from a committee. Validating with no authority is
   * therefore the correct call, and it refuses two things this projector
   * previously passed through: a field outside the entity's allowed set, and
   * any field a stage authority owns. The planner repeats this check and the
   * database repeats it again as a CHECK constraint.
   */
  const fieldCheck = validateFundingFieldForMappingV1(
    entry,
    fundingField as FundingFieldV1 | null,
    undefined,
  );
  if (!fieldCheck.supported) {
    return refuse('stage_authority_violation', fieldCheck.detail);
  }

  const fiscalYear = readInteger(candidate.values, FISCAL_YEAR_KEYS);
  if (moneyIsRequired && fiscalYear == null) {
    return refuse('fiscal_year_absent', `${entry.canonicalEntity} is a per-year position`);
  }

  const text = readStringWithKey(candidate.values, TEXT_KEYS);
  const date = readStringWithKey(candidate.values, DATE_KEYS);

  // Only the keys a typed axis actually claimed are removed from the attribute
  // bag. Every other verified value survives as an attribute — a milestone's
  // actual date does not disappear because its planned date won the date axis.
  const consumed = new Set<string>([...money.consumed, 'direct']);
  if (quantity?.ok) consumed.add(quantity.key);
  if (unitCost?.ok) consumed.add(unitCost.key);
  if (text != null) consumed.add(text.key);
  if (date != null) consumed.add(date.key);
  for (const key of FISCAL_YEAR_KEYS) consumed.add(key);

  const values: CanonicalRowValuesV1 = {
    money: money.money,
    quantity: quantity?.ok ? quantity.value : null,
    unitCostDollars: unitCost?.ok ? unitCost.value : null,
    textValue: text?.value ?? null,
    dateValue: date?.value ?? null,
    attributes: buildAttributes(candidate.values, consumed),
  };

  const lineage: CanonicalLineageV1 = {
    sourceAssertionId: candidate.assertionIds[0] ?? candidate.candidateId,
    evidenceIds: [...candidate.evidenceIds].sort((a, b) => a.localeCompare(b)),
    artifactId: candidate.artifactId,
    artifactContentSha256: candidate.artifactContentSha256,
    verificationCandidateId: candidate.verificationCandidateId,
    verificationRunId: candidate.verificationRunId,
    sourceDocumentId: candidate.sourceDocumentKey,
    sourcePdfSha256: candidate.sourcePdfSha256,
  };

  return {
    projection: {
      projectionId: candidate.candidateId,
      projectionHash: candidate.artifactContentSha256,
      projectionKind,
      naturalKey: candidate.naturalKey,
      parentNaturalKey,
      fiscalYear,
      fundingField: fundingField as PromotionProjectionInputV1['fundingField'],
      bindingStatus: 'accepted',
      directOrDerived: candidate.values.direct === false ? 'derived' : 'direct',
      values,
      lineage,
    },
  };
}

/**
 * Entities whose whole purpose is to carry a funding position. These must have
 * money; identity, detail, narrative, and observation rows legitimately may not.
 */
function isPositionEntity(entity: CanonicalEntityV1): boolean {
  return (
    entity === 'canonical_rdte_program_element_year' ||
    entity === 'canonical_rdte_budget_position' ||
    entity === 'canonical_rdte_project_budget_position' ||
    entity === 'canonical_procurement_budget_line_year' ||
    entity === 'canonical_om_sag_year' ||
    entity === 'canonical_milcon_project_year'
  );
}

/**
 * Everything not already consumed by a typed axis, preserved as attributes so
 * no verified fact is silently discarded. Only the specific keys a typed axis
 * claimed are excluded, which avoids storing the same fact in two
 * representations without dropping the ones that lost the race for an axis.
 */
function buildAttributes(
  values: Record<string, string | number | boolean | null>,
  consumed: ReadonlySet<string>,
): Record<string, string | boolean | null> {
  const attributes: Record<string, string | boolean | null> = {};
  for (const key of Object.keys(values).sort((a, b) => a.localeCompare(b))) {
    if (consumed.has(key)) continue;
    const value = values[key];
    if (value === undefined) continue;
    // Numbers become strings: attributes are descriptive, and keeping them as
    // strings means nothing in the attribute bag can be summed as money.
    attributes[key] = typeof value === 'number' ? String(value) : value;
  }
  return attributes;
}

function runProjector(
  candidates: ProjectionCandidateInputV1[],
  context: ProjectorContextV1,
): ProjectorResultV1 {
  const projections: PromotionProjectionInputV1[] = [];
  const refusals: ProjectorRefusalRecordV1[] = [];
  for (const candidate of candidates) {
    const outcome = projectOne(candidate, context);
    if ('projection' in outcome) projections.push(outcome.projection);
    else refusals.push(outcome.refusal);
  }
  // Deterministic order so a plan built from a projector run is stable.
  projections.sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
  refusals.sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
  return { projections, refusals };
}

/* ------------------------------------------------------------------ */
/* F. RDT&E projector                                                  */
/* ------------------------------------------------------------------ */

export const RDTE_PROJECTOR_TARGETS_V1 = [
  'ProgramElement',
  'ProgramElementYear',
  'ProgramElementBudgetPosition',
  'ProgramElementProject',
  'ProgramElementProjectBudgetPosition',
  'ProgramElementPerformer',
  'ProgramElementMilestone',
  'ProgramElementMilestoneSchedulePeriod',
  'ProgramElementProjectMilestone',
  'ProgramElementProjectMilestoneSchedulePeriod',
  'ProgramElementSource',
] as const;

/**
 * Workstream F. Project codes stay scoped to the parent PE, performer role
 * classification is preserved because it is part of the natural key the
 * registry declares, and milestone planned/actual/as-of semantics survive as
 * typed date and attribute values.
 *
 * `ProgramElementWriterService` is never called; there is no import of it in
 * this module and an architecture test asserts that.
 */
export function projectRdteCandidatesV1(
  candidates: ProjectionCandidateInputV1[],
): ProjectorResultV1 {
  return runProjector(candidates, {
    namespace: 'rdte',
    allowedTargets: RDTE_PROJECTOR_TARGETS_V1,
    parentNaturalKey: (candidate) => {
      const values = candidate.values;
      const peCode = typeof values.peCode === 'string' ? values.peCode : null;
      const projectCode = typeof values.projectCode === 'string' ? values.projectCode : null;
      const milestoneType = typeof values.milestoneType === 'string' ? values.milestoneType : null;

      switch (candidate.target) {
        // A project milestone's schedule period hangs from the project milestone.
        case 'ProgramElementProjectMilestoneSchedulePeriod':
          return peCode && projectCode && milestoneType
            ? `${peCode}|${projectCode}|${milestoneType}`
            : null;
        case 'ProgramElementMilestoneSchedulePeriod':
          return peCode && milestoneType ? `${peCode}|${milestoneType}` : null;
        // Project-scoped rows hang from the project, which is itself PE-scoped.
        case 'ProgramElementProjectBudgetPosition':
        case 'ProgramElementProjectMilestone':
          return peCode && projectCode ? `${peCode}|${projectCode}` : null;
        default:
          return peCode;
      }
    },
    fundingField: (candidate) => {
      if (typeof candidate.values.fundingField === 'string') return candidate.values.fundingField;
      // Phase 4 positions are request-side by policy; the registry restricts
      // these entities to `request`, so anything else is refused there.
      switch (candidate.target) {
        case 'ProgramElementYear':
        case 'ProgramElementBudgetPosition':
        case 'ProgramElementProjectBudgetPosition':
          return 'request';
        default:
          return null;
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* G. Procurement projector                                            */
/* ------------------------------------------------------------------ */

export const PROCUREMENT_PROJECTOR_TARGETS_V1 = [
  'ProcurementBudgetLine',
  'ProcurementBudgetLineYear',
  'ProcurementDistributionLine',
  'ProcurementDetailFact',
] as const;

/**
 * Workstream G. Base and advance procurement stay distinct and short line
 * numbers keep their appropriation/account namespace, both because
 * `advanceProcurement` and `account` are components of the natural key the
 * registry declares. Quantity and unit cost are separate typed axes from money.
 *
 * A procurement candidate cannot reach an RDT&E entity: every target here
 * resolves through `non_rdte:*`, and no `non_rdte:*` key maps to a
 * `canonical_rdte_*` destination.
 */
export function projectProcurementCandidatesV1(
  candidates: ProjectionCandidateInputV1[],
): ProjectorResultV1 {
  return runProjector(candidates, {
    namespace: 'non_rdte',
    allowedTargets: PROCUREMENT_PROJECTOR_TARGETS_V1,
    parentNaturalKey: (candidate) =>
      typeof candidate.values.identityNaturalKey === 'string'
        ? candidate.values.identityNaturalKey
        : null,
    fundingField: (candidate) =>
      typeof candidate.values.fundingField === 'string'
        ? candidate.values.fundingField
        : candidate.target === 'ProcurementBudgetLineYear'
          ? 'request'
          : null,
  });
}

/* ------------------------------------------------------------------ */
/* H. O&M projector                                                    */
/* ------------------------------------------------------------------ */

export const OM_PROJECTOR_TARGETS_V1 = ['OmSag', 'OmSagYear', 'OmDetailFact'] as const;

/**
 * Workstream H. SAG identity stays account-scoped — the same SAG code under a
 * different account is a different line, because `account` is in the natural
 * key. BA/BAG hierarchy survives as attributes on the identity row. Money,
 * workload, and narrative are three separate axes on the detail fact, so a
 * workload count can never be summed as dollars.
 *
 * No O&M row can enter the RDT&E `program_element` identity space.
 */
export function projectOmCandidatesV1(candidates: ProjectionCandidateInputV1[]): ProjectorResultV1 {
  return runProjector(candidates, {
    namespace: 'non_rdte',
    allowedTargets: OM_PROJECTOR_TARGETS_V1,
    parentNaturalKey: (candidate) =>
      typeof candidate.values.identityNaturalKey === 'string'
        ? candidate.values.identityNaturalKey
        : null,
    fundingField: (candidate) =>
      typeof candidate.values.fundingField === 'string'
        ? candidate.values.fundingField
        : candidate.target === 'OmSagYear'
          ? 'request'
          : null,
  });
}

/* ------------------------------------------------------------------ */
/* I. MILCON projector                                                 */
/* ------------------------------------------------------------------ */

export const MILCON_PROJECTOR_TARGETS_V1 = [
  'MilconProject',
  'MilconProjectYear',
  'MilconDetailFact',
] as const;

/**
 * Workstream I. MILCON identity is keyed on component, account, project code,
 * and location — **never title**. Two projects legitimately share a title, and
 * the same project number under a different component is a different project;
 * both facts are encoded in the natural key the registry declares, and a
 * Workstream B test asserts no natural key anywhere admits a title or name.
 *
 * DD1391 cost categories, scope, and schedule arrive as detail facts: the date
 * axis carries schedule and the attribute bag carries the categories, so a
 * revised DD1391 supersedes by producing a new snapshot rather than editing
 * anything in place.
 */
export function projectMilconCandidatesV1(
  candidates: ProjectionCandidateInputV1[],
): ProjectorResultV1 {
  return runProjector(candidates, {
    namespace: 'non_rdte',
    allowedTargets: MILCON_PROJECTOR_TARGETS_V1,
    parentNaturalKey: (candidate) =>
      typeof candidate.values.identityNaturalKey === 'string'
        ? candidate.values.identityNaturalKey
        : null,
    fundingField: (candidate) =>
      typeof candidate.values.fundingField === 'string'
        ? candidate.values.fundingField
        : candidate.target === 'MilconProjectYear'
          ? 'request'
          : null,
  });
}

/* ------------------------------------------------------------------ */
/* J. Congressional lifecycle projector                                */
/* ------------------------------------------------------------------ */

/**
 * The authority that publishes each stage. Exactly one per stage, by the Phase
 * 6 vocabulary — `satisfies` makes a new stage a compile error here rather than
 * a silently unmapped authority.
 *
 * This table is why an NDAA conference position cannot land in the
 * appropriations conference field: the funding field is re-derived from the
 * authority at promotion, not taken from the projection.
 */
export const STAGE_TO_AUTHORITY_V1 = {
  hasc: 'hasc_authorization',
  sasc: 'sasc_authorization',
  ndaa_conference: 'ndaa_conference_authorization',
  hac_d: 'hacd_appropriations',
  sac_d: 'sacd_appropriations',
  appropriations_conference: 'appropriations_conference',
  public_law: 'enacted_public_law',
  continuing_resolution: 'continuing_resolution',
  reprogramming: 'reprogramming',
  execution: 'execution',
} satisfies Record<StageV1, StageAuthorityV1>;

/** Binding states that may become canonical. Everything else is review data. */
const CANONICAL_BINDING_STATES = new Set(['accepted', 'not_applicable']);

/**
 * Workstream J. Promotes Phase 6 stage positions, actions, provisions,
 * enactment proofs, execution metrics, vehicle proofs, and native line
 * bindings.
 *
 * Phase 6 projections are a different shape from the Phase 4/5 candidate — they
 * carry a stage, a track, a typed money value, and a payload rather than a flat
 * values record — so this is its own adapter rather than a fourth
 * `runProjector` configuration.
 *
 * Four rules are enforced here, each of which the database also enforces
 * independently:
 *
 * 1. **The funding field is re-derived from the stage authority.** A projection
 *    claiming a field its authority does not own is refused, so authorization
 *    and appropriations tracks cannot cross and NDAA conference cannot populate
 *    the appropriations conference field.
 * 2. **An action carries no funding field at all.** `stage_action` maps to an
 *    entity with `fieldAuthority: not_applicable`, so an action amount is
 *    structurally incapable of being promoted as an absolute position.
 * 3. **An enacted position requires its enactment proof.**
 * 4. **A continuing resolution cannot become a full-year enacted line** unless
 *    the source granted explicit line authority. Phase 6 records that as
 *    `payload.explicitLineAuthority`; carrying it forward is what stops a CR
 *    from silently becoming the enacted position for the year.
 */
export function projectPhase6ProjectionsV1(
  projections: Phase6NativeProjectionV1[],
): ProjectorResultV1 {
  const out: PromotionProjectionInputV1[] = [];
  const refusals: ProjectorRefusalRecordV1[] = [];

  for (const projection of projections) {
    const refuse = (reason: ProjectorRefusalV1, detail: string): void => {
      refusals.push({
        candidateId: projection.projectionId,
        target: projection.projectionKind,
        naturalKey: projection.naturalKey,
        reason,
        detail,
      });
    };

    // Only a verified projection is promotable. `candidate` and `blocked` are
    // review data; `superseded` has been replaced by a later projection.
    if (projection.projectionStatus !== 'verified') {
      refuse(
        'projection_not_verified',
        `projection status is "${projection.projectionStatus}", not verified`,
      );
      continue;
    }

    if (!CANONICAL_BINDING_STATES.has(projection.bindingStatus)) {
      refuse(
        'binding_not_accepted',
        `binding status "${projection.bindingStatus}" is review data, not canonical truth`,
      );
      continue;
    }

    const projectionKind = `phase6:${projection.projectionKind}`;
    const lookup = lookupCanonicalMappingV1(projectionKind);
    if (!lookup.supported) {
      refuse('unsupported_target', lookup.detail);
      continue;
    }
    const entry = lookup.entry;

    const fundingField = (projection.fundingField ?? null) as FundingFieldV1 | null;
    const authority = STAGE_TO_AUTHORITY_V1[projection.stage];
    const fieldCheck = validateFundingFieldForMappingV1(entry, fundingField, authority);
    if (!fieldCheck.supported) {
      refuse('stage_authority_violation', fieldCheck.detail);
      continue;
    }

    if (
      projection.stage === 'continuing_resolution' &&
      projection.payload.explicitLineAuthority !== true
    ) {
      refuse(
        'continuing_resolution_without_line_authority',
        'a continuing resolution may not become a line-level enacted position without explicit line authority',
      );
      continue;
    }

    if (
      entry.requiresEnactmentProof &&
      fundingField === 'enacted' &&
      (projection.enactmentProofId == null || projection.enactmentProofId === '')
    ) {
      refuse('enactment_proof_absent', 'an enacted position requires its enactment proof');
      continue;
    }

    const money = projection.money ?? null;
    if (money != null && !entry.valueAxes.includes('money')) {
      refuse(
        'money_required_but_absent',
        `${entry.canonicalEntity} carries no money axis but the projection supplied a money value`,
      );
      continue;
    }
    if (entry.canonicalEntity === 'canonical_stage_position' && money == null) {
      refuse('money_required_but_absent', 'a stage position must carry money');
      continue;
    }

    const payload = projection.payload;
    const fiscalYear = typeof payload.fiscalYear === 'number' ? payload.fiscalYear : null;

    // The payload minus the keys already promoted to typed axes.
    const attributes: Record<string, string | boolean | null> = {};
    for (const key of Object.keys(payload).sort(compareBytes)) {
      if (PHASE6_CONSUMED_PAYLOAD_KEYS.has(key)) continue;
      const value = payload[key];
      if (value === undefined) continue;
      attributes[key] = typeof value === 'number' ? String(value) : value;
    }
    // Track and stage are canonical facts about the row, not incidental payload.
    attributes.track = projection.track;
    attributes.stage = projection.stage;
    attributes.stageAuthority = authority;

    out.push({
      projectionId: projection.projectionId,
      projectionHash: projection.artifactContentSha256,
      projectionKind,
      naturalKey: projection.naturalKey,
      parentNaturalKey: null,
      fiscalYear,
      fundingField,
      stageAuthority: authority,
      stage: projection.stage,
      bindingStatus: 'accepted',
      enactmentProofId: projection.enactmentProofId ?? null,
      directOrDerived: projection.directOrDerived,
      values: {
        money,
        quantity: null,
        unitCostDollars: null,
        textValue: typeof payload.narrative === 'string' ? payload.narrative : null,
        dateValue: typeof payload.asOfDate === 'string' ? payload.asOfDate : null,
        attributes,
      },
      lineage: {
        sourceAssertionId: projection.projectionId,
        evidenceIds: [...projection.evidenceIds].sort(compareBytes),
        artifactId: projection.artifactId,
        artifactContentSha256: projection.artifactContentSha256,
        verificationCandidateId: projection.verificationCandidateId,
        verificationRunId: projection.verificationRunId,
        sourceDocumentId: projection.sourceDocumentId,
        sourcePdfSha256: projection.sourcePdfSha256,
      },
    });
  }

  out.sort((a, b) => compareBytes(a.naturalKey, b.naturalKey));
  refusals.sort((a, b) => compareBytes(a.naturalKey, b.naturalKey));
  return { projections: out, refusals };
}

/** Payload keys already carried on a typed axis; not repeated as attributes. */
const PHASE6_CONSUMED_PAYLOAD_KEYS = new Set(['fiscalYear', 'narrative', 'asOfDate']);

/** Byte-wise ordering, so output order cannot depend on ICU data. */
function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* FGH4. Aggregation — detail rows never double count                  */
/* ------------------------------------------------------------------ */

/**
 * Sum the funding positions of a projected set, as a product total would.
 *
 * Only position entities contribute. Detail facts and distribution lines carry
 * money too — a P-5 line or an OP-5 change driver is a real dollar figure — but
 * they are components of a position, not positions themselves. Including them
 * is exactly the double count Workstream H's acceptance criteria forbid, so the
 * filter is the position-entity predicate rather than "has a money axis".
 *
 * The sum is computed on decimal strings by integer arithmetic on scaled
 * values, never with floating point.
 */
export function sumPositionMillionsV1(projections: PromotionProjectionInputV1[]): string {
  let scaledTotal = 0n;
  const SCALE = 9;

  for (const projection of projections) {
    const lookup = lookupCanonicalMappingV1(projection.projectionKind);
    if (!lookup.supported) continue;
    if (!isPositionEntity(lookup.entry.canonicalEntity)) continue;
    const money = projection.values.money;
    if (money == null) continue;
    scaledTotal += scaleDecimalToBigInt(money.valueMillions, SCALE);
  }

  return bigIntToDecimalString(scaledTotal, SCALE);
}

function scaleDecimalToBigInt(value: string, scale: number): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  const padded = (fracPart + '0'.repeat(scale)).slice(0, scale);
  const magnitude = BigInt(intPart + padded);
  return negative ? -magnitude : magnitude;
}

function bigIntToDecimalString(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale).replace(/0+$/, '');
  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative && body !== '0' ? `-${body}` : body;
}
