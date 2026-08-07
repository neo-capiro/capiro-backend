/**
 * Phase 7 Workstream B — `defense_budget_canonical_mapping_registry_v1`.
 *
 * The complete, versioned routing table from "a projection kind Phases 4–6
 * already decided" to "exactly one canonical destination Phase 7 may write".
 *
 * The governing rule of this workstream is that **Phase 7 makes no source
 * semantic decisions**. Every judgement about what a number means — which
 * exhibit it came from, which authority owns it, whether it is direct or
 * derived, whether a line is base or advance procurement — was made and
 * verified upstream. This registry only says where an already-decided fact
 * lands. Accordingly there is no inference here from titles, names, or
 * magnitudes: a mapping is a literal table entry keyed by the projection kind,
 * and a projection kind that is absent from the table **blocks the promotion**
 * rather than being dropped or guessed at.
 *
 * Three separate upstream unions feed this table, so the keys are namespaced by
 * the phase that owns them:
 *
 * ```text
 *   rdte:<RdteProjectionTargetV1>            Phase 4  (11 kinds)
 *   non_rdte:<NonRdteProjectionTargetV1>     Phase 5  (12 kinds)
 *   phase6:<Phase6ProjectionKindV1>          Phase 6  ( 7 kinds)
 * ```
 *
 * Exhaustiveness is enforced twice. At compile time the registry is declared
 * `satisfies Record<CanonicalProjectionKindV1, …>`, so adding a member to any
 * upstream union breaks the build until it is mapped. At run time
 * `assertMappingRegistryExhaustiveV1` re-derives the key set from the three
 * source unions, which catches a union member that was added and then mapped to
 * a stale or duplicated key. That pair is what stops a new projection kind from
 * silently going unmapped.
 *
 * Money never becomes a JavaScript `number` anywhere in this module. Monetary
 * axes are described, not computed: the exact original decimal string, the
 * original unit, and the normalized millions string all travel from the
 * upstream projection unchanged.
 */
import { z } from 'zod';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import {
  FUNDING_FIELD_V1_VALUES,
  budgetFamilyV1Schema,
  fundingFieldV1Schema,
  type BudgetFamilyV1,
  type FundingFieldV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  RDTE_PROJECTION_TARGET_V1_VALUES,
  type RdteProjectionTargetV1,
} from '../rdte/projection/rdte-canonical-projection-plan-v1.js';
import {
  NON_RDTE_PROJECTION_TARGET_V1_VALUES,
  type NonRdteProjectionTargetV1,
} from '../non-rdte/non-rdte-canonical-projection-plan-v1.js';
import { PHASE6_PROJECTION_KIND_VALUES } from '../phase6/phase6-native-projection-v1.js';
import { STAGE_AUTHORITY_FIELD } from '../stages/stage-vocabulary-v1.js';

export const DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_SCHEMA_VERSION =
  'defense_budget_canonical_mapping_registry_v1' as const;

/**
 * Registry semantic version. Any change to a mapping entry — destination,
 * natural key, authority, value axes, supersession, alerting — must bump this.
 * The version and the registry hash are both bound into promotion eligibility
 * and into every promotion plan, so an altered registry invalidates outstanding
 * plans instead of silently re-routing an authorized promotion.
 */
export const DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION = '1.0.0' as const;

type Phase6ProjectionKindV1 = (typeof PHASE6_PROJECTION_KIND_VALUES)[number];

/* ------------------------------------------------------------------ */
/* B1. Namespaced projection-kind key                                  */
/* ------------------------------------------------------------------ */

export type RdteProjectionKindKeyV1 = `rdte:${RdteProjectionTargetV1}`;
export type NonRdteProjectionKindKeyV1 = `non_rdte:${NonRdteProjectionTargetV1}`;
export type Phase6ProjectionKindKeyV1 = `phase6:${Phase6ProjectionKindV1}`;

/** Every projection kind Phases 4–6 can emit, in one closed union. */
export type CanonicalProjectionKindV1 =
  | RdteProjectionKindKeyV1
  | NonRdteProjectionKindKeyV1
  | Phase6ProjectionKindKeyV1;

export const RDTE_PROJECTION_KIND_KEYS_V1 = RDTE_PROJECTION_TARGET_V1_VALUES.map(
  (target) => `rdte:${target}` as const,
);
export const NON_RDTE_PROJECTION_KIND_KEYS_V1 = NON_RDTE_PROJECTION_TARGET_V1_VALUES.map(
  (target) => `non_rdte:${target}` as const,
);
export const PHASE6_PROJECTION_KIND_KEYS_V1 = PHASE6_PROJECTION_KIND_VALUES.map(
  (kind) => `phase6:${kind}` as const,
);

/** All supported projection-kind keys, sorted for deterministic reporting. */
export const CANONICAL_PROJECTION_KIND_V1_VALUES: readonly CanonicalProjectionKindV1[] = [
  ...RDTE_PROJECTION_KIND_KEYS_V1,
  ...NON_RDTE_PROJECTION_KIND_KEYS_V1,
  ...PHASE6_PROJECTION_KIND_KEYS_V1,
].sort((a, b) => a.localeCompare(b));

/* ------------------------------------------------------------------ */
/* B2. Canonical destinations                                          */
/* ------------------------------------------------------------------ */

/**
 * The logical canonical entities a projection may land in. These are the
 * destination vocabulary of the promotion system: Workstream D gives them
 * snapshot-scoped physical storage, and Workstreams F–J are only permitted to
 * write the entity their mapping names.
 *
 * They are deliberately *not* the existing mutable `program_element*` table
 * names. Those tables are legacy write models and compatibility read models
 * (Phase 7 plan, "Existing mutable tables"); binding canonical truth to them by
 * name would re-create the identity conflation Workstreams G and H exist to
 * remove — most visibly `program_element_procurement_line`, which files a
 * procurement BLIN inside RDT&E Program Element identity space.
 */
export const CANONICAL_ENTITY_V1_VALUES = [
  /* RDT&E (Phase 4) */
  'canonical_rdte_program_element',
  'canonical_rdte_program_element_year',
  'canonical_rdte_budget_position',
  'canonical_rdte_project',
  'canonical_rdte_project_budget_position',
  'canonical_rdte_performer',
  'canonical_rdte_milestone',
  'canonical_rdte_milestone_schedule_period',
  'canonical_rdte_project_milestone',
  'canonical_rdte_project_milestone_schedule_period',

  /* Procurement (Phase 5) */
  'canonical_procurement_budget_line',
  'canonical_procurement_budget_line_year',
  'canonical_procurement_distribution_line',
  'canonical_procurement_detail_fact',

  /* O&M (Phase 5) */
  'canonical_om_sag',
  'canonical_om_sag_year',
  'canonical_om_detail_fact',

  /* MILCON (Phase 5) */
  'canonical_milcon_project',
  'canonical_milcon_project_year',
  'canonical_milcon_detail_fact',

  /* Cross-family (Phase 4 + Phase 5) */
  'canonical_budget_line_source_observation',
  'canonical_budget_line_relationship',

  /* Congressional lifecycle (Phase 6) */
  'canonical_stage_position',
  'canonical_stage_action',
  'canonical_provision_link',
  'canonical_enactment_proof',
  'canonical_post_enactment_metric',
  'canonical_vehicle_proof',
  'canonical_native_line_binding',
] as const;
export const canonicalEntityV1Schema = z.enum(CANONICAL_ENTITY_V1_VALUES);
export type CanonicalEntityV1 = z.infer<typeof canonicalEntityV1Schema>;

/**
 * Structural parent of each canonical entity, or `null` when the entity stands
 * alone. A year, detail, distribution, or schedule row is meaningless without
 * the identity it hangs from, so the planner treats a missing parent as a
 * blocking dependency rather than promoting an orphan whose natural key points
 * at nothing.
 *
 * Declared once here rather than per mapping entry because the relationship is
 * a property of the destination, not of the projection kind that reaches it —
 * `rdte:ProgramElementSource` and `non_rdte:BudgetLineSourceObservation` land in
 * the same entity and must agree about its parent.
 */
export const CANONICAL_ENTITY_PARENT_V1 = {
  canonical_rdte_program_element: null,
  canonical_rdte_program_element_year: 'canonical_rdte_program_element',
  canonical_rdte_budget_position: 'canonical_rdte_program_element',
  canonical_rdte_project: 'canonical_rdte_program_element',
  canonical_rdte_project_budget_position: 'canonical_rdte_project',
  canonical_rdte_performer: 'canonical_rdte_program_element',
  canonical_rdte_milestone: 'canonical_rdte_program_element',
  canonical_rdte_milestone_schedule_period: 'canonical_rdte_milestone',
  canonical_rdte_project_milestone: 'canonical_rdte_project',
  canonical_rdte_project_milestone_schedule_period: 'canonical_rdte_project_milestone',

  canonical_procurement_budget_line: null,
  canonical_procurement_budget_line_year: 'canonical_procurement_budget_line',
  canonical_procurement_distribution_line: 'canonical_procurement_budget_line',
  canonical_procurement_detail_fact: 'canonical_procurement_budget_line',

  canonical_om_sag: null,
  canonical_om_sag_year: 'canonical_om_sag',
  canonical_om_detail_fact: 'canonical_om_sag',

  canonical_milcon_project: null,
  canonical_milcon_project_year: 'canonical_milcon_project',
  canonical_milcon_detail_fact: 'canonical_milcon_project',

  /* Observations and relationships reference identities across families by
   * natural key rather than hanging from one parent, so they stand alone. */
  canonical_budget_line_source_observation: null,
  canonical_budget_line_relationship: null,

  /* Phase 6 rows bind to a native identity by hash, which may live in any
   * family, so the dependency is checked by binding rather than by parent. */
  canonical_stage_position: null,
  canonical_stage_action: null,
  canonical_provision_link: null,
  canonical_enactment_proof: null,
  canonical_post_enactment_metric: null,
  canonical_vehicle_proof: null,
  canonical_native_line_binding: null,
} satisfies Record<CanonicalEntityV1, CanonicalEntityV1 | null>;

/** Structural parent of a canonical entity, or `null` when it stands alone. */
export function parentEntityOfV1(entity: CanonicalEntityV1): CanonicalEntityV1 | null {
  return CANONICAL_ENTITY_PARENT_V1[entity];
}

/* ------------------------------------------------------------------ */
/* B3. Value axes — money and quantity are never the same type         */
/* ------------------------------------------------------------------ */

/**
 * The typed axes a canonical row may carry. `money` and `quantity` are separate
 * members precisely so a promoted procurement row cannot silently treat a unit
 * count as dollars (Phase 7 plan G.5), and `unit_cost` is separate again
 * because it is denominated in dollars rather than the millions used for
 * position money.
 */
export const CANONICAL_VALUE_AXIS_V1_VALUES = [
  'money',
  'quantity',
  'unit_cost',
  'text',
  'date',
  'identity',
] as const;
export const canonicalValueAxisV1Schema = z.enum(CANONICAL_VALUE_AXIS_V1_VALUES);
export type CanonicalValueAxisV1 = z.infer<typeof canonicalValueAxisV1Schema>;

/**
 * How a monetary axis is carried into canonical storage. There is exactly one
 * supported rule and it is a preservation rule, not a conversion rule: the
 * upstream projection already produced the exact original decimal string, the
 * original unit, and the normalized millions string, and promotion copies all
 * three unchanged. `none` marks an entity that carries no money at all.
 */
export const MONEY_RULE_V1_VALUES = ['preserve_original_and_millions', 'none'] as const;
export const moneyRuleV1Schema = z.enum(MONEY_RULE_V1_VALUES);
export type MoneyRuleV1 = z.infer<typeof moneyRuleV1Schema>;

/* ------------------------------------------------------------------ */
/* B3a. Lineage every promoted row must preserve                       */
/* ------------------------------------------------------------------ */

/**
 * The provenance a canonical row carries regardless of which entity it lands
 * in (Phase 7 plan B.4). Promotion copies these from the upstream projection;
 * it never recomputes or re-derives them.
 *
 * `originalValue` / `originalUnit` / `valueMillions` are the three-part exact
 * money representation established in Phase 1 — the printed decimal string, the
 * unit it was printed in, and the normalized millions string. All three are
 * strings. There is no code path in promotion that turns any of them into a
 * JavaScript number, because binary floating point cannot represent decimal
 * money exactly and a rounded cent in a budget position is a data defect.
 *
 * `directOrDerived` records whether the source stated the value outright or a
 * verified rule computed it, so a derived total is never later cited as a
 * printed figure.
 */
export const CANONICAL_LINEAGE_FIELDS_V1 = [
  'sourceProjectionId',
  'sourceAssertionId',
  'evidenceIds',
  'artifactId',
  'artifactContentSha256',
  'verificationCandidateId',
  'verificationRunId',
  'sourceDocumentId',
  'sourcePdfSha256',
  'directOrDerived',
] as const;
export type CanonicalLineageFieldV1 = (typeof CANONICAL_LINEAGE_FIELDS_V1)[number];

/** The money triple, carried only by entities whose axes include `money`. */
export const CANONICAL_MONEY_FIELDS_V1 = [
  'originalValue',
  'originalUnit',
  'valueMillions',
] as const;
export type CanonicalMoneyFieldV1 = (typeof CANONICAL_MONEY_FIELDS_V1)[number];

/**
 * The exact set of lineage fields a row for this mapping must carry. Money
 * entities additionally carry the money triple; everything else does not, so a
 * narrative row cannot acquire an empty `valueMillions` that later reads as
 * zero dollars.
 */
export function requiredLineageFieldsForV1(entry: CanonicalMappingEntryV1): string[] {
  const fields: string[] = [...CANONICAL_LINEAGE_FIELDS_V1];
  if (entry.moneyRule === 'preserve_original_and_millions') {
    fields.push(...CANONICAL_MONEY_FIELDS_V1);
  }
  return fields.sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------ */
/* B4. Field authority                                                 */
/* ------------------------------------------------------------------ */

/**
 * Which funding field a mapping is allowed to populate, and where that decision
 * comes from.
 *
 * - `stage_authority` — the field is a pure function of the stage authority via
 *   `STAGE_AUTHORITY_FIELD`. Promotion re-derives it and refuses a projection
 *   whose field disagrees, which is what keeps NDAA conference out of the
 *   appropriations conference field.
 * - `projection_funding_field` — the upstream projection carries the field and
 *   promotion restricts it to `allowedFields`.
 * - `not_applicable` — identity, narrative, provenance, and relationship rows
 *   own no funding field and must never populate one.
 */
export const FIELD_AUTHORITY_MODE_V1_VALUES = [
  'stage_authority',
  'projection_funding_field',
  'not_applicable',
] as const;
export const fieldAuthorityModeV1Schema = z.enum(FIELD_AUTHORITY_MODE_V1_VALUES);
export type FieldAuthorityModeV1 = z.infer<typeof fieldAuthorityModeV1Schema>;

export const fieldAuthorityV1Schema = z
  .object({
    mode: fieldAuthorityModeV1Schema,
    allowedFields: z.array(fundingFieldV1Schema).default([]),
  })
  .strict();
export type FieldAuthorityV1 = z.infer<typeof fieldAuthorityV1Schema>;

/* ------------------------------------------------------------------ */
/* B5. Supersession, compatibility, alerting                           */
/* ------------------------------------------------------------------ */

/**
 * How a later snapshot relates to the same natural key in an earlier one.
 * Nothing here mutates an active row: every mode describes what the *new*
 * snapshot contains, because corrections arrive by promoting a new snapshot.
 */
export const SUPERSESSION_MODE_V1_VALUES = [
  /** One row per natural key per snapshot; the new snapshot's row wins. */
  'replace_by_natural_key',
  /** Identity rows carry forward unchanged unless the identity itself changed. */
  'carry_forward_identity',
  /** Append-only evidence: every observation is retained, never replaced. */
  'append_only_observation',
] as const;
export const supersessionModeV1Schema = z.enum(SUPERSESSION_MODE_V1_VALUES);
export type SupersessionModeV1 = z.infer<typeof supersessionModeV1Schema>;

/**
 * What the compatibility layer must do for callers still reading the legacy
 * mutable tables. Workstream M implements these; the registry only declares the
 * obligation so that no family can quietly acquire or lose a compatibility
 * surface.
 */
export const COMPATIBILITY_MODE_V1_VALUES = [
  /** Rebuild the corresponding legacy `program_element*` projection. */
  'project_to_legacy_pe',
  /** Serve through the Budget Lines compatibility reads without identity change. */
  'project_to_budget_lines',
  /** Canonical-only; no legacy surface exists or should be created. */
  'none',
] as const;
export const compatibilityModeV1Schema = z.enum(COMPATIBILITY_MODE_V1_VALUES);
export type CompatibilityModeV1 = z.infer<typeof compatibilityModeV1Schema>;

/**
 * Delta and alert classification for the entity. `alertEligible` is an upper
 * bound only: Workstream C still classifies each individual plan item, and
 * hydration, corrections, and rollback suppress alerts regardless of what this
 * says. An entity that is not alert-eligible can never notify a client no
 * matter how the plan classifies the item.
 */
export const ALERT_CLASS_V1_VALUES = [
  'money_position',
  'quantity_position',
  'identity',
  'detail',
  'provenance',
  'relationship',
  'proof',
] as const;
export const alertClassV1Schema = z.enum(ALERT_CLASS_V1_VALUES);
export type AlertClassV1 = z.infer<typeof alertClassV1Schema>;

/* ------------------------------------------------------------------ */
/* B6. Mapping entry                                                   */
/* ------------------------------------------------------------------ */

export const canonicalMappingEntryV1Schema = z
  .object({
    /** Namespaced projection kind this entry maps. */
    projectionKind: z.string().min(1),
    /** The single canonical destination. Exactly one, always. */
    canonicalEntity: canonicalEntityV1Schema,
    /** Budget family the destination belongs to, for scope checks. */
    family: budgetFamilyV1Schema,
    /**
     * Ordered natural-key components. Promotion builds the canonical natural
     * key from exactly these fields of the upstream projection, in this order,
     * so the same fact always produces the same key.
     */
    naturalKeyFields: z.array(z.string().min(1)).min(1),
    /** Snapshot-scoped rows are versioned per snapshot and immutable once active. */
    snapshotScoped: z.literal(true),
    /** Where the supporting source observation for this row is written. */
    sourceObservationEntity: canonicalEntityV1Schema.nullable(),
    moneyRule: moneyRuleV1Schema,
    valueAxes: z.array(canonicalValueAxisV1Schema).min(1),
    fieldAuthority: fieldAuthorityV1Schema,
    supersession: supersessionModeV1Schema,
    compatibility: compatibilityModeV1Schema,
    alertClass: alertClassV1Schema,
    alertEligible: z.boolean(),
    deltaEligible: z.boolean(),
    /** Enacted positions may not be promoted without their enactment proof. */
    requiresEnactmentProof: z.boolean(),
    notes: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const carriesMoney = value.valueAxes.includes('money');
    if (carriesMoney !== (value.moneyRule === 'preserve_original_and_millions')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an entry carries the money axis if and only if its money rule preserves original + millions',
        path: ['moneyRule'],
      });
    }
    if (
      value.fieldAuthority.mode === 'not_applicable' &&
      value.fieldAuthority.allowedFields.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an entry with no field authority may not enumerate allowed funding fields',
        path: ['fieldAuthority', 'allowedFields'],
      });
    }
    if (
      value.fieldAuthority.mode === 'projection_funding_field' &&
      value.fieldAuthority.allowedFields.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'projection-supplied funding fields must be restricted to an explicit allowed set',
        path: ['fieldAuthority', 'allowedFields'],
      });
    }
    if (value.alertEligible && !value.deltaEligible) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an alert-eligible entity must also be delta-eligible; alerts are derived from deltas',
        path: ['alertEligible'],
      });
    }
  });
export type CanonicalMappingEntryV1 = z.infer<typeof canonicalMappingEntryV1Schema>;

/** Input shape before parse — keeps the table below readable. */
type MappingEntryInput = Omit<CanonicalMappingEntryV1, 'projectionKind'>;

const NO_FIELD_AUTHORITY: FieldAuthorityV1 = { mode: 'not_applicable', allowedFields: [] };

/** Funding fields a Phase 4/5 request-side position may own. */
const REQUEST_SIDE_FIELDS: readonly FundingFieldV1[] = ['request'];

/** Every funding field, for stage positions whose field is authority-derived. */
const ALL_STAGE_FIELDS: readonly FundingFieldV1[] = FUNDING_FIELD_V1_VALUES;

/* ------------------------------------------------------------------ */
/* B7. The registry                                                    */
/* ------------------------------------------------------------------ */

/**
 * The mapping table. One entry per projection kind, no exceptions and no
 * fallbacks — `satisfies` below makes an unmapped kind a compile error.
 */
const REGISTRY_ENTRIES = {
  /* ---------------- RDT&E — Phase 4 ---------------- */

  'rdte:ProgramElement': {
    canonicalEntity: 'canonical_rdte_program_element',
    family: 'rdte',
    naturalKeyFields: ['peCode'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'carry_forward_identity',
    compatibility: 'project_to_legacy_pe',
    alertClass: 'identity',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes: 'RDT&E Program Element identity. Identity changes are deltas but never client alerts.',
  },
  'rdte:ProgramElementYear': {
    canonicalEntity: 'canonical_rdte_program_element_year',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'fiscalYear'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money'],
    fieldAuthority: { mode: 'projection_funding_field', allowedFields: [...ALL_STAGE_FIELDS] },
    supersession: 'replace_by_natural_key',
    compatibility: 'project_to_legacy_pe',
    alertClass: 'money_position',
    alertEligible: true,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Per-FY union of PE funding across fields. The enacted field on this row is only reachable through a Phase 6 stage position that carried its own enactment proof.',
  },
  'rdte:ProgramElementBudgetPosition': {
    canonicalEntity: 'canonical_rdte_budget_position',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'positionCycle', 'assertedFy', 'valueKind'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money'],
    fieldAuthority: { mode: 'projection_funding_field', allowedFields: [...REQUEST_SIDE_FIELDS] },
    supersession: 'replace_by_natural_key',
    compatibility: 'project_to_legacy_pe',
    alertClass: 'money_position',
    alertEligible: true,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Request and FYDP outyear positions scoped to a PB cycle. Outyear FYDP values are request-side by Phase 4 policy; congressional marks arrive as Phase 6 stage positions instead.',
  },
  'rdte:ProgramElementProject': {
    canonicalEntity: 'canonical_rdte_project',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'projectCode'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'carry_forward_identity',
    compatibility: 'project_to_legacy_pe',
    alertClass: 'identity',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'R-2A project identity. Project codes are scoped to the parent PE and are never globally unique on their own.',
  },
  'rdte:ProgramElementProjectBudgetPosition': {
    canonicalEntity: 'canonical_rdte_project_budget_position',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'projectCode', 'positionCycle', 'assertedFy', 'valueKind'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money', 'quantity'],
    fieldAuthority: { mode: 'projection_funding_field', allowedFields: [...REQUEST_SIDE_FIELDS] },
    supersession: 'replace_by_natural_key',
    compatibility: 'project_to_legacy_pe',
    alertClass: 'money_position',
    alertEligible: true,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'R-2A project-year funding. Carries an optional quantity axis distinct from money; the two are never interchanged.',
  },
  'rdte:ProgramElementPerformer': {
    canonicalEntity: 'canonical_rdte_performer',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'projectCode', 'performerName', 'performerRole'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'project_to_legacy_pe',
    alertClass: 'identity',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'R-3 performers. The verified role classification is part of the natural key so a performing activity can never be relabelled as a prime contractor by promotion.',
  },
  'rdte:ProgramElementMilestone': {
    canonicalEntity: 'canonical_rdte_milestone',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'milestoneType'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'date', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'project_to_legacy_pe',
    alertClass: 'detail',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'R-4 PE-level milestone. Planned, actual, and as-of semantics are preserved as typed dates.',
  },
  'rdte:ProgramElementMilestoneSchedulePeriod': {
    canonicalEntity: 'canonical_rdte_milestone_schedule_period',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'milestoneType', 'periodRole', 'rawText'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['date', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'detail',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Resolved schedule period for a PE milestone. `rawText` stays in the key because two periods may resolve to the same quarter from different printed text.',
  },
  'rdte:ProgramElementProjectMilestone': {
    canonicalEntity: 'canonical_rdte_project_milestone',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'projectCode', 'milestoneType'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'date', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'detail',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes: 'R-4 project-level milestone, scoped to the parent PE and project.',
  },
  'rdte:ProgramElementProjectMilestoneSchedulePeriod': {
    canonicalEntity: 'canonical_rdte_project_milestone_schedule_period',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'projectCode', 'milestoneType', 'periodRole', 'rawText'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['date', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'detail',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes: 'Resolved schedule period for a project milestone.',
  },
  'rdte:ProgramElementSource': {
    canonicalEntity: 'canonical_budget_line_source_observation',
    family: 'rdte',
    naturalKeyFields: ['peCode', 'sourceDocumentId', 'assertionId'],
    snapshotScoped: true,
    sourceObservationEntity: null,
    moneyRule: 'none',
    valueAxes: ['identity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'append_only_observation',
    compatibility: 'project_to_legacy_pe',
    alertClass: 'provenance',
    alertEligible: false,
    deltaEligible: false,
    requiresEnactmentProof: false,
    notes:
      'RDT&E source observation. Observations are evidence, not positions: they append, never supersede, and never alert or produce deltas.',
  },

  /* ---------------- Procurement — Phase 5 ---------------- */

  'non_rdte:ProcurementBudgetLine': {
    canonicalEntity: 'canonical_procurement_budget_line',
    family: 'procurement',
    naturalKeyFields: ['component', 'account', 'lineCode', 'advanceProcurement'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'carry_forward_identity',
    compatibility: 'project_to_budget_lines',
    alertClass: 'identity',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Native procurement BLIN identity. `advanceProcurement` is a key component so base and AP lines stay distinct, and the account namespace is required because short line numbers repeat across accounts. This is never an RDT&E Program Element.',
  },
  'non_rdte:ProcurementBudgetLineYear': {
    canonicalEntity: 'canonical_procurement_budget_line_year',
    family: 'procurement',
    naturalKeyFields: [
      'component',
      'account',
      'lineCode',
      'advanceProcurement',
      'fiscalYear',
      'fundingField',
    ],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money', 'quantity'],
    fieldAuthority: { mode: 'projection_funding_field', allowedFields: [...ALL_STAGE_FIELDS] },
    supersession: 'replace_by_natural_key',
    compatibility: 'project_to_budget_lines',
    alertClass: 'money_position',
    alertEligible: true,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Procurement yearly funding with a quantity axis kept separate from money. Quantity is a count, never a dollar amount.',
  },
  'non_rdte:ProcurementDistributionLine': {
    canonicalEntity: 'canonical_procurement_distribution_line',
    family: 'procurement',
    naturalKeyFields: [
      'component',
      'account',
      'lineCode',
      'advanceProcurement',
      'fiscalYear',
      'distributionKey',
    ],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money', 'quantity', 'unit_cost', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'detail',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'P-5/P-21 distribution lines. Unit cost is dollars, not millions, and is carried on its own axis so it can never be summed into a position total.',
  },
  'non_rdte:ProcurementDetailFact': {
    canonicalEntity: 'canonical_procurement_detail_fact',
    family: 'procurement',
    naturalKeyFields: [
      'component',
      'account',
      'lineCode',
      'advanceProcurement',
      'fiscalYear',
      'factKind',
      'factKey',
    ],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money', 'quantity', 'unit_cost', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'detail',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'P-40 resource summary and P-5/P-5A/P-21/P-3A detail facts. Detail rows are excluded from account roll-ups so they cannot double count against summary positions.',
  },

  /* ---------------- O&M — Phase 5 ---------------- */

  'non_rdte:OmSag': {
    canonicalEntity: 'canonical_om_sag',
    family: 'om',
    naturalKeyFields: ['component', 'account', 'sagCode'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'carry_forward_identity',
    compatibility: 'project_to_budget_lines',
    alertClass: 'identity',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Native O&M SAG identity, account-scoped. BA/BAG hierarchy is preserved as attributes of this row; the same SAG code under a different account is a different line.',
  },
  'non_rdte:OmSagYear': {
    canonicalEntity: 'canonical_om_sag_year',
    family: 'om',
    naturalKeyFields: ['component', 'account', 'sagCode', 'fiscalYear', 'fundingField'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money'],
    fieldAuthority: { mode: 'projection_funding_field', allowedFields: [...ALL_STAGE_FIELDS] },
    supersession: 'replace_by_natural_key',
    compatibility: 'project_to_budget_lines',
    alertClass: 'money_position',
    alertEligible: true,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes: 'O&M yearly funding. Money only — workload metrics are detail facts, not positions.',
  },
  'non_rdte:OmDetailFact': {
    canonicalEntity: 'canonical_om_detail_fact',
    family: 'om',
    naturalKeyFields: ['component', 'account', 'sagCode', 'fiscalYear', 'factKind', 'factKey'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money', 'quantity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'detail',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'OP-5 detail: workload metrics, change drivers, and narratives. The quantity axis carries workload counts and the text axis carries narrative; neither is money.',
  },

  /* ---------------- MILCON — Phase 5 ---------------- */

  'non_rdte:MilconProject': {
    canonicalEntity: 'canonical_milcon_project',
    family: 'milcon',
    naturalKeyFields: ['component', 'account', 'projectCode', 'location'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'carry_forward_identity',
    compatibility: 'project_to_budget_lines',
    alertClass: 'identity',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Native MILCON project identity keyed on project code and location, never on title. Two projects may share a title; the same project number under a different component is a different project.',
  },
  'non_rdte:MilconProjectYear': {
    canonicalEntity: 'canonical_milcon_project_year',
    family: 'milcon',
    naturalKeyFields: [
      'component',
      'account',
      'projectCode',
      'location',
      'fiscalYear',
      'fundingType',
    ],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money'],
    fieldAuthority: { mode: 'projection_funding_field', allowedFields: [...ALL_STAGE_FIELDS] },
    supersession: 'replace_by_natural_key',
    compatibility: 'project_to_budget_lines',
    alertClass: 'money_position',
    alertEligible: true,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'MILCON yearly authorization/appropriation/request/enacted position. `fundingType` distinguishes the MILCON-specific position kinds preserved by Phase 5.',
  },
  'non_rdte:MilconDetailFact': {
    canonicalEntity: 'canonical_milcon_detail_fact',
    family: 'milcon',
    naturalKeyFields: [
      'component',
      'account',
      'projectCode',
      'location',
      'fiscalYear',
      'factKind',
      'factKey',
    ],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money', 'text', 'date'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'detail',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'DD1391 cost categories, scope, schedule, and justification as typed child facts of the project.',
  },

  /* ---------------- Cross-family — Phase 5 ---------------- */

  'non_rdte:BudgetLineSourceObservation': {
    canonicalEntity: 'canonical_budget_line_source_observation',
    family: 'unknown',
    naturalKeyFields: ['identityNaturalKey', 'sourceDocumentId', 'assertionId'],
    snapshotScoped: true,
    sourceObservationEntity: null,
    moneyRule: 'none',
    valueAxes: ['identity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'append_only_observation',
    compatibility: 'none',
    alertClass: 'provenance',
    alertEligible: false,
    deltaEligible: false,
    requiresEnactmentProof: false,
    notes:
      'Non-RDT&E source observation. Family is `unknown` because the row is keyed by the identity it observes and spans procurement, O&M, and MILCON. Physical model is `NonRdteBudgetLineSourceObservation`.',
  },
  'non_rdte:BudgetLineRelationship': {
    canonicalEntity: 'canonical_budget_line_relationship',
    family: 'unknown',
    naturalKeyFields: ['fromNaturalKey', 'toNaturalKey', 'relationshipType', 'sourceDocumentId'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'relationship',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Typed cross-line relationships, including procurement PE cross-references. A relationship is a link, never a funding position, so it can never contribute to a total. Physical model is `NonRdteBudgetLineRelationship`.',
  },

  /* ---------------- Congressional lifecycle — Phase 6 ---------------- */

  'phase6:stage_position': {
    canonicalEntity: 'canonical_stage_position',
    family: 'unknown',
    naturalKeyFields: ['nativeIdentityHash', 'fiscalYear', 'stage', 'fundingField'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money'],
    fieldAuthority: { mode: 'stage_authority', allowedFields: [...ALL_STAGE_FIELDS] },
    supersession: 'replace_by_natural_key',
    compatibility: 'project_to_legacy_pe',
    alertClass: 'money_position',
    alertEligible: true,
    deltaEligible: true,
    requiresEnactmentProof: true,
    notes:
      'A funding position at one lifecycle stage against one native identity. The field is re-derived from the stage authority at promotion, so authorization and appropriations tracks cannot cross and NDAA conference cannot populate the appropriations conference field. Enacted positions require their enactment proof.',
  },
  'phase6:stage_action': {
    canonicalEntity: 'canonical_stage_action',
    family: 'unknown',
    naturalKeyFields: ['nativeIdentityHash', 'fiscalYear', 'stage', 'actionType', 'actionKey'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'money_position',
    alertEligible: true,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Typed increase/decrease, transfer, rescission, realignment, undistributed adjustment, and directive actions. An action amount is a delta against a position and is deliberately given no funding field, which is what stops it being promoted as an absolute position.',
  },
  'phase6:provision_link': {
    canonicalEntity: 'canonical_provision_link',
    family: 'unknown',
    naturalKeyFields: ['nativeIdentityHash', 'provisionId', 'linkType'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'text'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'relationship',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Provisions and directives linked to a native line. Only accepted exact links are promotable; candidate and conflicting links stay noncanonical review data and are blocked by the planner.',
  },
  'phase6:enactment_proof': {
    canonicalEntity: 'canonical_enactment_proof',
    family: 'public_law',
    naturalKeyFields: ['enactmentProofId'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity', 'text', 'date'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'append_only_observation',
    compatibility: 'none',
    alertClass: 'proof',
    alertEligible: false,
    deltaEligible: false,
    requiresEnactmentProof: false,
    notes:
      'Public-law enactment proof. Append-only: a proof is a historical fact about a statute and is never replaced. Enacted stage positions reference it.',
  },
  'phase6:post_enactment_metric': {
    canonicalEntity: 'canonical_post_enactment_metric',
    family: 'unknown',
    naturalKeyFields: ['nativeIdentityHash', 'fiscalYear', 'executionMetric', 'asOfDate'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'preserve_original_and_millions',
    valueAxes: ['money', 'date'],
    fieldAuthority: { mode: 'stage_authority', allowedFields: ['executed', 'reprogrammed'] },
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'money_position',
    alertEligible: true,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Execution and reprogramming metrics. The as-of date is part of the key so obligations at two dates are two facts, and the metric name is preserved so obligations are never conflated with outlays.',
  },
  'phase6:vehicle_proof': {
    canonicalEntity: 'canonical_vehicle_proof',
    family: 'unknown',
    naturalKeyFields: ['vehicleId', 'sourceDocumentId'],
    snapshotScoped: true,
    sourceObservationEntity: null,
    moneyRule: 'none',
    valueAxes: ['identity', 'text', 'date'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'append_only_observation',
    compatibility: 'none',
    alertClass: 'proof',
    alertEligible: false,
    deltaEligible: false,
    requiresEnactmentProof: false,
    notes:
      'Proof that a legislative vehicle (committee report, conference report, public law, CR) exists and what it is. Append-only provenance.',
  },
  'phase6:native_line_binding': {
    canonicalEntity: 'canonical_native_line_binding',
    family: 'unknown',
    naturalKeyFields: ['nativeIdentityHash', 'sourceDocumentId', 'bindingKey'],
    snapshotScoped: true,
    sourceObservationEntity: 'canonical_budget_line_source_observation',
    moneyRule: 'none',
    valueAxes: ['identity'],
    fieldAuthority: NO_FIELD_AUTHORITY,
    supersession: 'replace_by_natural_key',
    compatibility: 'none',
    alertClass: 'relationship',
    alertEligible: false,
    deltaEligible: true,
    requiresEnactmentProof: false,
    notes:
      'Binding of a congressional table row to a native budget line identity. Only accepted bindings are promotable; candidate bindings are blocked so a guessed identity can never become canonical.',
  },
} satisfies Record<CanonicalProjectionKindV1, MappingEntryInput>;

/** The parsed, validated registry. Parsing at module load makes a malformed
 * entry a startup failure rather than a promotion-time surprise. */
export const DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1: Readonly<
  Record<CanonicalProjectionKindV1, CanonicalMappingEntryV1>
> = Object.freeze(
  Object.fromEntries(
    (Object.keys(REGISTRY_ENTRIES) as CanonicalProjectionKindV1[]).map((key) => [
      key,
      canonicalMappingEntryV1Schema.parse({ ...REGISTRY_ENTRIES[key], projectionKind: key }),
    ]),
  ) as Record<CanonicalProjectionKindV1, CanonicalMappingEntryV1>,
);

/* ------------------------------------------------------------------ */
/* B8. Registry identity                                               */
/* ------------------------------------------------------------------ */

/**
 * Deterministic hash over the whole registry. Entries are emitted in sorted key
 * order so the hash depends on content only, never on declaration order.
 */
export function canonicalMappingRegistryHashV1(): string {
  const ordered = [...CANONICAL_PROJECTION_KIND_V1_VALUES].map((key) => ({
    key,
    entry: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1[key],
  }));
  return sha256CanonicalJson({
    schemaVersion: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_SCHEMA_VERSION,
    version: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
    entries: ordered,
  } as unknown as JsonValue);
}

/* ------------------------------------------------------------------ */
/* B9. Lookup — unsupported kinds block, never drop                    */
/* ------------------------------------------------------------------ */

export const MAPPING_LOOKUP_REFUSAL_V1_VALUES = [
  'unsupported_projection_kind',
  'field_not_permitted_for_entity',
  'stage_authority_field_mismatch',
] as const;
export const mappingLookupRefusalV1Schema = z.enum(MAPPING_LOOKUP_REFUSAL_V1_VALUES);
export type MappingLookupRefusalV1 = z.infer<typeof mappingLookupRefusalV1Schema>;

export type MappingLookupResultV1 =
  | { supported: true; entry: CanonicalMappingEntryV1 }
  | { supported: false; reason: MappingLookupRefusalV1; detail: string };

/**
 * Resolve a projection kind to its mapping.
 *
 * Deliberately returns a refusal rather than `undefined`: an unmapped kind is a
 * blocking condition that must be surfaced and counted, and a caller that
 * pattern-matches on a discriminated result cannot accidentally treat "no
 * mapping" as "nothing to do".
 */
export function lookupCanonicalMappingV1(projectionKind: string): MappingLookupResultV1 {
  const entry = (
    DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1 as Record<
      string,
      CanonicalMappingEntryV1 | undefined
    >
  )[projectionKind];
  if (entry == null) {
    return {
      supported: false,
      reason: 'unsupported_projection_kind',
      detail: `projection kind "${projectionKind}" has no canonical mapping in registry ${DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION}`,
    };
  }
  return { supported: true, entry };
}

/**
 * Re-check that a funding field is one this mapping may populate.
 *
 * For stage-authority entries the field is re-derived from the authority rather
 * than trusted, which is the promotion-time repeat of the Phase 6 rule that an
 * authorization stage can never write an appropriations field.
 */
export function validateFundingFieldForMappingV1(
  entry: CanonicalMappingEntryV1,
  field: FundingFieldV1 | null,
  stageAuthority?: keyof typeof STAGE_AUTHORITY_FIELD,
): MappingLookupResultV1 {
  if (entry.fieldAuthority.mode === 'not_applicable') {
    if (field != null) {
      return {
        supported: false,
        reason: 'field_not_permitted_for_entity',
        detail: `${entry.canonicalEntity} owns no funding field but received "${field}"`,
      };
    }
    return { supported: true, entry };
  }

  if (field == null) {
    return {
      supported: false,
      reason: 'field_not_permitted_for_entity',
      detail: `${entry.canonicalEntity} requires a funding field but none was supplied`,
    };
  }

  if (!entry.fieldAuthority.allowedFields.includes(field)) {
    return {
      supported: false,
      reason: 'field_not_permitted_for_entity',
      detail: `${entry.canonicalEntity} may not populate "${field}"`,
    };
  }

  if (entry.fieldAuthority.mode === 'stage_authority') {
    if (stageAuthority == null) {
      return {
        supported: false,
        reason: 'stage_authority_field_mismatch',
        detail: `${entry.canonicalEntity} derives its field from the stage authority, which was not supplied`,
      };
    }
    const derived = STAGE_AUTHORITY_FIELD[stageAuthority];
    if (derived !== field) {
      return {
        supported: false,
        reason: 'stage_authority_field_mismatch',
        detail: `authority ${stageAuthority} owns "${derived}", not "${field}"`,
      };
    }
  }

  return { supported: true, entry };
}

/* ------------------------------------------------------------------ */
/* B10. Exhaustiveness                                                 */
/* ------------------------------------------------------------------ */

export interface MappingExhaustivenessReportV1 {
  totalUpstreamKinds: number;
  mappedKinds: number;
  missing: string[];
  extra: string[];
  exhaustive: boolean;
}

/**
 * Re-derive the expected key set from the three upstream unions and compare it
 * to the registry. The `satisfies` clause already makes an unmapped kind a
 * compile error; this catches the cases it cannot — a key typo that happens to
 * still satisfy the union through widening, or an entry left behind after an
 * upstream union member was removed.
 */
export function checkMappingRegistryExhaustivenessV1(): MappingExhaustivenessReportV1 {
  const expected = new Set<string>([
    ...RDTE_PROJECTION_KIND_KEYS_V1,
    ...NON_RDTE_PROJECTION_KIND_KEYS_V1,
    ...PHASE6_PROJECTION_KIND_KEYS_V1,
  ]);
  const actual = new Set<string>(Object.keys(DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1));

  const missing = [...expected]
    .filter((key) => !actual.has(key))
    .sort((a, b) => a.localeCompare(b));
  const extra = [...actual].filter((key) => !expected.has(key)).sort((a, b) => a.localeCompare(b));

  return {
    totalUpstreamKinds: expected.size,
    mappedKinds: actual.size,
    missing,
    extra,
    exhaustive: missing.length === 0 && extra.length === 0,
  };
}

/** Throwing form, for use in module init and CI gates. */
export function assertMappingRegistryExhaustiveV1(): void {
  const report = checkMappingRegistryExhaustivenessV1();
  if (report.exhaustive) return;
  const parts: string[] = [];
  if (report.missing.length > 0)
    parts.push(`unmapped projection kinds: ${report.missing.join(', ')}`);
  if (report.extra.length > 0)
    parts.push(`registry entries with no upstream kind: ${report.extra.join(', ')}`);
  throw new Error(`canonical mapping registry is not exhaustive — ${parts.join('; ')}`);
}

/* ------------------------------------------------------------------ */
/* B11. Mapping report (generated in CI)                               */
/* ------------------------------------------------------------------ */

export interface MappingReportRowV1 {
  projectionKind: CanonicalProjectionKindV1;
  canonicalEntity: CanonicalEntityV1;
  family: BudgetFamilyV1;
  naturalKey: string;
  valueAxes: string;
  fieldAuthority: string;
  supersession: SupersessionModeV1;
  compatibility: CompatibilityModeV1;
  alerts: string;
}

/** Deterministic, reviewable rendering of the whole registry. */
export function buildMappingReportV1(): MappingReportRowV1[] {
  return [...CANONICAL_PROJECTION_KIND_V1_VALUES].map((key) => {
    const entry = DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1[key];
    const authority =
      entry.fieldAuthority.mode === 'not_applicable'
        ? 'none'
        : `${entry.fieldAuthority.mode}(${entry.fieldAuthority.allowedFields.join('|')})`;
    return {
      projectionKind: key,
      canonicalEntity: entry.canonicalEntity,
      family: entry.family,
      naturalKey: entry.naturalKeyFields.join(' + '),
      valueAxes: entry.valueAxes.join('|'),
      fieldAuthority: authority,
      supersession: entry.supersession,
      compatibility: entry.compatibility,
      alerts: entry.alertEligible ? 'eligible' : 'never',
    };
  });
}

/** Markdown rendering of {@link buildMappingReportV1}, for the CI artifact. */
export function renderMappingReportMarkdownV1(): string {
  const rows = buildMappingReportV1();
  const header =
    '| Projection kind | Canonical entity | Family | Natural key | Value axes | Field authority | Supersession | Compatibility | Alerts |';
  const divider = '| --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const body = rows.map(
    (row) =>
      `| \`${row.projectionKind}\` | \`${row.canonicalEntity}\` | ${row.family} | ${row.naturalKey} | ${row.valueAxes} | ${row.fieldAuthority} | ${row.supersession} | ${row.compatibility} | ${row.alerts} |`,
  );
  return [
    `# Canonical mapping registry ${DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION}`,
    '',
    `Registry hash: \`${canonicalMappingRegistryHashV1()}\``,
    `Mapped projection kinds: ${rows.length}`,
    '',
    header,
    divider,
    ...body,
    '',
  ].join('\n');
}
