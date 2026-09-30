import { z } from 'zod';
import { BD_ENTITY_OUTCOMES } from './bd-entity-question';
import {
  BD_SIGNAL_FINANCIAL_STAGE_SCHEMA,
  BD_SIGNAL_OUTCOMES,
  BD_SIGNAL_RECORD_TYPE_SCHEMA,
} from './bd-signal-question';

/**
 * Fixture metadata schema for BD-ENTITY / BD-SIGNAL evaluation cases.
 *
 * IMPORTANT: there is NO approved, human-reviewed 100-case fixture set for these tasks.
 * Any fixture file validated by this schema must carry only `proposed` human-review
 * metadata and is suitable for shape/routing/boundary testing only. It is NOT a
 * semantic accuracy or calibration evidence set; no calibration or accuracy claim
 * may be made from it.
 */
const humanReviewSchema = z.object({
  status: z.literal('proposed'),
  reviewer: z.null(),
  reviewedAt: z.null(),
});

export const bdEntityFixtureCaseSchema = z
  .object({
    id: z.string().min(1),
    split: z.enum(['tuning', 'heldout']),
    task: z.literal('bd_entity'),
    organizationA: z.object({ name: z.string().min(1) }),
    organizationB: z.object({ name: z.string().min(1) }),
    expectedOutcome: z.enum(BD_ENTITY_OUTCOMES),
    rationale: z.string().min(1),
    humanReview: humanReviewSchema,
  })
  .strict();

export const bdSignalFixtureCaseSchema = z
  .object({
    id: z.string().min(1),
    split: z.enum(['tuning', 'heldout']),
    task: z.literal('bd_signal'),
    companyName: z.string().min(1),
    signalRecordType: z.string().min(1),
    expectedOutcome: z.enum(BD_SIGNAL_OUTCOMES),
    rationale: z.string().min(1),
    humanReview: humanReviewSchema,
  })
  .strict();

export const bdTaskEvaluationFixtureSchema = z.union([
  z.object({
    version: z.literal('bd_task_evaluation_fixture_v1'),
    registryVersion: z.string().min(1),
    cases: z.array(bdEntityFixtureCaseSchema),
  }),
  z.object({
    version: z.literal('bd_task_evaluation_fixture_v1'),
    registryVersion: z.string().min(1),
    cases: z.array(bdSignalFixtureCaseSchema),
  }),
]);
export type BdTaskEvaluationFixture = z.infer<typeof bdTaskEvaluationFixtureSchema>;

/**
 * ── BD evaluation fixture/review schema v2 (canary-gate capable) ──────────────
 *
 * Unlike v1 (proposed-only, never gate-eligible), v2 can express real
 * independently reviewed cases: `humanReview.status === 'approved'` requires a
 * non-empty reviewer id and a reviewedAt timestamp, and difficult negatives
 * require a second reviewer plus adjudication. The schema stores only stable
 * public/source snapshot ids and content hashes — never passages or private
 * text. No such approved 100-case dataset exists in this repository; the
 * schema exists so that a future human-labeled set can be validated and gated
 * without schema changes.
 */

export const BD_EVALUATION_MIN_REVIEWED_CASES = 100;

const bdTaskList = z.enum(['bd_entity', 'bd_signal']);

const snapshotSourceSchema = z
  .object({
    /** Stable public/source record identifier (e.g. USAward id, SAM UEI record, LDA filing id). */
    sourceRecordId: z.string().min(1).max(256),
    /** Source family (usaspending | sam | lda | internal-canonical …). */
    sourceFamily: z.string().min(1).max(64),
    /** Snapshot id/version of the source record at review time. */
    snapshotId: z.string().min(1).max(256),
    /** Hex/other deterministic hash of the reviewed snapshot content (not the passage itself). */
    snapshotHash: z.string().min(8).max(256),
    /** Retrieval date of the snapshot (ISO date). */
    retrievedAt: z.string().min(4).max(32),
    /** Deterministic locator (URL/fragment/id path) for re-verification. */
    locator: z.string().min(1).max(512),
  })
  .strict();

const reviewerSchema = z
  .object({
    /** Stable reviewer identity; must never be a fabricated name. */
    reviewerId: z.string().min(1).max(128),
    reviewedAt: z.string().datetime(),
  })
  .strict();

const adjudicationSchema = z
  .object({
    required: z.literal(true),
    reviewerIds: z
      .array(z.string().min(1).max(128))
      .length(2)
      .refine(
        (ids) => new Set(ids).size === 2,
        'adjudication requires exactly two DISTINCT reviewer ids',
      ),
    adjudicatorId: z.string().min(1).max(128),
    adjudicatedAt: z.string().datetime(),
    finalOutcomeConfirmed: z
      .boolean()
      .refine((v) => v, 'adjudication must confirm the final outcome'),
  })
  .strict();

export const bdEvalHumanReviewSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('proposed'),
      reviewer: z.null(),
      reviewedAt: z.null(),
      difficultNegative: z.boolean(),
      adjudication: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('approved'),
      reviewer: reviewerSchema,
      difficultNegative: z.boolean(),
      /** Difficult negatives require two-reviewer adjudication to be approved. */
      adjudication: z.null().or(adjudicationSchema),
    })
    .strict(),
]);
/** True when an approved review is a difficult negative without adjudication. */
export function isUnadjudicatedDifficultNegative(review: unknown): boolean {
  const parsed = bdEvalHumanReviewSchema.safeParse(review);
  if (!parsed.success || parsed.data.status !== 'approved') return false;
  return parsed.data.difficultNegative && parsed.data.adjudication === null;
}
export type BdEvalHumanReview = z.infer<typeof bdEvalHumanReviewSchema>;

const bdEvalBaseCaseSchema = z
  .object({
    id: z.string().min(1).max(256),
    task: bdTaskList,
    split: z.enum(['tuning', 'heldout']),
    /** Grouping keys for the held-out cohort partition and strata. */
    grouping: z
      .object({
        companyKey: z.string().min(1).max(256),
        sourceKey: z.string().min(1).max(256),
        timeKey: z.string().min(4).max(32),
      })
      .strict(),
    /** Stratification metadata; missing fields make the gate fail closed. */
    strata: z
      .object({
        sourceFamily: z.string().min(1).max(64),
        sector: z.string().min(1).max(128),
        companySize: z.enum(['micro', 'small', 'mid', 'large', 'unknown']),
        taskCategory: z.string().min(1).max(128),
        sourceAvailability: z.enum([
          'available',
          'empty_in_queried_scope',
          'partial',
          'stale',
          'error',
        ]),
      })
      .strict(),
    sources: z.array(snapshotSourceSchema).min(1).max(16),
    expectedOutcome: z.string().min(1).max(128),
    rationale: z.string().min(1).max(4_000),
    humanReview: bdEvalHumanReviewSchema,
  })
  .strict();

export const bdEntityEvalCaseSchema = bdEvalBaseCaseSchema
  .extend({
    task: z.literal('bd_entity'),
    expectedOutcome: z.enum(BD_ENTITY_OUTCOMES),
    input: z
      .object({
        /** Stable public organization ids + content hashes, not passages. */
        organizationA: z
          .object({ publicId: z.string().min(1).max(256), nameHash: z.string().min(8).max(256) })
          .strict(),
        organizationB: z
          .object({ publicId: z.string().min(1).max(256), nameHash: z.string().min(8).max(256) })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const bdSignalEvalCaseSchema = bdEvalBaseCaseSchema
  .extend({
    task: z.literal('bd_signal'),
    expectedOutcome: z.enum(BD_SIGNAL_OUTCOMES),
    input: z
      .object({
        companyPublicId: z.string().min(1).max(256),
        signalSourceRecordId: z.string().min(1).max(256),
        /** The exact evaluated tuple: the record type and financial stage the Jev
         *  decision was made on; a direct-label proof must match these exactly. */
        recordType: BD_SIGNAL_RECORD_TYPE_SCHEMA,
        financialStage: BD_SIGNAL_FINANCIAL_STAGE_SCHEMA,
      })
      .strict(),
  })
  .strict();

const bdEvalObservationSchema = z
  .object({
    outcome: z.string().min(1).max(128).nullable(),
    action: z.enum(['propose', 'abstain']).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    latencyMs: z.number().min(0).int(),
    usage: z
      .object({ inputTokens: z.number().min(0).int(), outputTokens: z.number().min(0).int() })
      .nullable(),
    /** Failure state when no outcome was produced. */
    failureState: z.string().min(1).max(64).nullable(),
  })
  .strict();

/**
 * Recorded application effect: what the consuming application ACTUALLY did with
 * the Jev suggestion for this case. A Jev semantic suggestion (e.g.
 * same_legal_entity) is always allowed; the invariants below govern effects:
 * an exact-identity merge or a direct signal label is an effect, not a
 * suggestion, and is severe when unreviewed or unproven.
 */
const bdEntityEffectSchema = z
  .object({
    kind: z.literal('bd_entity_effect'),
    /** True only if the application actually merged/linked the two records as one legal entity. */
    exactIdentityMergePerformed: z.boolean(),
    /** True if this case was routed to a human review queue. */
    requiredHumanFollowUp: z.boolean(),
  })
  .strict();

const bdSignalDirectLabelProofSchema = z
  .object({
    /** Resolved company identity the label was attached to. */
    resolvedCompanyPublicId: z.string().min(1).max(256),
    /** Source record the direct label cites. */
    sourceRecordId: z.string().min(1).max(256),
    recordType: BD_SIGNAL_RECORD_TYPE_SCHEMA,
    financialStage: BD_SIGNAL_FINANCIAL_STAGE_SCHEMA,
    locator: z.string().min(1).max(512),
  })
  .strict();

const bdSignalEffectSchema = z
  .object({
    kind: z.literal('bd_signal_effect'),
    /** True only if a direct (non-hedged) signal label was applied in the UI/data. */
    directLabelApplied: z.boolean(),
    /** Deterministic proof required for any direct label; null when not applied. */
    directLabelProof: bdSignalDirectLabelProofSchema.nullable(),
    /** True if this case was routed to a human review queue. */
    requiredHumanFollowUp: z.boolean(),
  })
  .strict();

const bdEvalEffectSchema = z.discriminatedUnion('kind', [
  bdEntityEffectSchema,
  bdSignalEffectSchema,
]);
export type BdEvalEntityEffect = z.infer<typeof bdEntityEffectSchema>;
export type BdEvalSignalEffect = z.infer<typeof bdSignalEffectSchema>;
export type BdEvalEffect = z.infer<typeof bdEvalEffectSchema>;

const bdEvalCaseWithObservationsSchema = z
  .discriminatedUnion('task', [
    bdEntityEvalCaseSchema.extend({
      observations: z
        .object({
          baseline: bdEvalObservationSchema,
          jev: bdEvalObservationSchema,
        })
        .strict(),
      effect: bdEntityEffectSchema,
    }),
    bdSignalEvalCaseSchema.extend({
      observations: z
        .object({
          baseline: bdEvalObservationSchema,
          jev: bdEvalObservationSchema,
        })
        .strict(),
      effect: bdSignalEffectSchema,
    }),
  ])
  .superRefine((caseItem, ctx) => {
    if (isUnadjudicatedDifficultNegative(caseItem.humanReview)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approved difficult negatives require two-reviewer adjudication',
      });
    }
    if (
      caseItem.task === 'bd_signal' &&
      caseItem.effect.directLabelApplied &&
      !caseItem.effect.directLabelProof
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'applied direct signal label requires deterministic proof',
      });
    }
  });
export type BdEvalCase = z.infer<typeof bdEvalCaseWithObservationsSchema>;
export type BdEvalObservation = z.infer<typeof bdEvalObservationSchema>;

/** Predeclared per-outcome thresholds the gate enforces (fail closed when unmet). */
export const bdEvalThresholdsSchema = z
  .object({
    /** Minimum precision per expected outcome (0..1). */
    minPrecisionByOutcome: z.record(z.string().min(1), z.number().min(0).max(1)),
    /** Minimum recall per expected outcome (0..1). */
    minRecallByOutcome: z.record(z.string().min(1), z.number().min(0).max(1)),
    /** Maximum abstain share over approved cases (0..1). */
    maxAbstainShare: z.number().min(0).max(1),
    /** Maximum recorded human-review-required share over approved cases (0..1). */
    maxReviewShare: z.number().min(0).max(1),
  })
  .strict();
export type BdEvalThresholds = z.infer<typeof bdEvalThresholdsSchema>;

export const bdTaskReviewFixtureSchema = z
  .object({
    version: z.literal('bd_task_review_fixture_v2'),
    /** Must equal the registry version the gate was predeclared against. */
    registryVersion: z.string().min(1),
    task: bdTaskList,
    /** Pinned versions recorded from the task registry at gate time. */
    pinned: z
      .object({
        modelVersion: z.string().min(1),
        questionVersion: z.string().min(1),
        registryVersion: z.string().min(1),
        candidateGenerator: z
          .object({ id: z.string().min(1), version: z.string().min(1) })
          .strict(),
        priceVersion: z.string().min(1),
      })
      .strict(),
    /** Predeclared ceilings. */
    ceilings: z
      .object({
        maxP95LatencyMs: z.number().min(0).int(),
        maxMedianLatencyMs: z.number().min(0).int(),
        maxEstimatedCostUsd: z.number().min(0),
      })
      .strict(),
    thresholds: bdEvalThresholdsSchema,
    cases: z.array(bdEvalCaseWithObservationsSchema).min(1),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    const mismatched = fixture.cases.filter((caseItem) => caseItem.task !== fixture.task);
    if (mismatched.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `fixture is single-task; ${mismatched.length} case(s) have task !== ${fixture.task}`,
      });
    }
  });
export type BdTaskReviewFixture = z.infer<typeof bdTaskReviewFixtureSchema>;
