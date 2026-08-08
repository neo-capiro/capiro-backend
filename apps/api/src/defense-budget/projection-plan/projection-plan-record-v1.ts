/**
 * Phase 7 Gap 5, decisions 3 and 4 — the one persistence substrate for Phase
 * 4/5/6 projection plans, and the derivation of promotion-level conflict counts
 * from a persisted plan.
 *
 * Why this exists: Phase 7 authorization binds to an exact set of proposed
 * canonical mutations. That is not achievable while the projection plan exists
 * only in memory, is discarded when the producing command exits, and is
 * represented downstream by a hash whose underlying object cannot be reloaded.
 * Persistence was assumed by the design and never built — an inherited
 * prerequisite gap, the same shape as Gap 4's missing plan-filing verb.
 *
 * Ownership stays with the producer. Phase 4 persists RDT&E plans, Phase 5
 * persists non-RDT&E plans, Phase 6 persists congressional plans; Phase 7 only
 * consumes them and never recomputes a family projection during eligibility or
 * authorization. This module is the shared substrate all three write through,
 * rather than three unrelated storage mechanisms.
 *
 * ---------------------------------------------------------------------------
 * On reading three plan shapes with one schema
 * ---------------------------------------------------------------------------
 *
 * `RdteCanonicalProjectionPlanV1`, `NonRdteCanonicalProjectionPlanV1`, and the
 * Phase 6 projection set are different contracts owned by different phases.
 * This module deliberately does NOT import them: it reads the envelope they
 * genuinely share (`schemaVersion`, `cycleId`, `fiscalYear`, `contentSha256`,
 * `candidates[].operation`, `candidates[].artifactContentSha256`,
 * `candidates[].exclusionReason`) through a permissive structural schema, so a
 * family can add fields without this substrate needing to know. Anything it
 * cannot read, it refuses rather than defaults.
 */
import { z } from 'zod';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import { budgetFamilyV1Schema, sha256Schema } from '../contracts/extraction-artifact-v1.js';

export const DEFENSE_BUDGET_PROJECTION_PLAN_RECORD_SCHEMA_VERSION =
  'defense_budget_projection_plan_record_v1' as const;

/**
 * `PROJECTABLE` means every candidate in the plan can become a canonical row.
 * `BLOCKED` means at least one cannot, for a reason that must be resolved
 * rather than waived. Derived at persist time and re-derived at read time; the
 * stored value is a denormalized summary used as an integrity check, never as
 * the authority.
 */
export const PROJECTION_PLAN_STATUS_V1_VALUES = ['PROJECTABLE', 'BLOCKED'] as const;
export const projectionPlanStatusV1Schema = z.enum(PROJECTION_PLAN_STATUS_V1_VALUES);
export type ProjectionPlanStatusV1 = z.infer<typeof projectionPlanStatusV1Schema>;

/* ------------------------------------------------------------------ */
/* Exclusion classification                                            */
/* ------------------------------------------------------------------ */

/**
 * Which exclusion reasons mean "this item has no canonical mapping or could not
 * be resolved" — the population `unsupportedItemCount` is documented to count —
 * versus "this value was correctly left out of a projection by design".
 *
 * The distinction matters and is not cosmetic. Counting every exclusion would
 * block a promotion for a contextual-only value that was *supposed* to be
 * excluded; counting none would let a duplicate natural key through. Neither
 * family contract classifies its own reasons today, so the classification lives
 * here, exhaustively, with a test asserting every reason from both vocabularies
 * is present — a new reason fails the build rather than silently landing in the
 * permissive bucket.
 *
 * `true` = unsupported/unresolved, blocks promotion.
 * `false` = a deliberate, correct exclusion that carries no promotion
 * implication.
 */
export const PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1: Record<string, boolean> = {
  /* Could not be mapped or resolved — blocking. */
  uncertified_cycle: true,
  artifact_rejected: true,
  artifact_needs_review: true,
  duplicate_conflict: true,
  unsupported_role_claim: true,
  unresolved_evidence: true,
  ocr_review_required: true,

  /* Correctly excluded by design — not blocking. */
  contextual_only_value: false,
  non_annual_cost_value: false,
  outyear_not_request: false,
  not_projection_eligible: false,
};

/* ------------------------------------------------------------------ */
/* Structural view of a plan document                                  */
/* ------------------------------------------------------------------ */

const planCandidateViewSchema = z
  .object({
    operation: z.string().min(1),
    artifactContentSha256: sha256Schema.optional(),
    exclusionReason: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * The envelope every family plan shares. `.passthrough()` throughout: a family
 * plan carries far more than this, and none of it is this substrate's business.
 */
export const projectionPlanDocumentViewV1Schema = z
  .object({
    schemaVersion: z.string().min(1),
    cycleId: z.string().min(1),
    fiscalYear: z.number().int().min(1900).max(2200),
    contentSha256: sha256Schema,
    candidates: z.array(planCandidateViewSchema),
    exclusions: z.array(z.object({ reason: z.string().min(1) }).passthrough()).optional(),
  })
  .passthrough();
export type ProjectionPlanDocumentViewV1 = z.infer<typeof projectionPlanDocumentViewV1Schema>;

/* ------------------------------------------------------------------ */
/* Derived summary                                                     */
/* ------------------------------------------------------------------ */

export interface ProjectionPlanSummaryV1 {
  /** Candidates the plan itself marked `operation: 'conflict'`. */
  conflictCount: number;
  /** Candidates excluded for a reason classified as blocking above. */
  unsupportedCount: number;
  /** Every exclusion reason present, with counts. Reported, never filtered. */
  exclusionBreakdown: Record<string, number>;
  /** Hash binding the exact artifact set the plan drew from. */
  artifactSetSha256: string;
  status: ProjectionPlanStatusV1;
}

export class ProjectionPlanClassificationErrorV1 extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProjectionPlanClassificationErrorV1';
  }
}

/**
 * Derive the promotion-relevant summary from a plan document.
 *
 * This is the authority for Gap 5 decision 4: promotion-level conflicts come
 * from the plan, not from `budget_verification_discrepancy_v1` (per-run
 * verification evidence, already reflected in candidate status) and not from
 * `reconciliation_review_queue` (the legacy mutable PE path Phase 7 retires).
 */
export function summarizeProjectionPlanV1(
  document: ProjectionPlanDocumentViewV1,
): ProjectionPlanSummaryV1 {
  let conflictCount = 0;
  let unsupportedCount = 0;
  const exclusionBreakdown: Record<string, number> = {};
  const artifactHashes = new Set<string>();

  const noteExclusion = (reason: string): void => {
    exclusionBreakdown[reason] = (exclusionBreakdown[reason] ?? 0) + 1;
    const blocks = PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1[reason];
    if (blocks == null) {
      // Fail closed. An unclassified reason is not assumed harmless — that
      // assumption is precisely how an unsupported item would be dropped
      // silently, which is a mandatory Phase 7 negative control.
      throw new ProjectionPlanClassificationErrorV1(
        `projection exclusion reason "${reason}" is not classified in ` +
          `PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1; refusing to guess whether it blocks promotion`,
      );
    }
    if (blocks) unsupportedCount += 1;
  };

  for (const candidate of document.candidates) {
    if (candidate.operation === 'conflict') conflictCount += 1;
    if (candidate.artifactContentSha256 != null) {
      artifactHashes.add(candidate.artifactContentSha256);
    }
    if (candidate.exclusionReason != null) noteExclusion(candidate.exclusionReason);
  }
  for (const exclusion of document.exclusions ?? []) noteExclusion(exclusion.reason);

  return {
    conflictCount,
    unsupportedCount,
    exclusionBreakdown,
    artifactSetSha256: sha256CanonicalJson(
      [...artifactHashes].sort((a, b) => a.localeCompare(b)) as unknown as JsonValue,
    ),
    status: conflictCount === 0 && unsupportedCount === 0 ? 'PROJECTABLE' : 'BLOCKED',
  };
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Content-addressed, like every other identifier in this schema: the same plan
 * computed twice yields the same ID, so re-running a producer is a replay
 * rather than a second plan.
 */
export function projectionPlanIdV1(input: {
  family: string;
  cycleId: string;
  fiscalYear: number;
  contentSha256: string;
}): string {
  return `pp_${sha256CanonicalJson(input as unknown as JsonValue)}`;
}

/* ------------------------------------------------------------------ */
/* The persisted record                                                */
/* ------------------------------------------------------------------ */

export const defenseBudgetProjectionPlanRecordV1Schema = z
  .object({
    recordSchemaVersion: z.literal(DEFENSE_BUDGET_PROJECTION_PLAN_RECORD_SCHEMA_VERSION),
    projectionPlanId: z.string().min(1),
    /** The family plan contract's own version, e.g. `rdte_canonical_projection_plan_v1`. */
    schemaVersion: z.string().min(1),
    family: budgetFamilyV1Schema,
    cycleId: z.string().min(1),
    fiscalYear: z.number().int().min(1900).max(2200),
    contentSha256: sha256Schema,
    /** Which build of which producer computed this plan. */
    producerVersion: z.string().min(1),
    /**
     * The stored certification row this plan was computed under, when one
     * exists. Phase 6 has `phase6_cycle_certification` rows; Phase 4/5 certify
     * inside the plan document itself (a `cycleCertification` literal plus the
     * cycle bundle hash) and have no row to name, so this is null for them
     * rather than filled with something that is not an ID.
     */
    certificationId: z.string().min(1).nullable(),
    /** The certified input's content hash. Always present, unlike the ID. */
    certificationSha256: sha256Schema,
    /** Exact input binding: the artifact set the plan drew from. */
    artifactSetSha256: sha256Schema,
    status: projectionPlanStatusV1Schema,
    conflictCount: z.number().int().nonnegative(),
    unsupportedCount: z.number().int().nonnegative(),
    /** The immutable plan itself. */
    planDocument: z.unknown(),
  })
  .strict();
export type DefenseBudgetProjectionPlanRecordV1 = z.infer<
  typeof defenseBudgetProjectionPlanRecordV1Schema
>;

export interface BuildProjectionPlanRecordInputV1 {
  family: string;
  producerVersion: string;
  certificationId: string | null;
  certificationSha256: string;
  planDocument: unknown;
}

/**
 * Build the record a producer persists. Everything derivable is derived here
 * rather than accepted from the caller — a producer supplies its own identity
 * and its certification binding, and nothing that could misdescribe the plan.
 */
export function buildProjectionPlanRecordV1(
  input: BuildProjectionPlanRecordInputV1,
): DefenseBudgetProjectionPlanRecordV1 {
  const view = projectionPlanDocumentViewV1Schema.parse(input.planDocument);
  const summary = summarizeProjectionPlanV1(view);
  const family = budgetFamilyV1Schema.parse(input.family);
  return defenseBudgetProjectionPlanRecordV1Schema.parse({
    recordSchemaVersion: DEFENSE_BUDGET_PROJECTION_PLAN_RECORD_SCHEMA_VERSION,
    projectionPlanId: projectionPlanIdV1({
      family,
      cycleId: view.cycleId,
      fiscalYear: view.fiscalYear,
      contentSha256: view.contentSha256,
    }),
    schemaVersion: view.schemaVersion,
    family,
    cycleId: view.cycleId,
    fiscalYear: view.fiscalYear,
    contentSha256: view.contentSha256,
    producerVersion: input.producerVersion,
    certificationId: input.certificationId,
    certificationSha256: input.certificationSha256,
    artifactSetSha256: summary.artifactSetSha256,
    status: summary.status,
    conflictCount: summary.conflictCount,
    unsupportedCount: summary.unsupportedCount,
    planDocument: input.planDocument,
  });
}
