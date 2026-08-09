/**
 * Phase 7 repair — exact producer-plan projection source.
 *
 * The original production source rebuilt promotion inputs by asking the Phase
 * 4/5/6 projection tables for "everything in FY X". That made the immutable
 * producer plans named by promotion eligibility advisory rather than
 * load-bearing: planning and execution could reassemble a different row set
 * from the one the eligibility/authorization hash actually named.
 *
 * This source closes that gap. Its authority chain is:
 *
 *   persisted eligibility hash
 *     -> exact projectionPlanIds + projectionPlanHashes
 *     -> immutable producer plan rows, independently re-verified
 *     -> family-specific projector
 *     -> promotion planner / execution reload
 *
 * Phase 4/5 plans contain their complete proof-bound candidate payload, so they
 * are projected directly from the immutable plan document. Phase 6's committee
 * plan deliberately contains references to normalized audit projections rather
 * than duplicating their money/payload; for that family this source additionally
 * verifies the plan's certification and exact certification->projection binding
 * before loading those rows. No family is reconstructed from fiscal year alone.
 */
import { z } from 'zod';
import {
  budgetFamilyV1Schema,
  sha256Schema,
  type BudgetFamilyV1,
} from '../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import { parseCanonicalDecimalString } from '../contracts/decimal-string.js';
import {
  defenseBudgetPromotionEligibilityV1Schema,
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
  type PromotionScopeV1,
} from './promotion-eligibility-v1.js';
import {
  buildProjectionPlanRecordV1,
  type DefenseBudgetProjectionPlanRecordV1,
} from '../projection-plan/projection-plan-record-v1.js';
import {
  proofBoundRdteCanonicalProjectionPlanV1Schema,
  computeProjectionPlanContentSha256,
} from '../rdte/projection/rdte-canonical-projection-plan-v1.js';
import {
  nonRdteCanonicalProjectionPlanV1Schema,
  computeNonRdteProjectionPlanContentSha256,
} from '../non-rdte/non-rdte-canonical-projection-plan-v1.js';
import {
  projectMilconCandidatesV1,
  projectOmCandidatesV1,
  projectPhase6ProjectionsV1,
  projectProcurementCandidatesV1,
  projectRdteCandidatesV1,
  type ProjectorRefusalRecordV1,
} from './canonical-projectors-v1.js';
import {
  phase6NativeProjectionV1Schema,
  phase6ProjectionKindV1Schema,
  type Phase6NativeProjectionV1,
} from '../phase6/phase6-native-projection-v1.js';
import { phase6ProjectionSetSha256V1 } from '../phase6/phase6-cycle-certification-v1.js';
import { PHASE6_PROJECTION_PLAN_SCHEMA_VERSION } from '../phase6/phase6-projection-plan-builder-v1.js';
import type { PromotionProjectionInputV1 } from './promotion-planner-v1.js';
import type { StoredExecutionPlanV1 } from './canonical-promotion-service-v1.js';

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});

const phase6PlanCandidateSchema = z
  .object({
    operation: z.enum(['insert', 'no_op', 'conflict']),
    exclusionReason: nonBlank.optional(),
    artifactContentSha256: sha256Schema,
    sourceProjectionIds: z.array(nonBlank).min(1),
    naturalKey: nonBlank,
    projectionKind: phase6ProjectionKindV1Schema,
    nativeIdentityHash: sha256Schema,
    verificationCandidateId: nonBlank,
    verificationRunId: nonBlank,
    sourceDocumentId: nonBlank,
    sourcePdfSha256: sha256Schema,
    enactmentProofId: nonBlank.optional(),
  })
  .strict();

const phase6ProjectionPlanDocumentSchema = z
  .object({
    schemaVersion: z.literal(PHASE6_PROJECTION_PLAN_SCHEMA_VERSION),
    cycleId: nonBlank,
    fiscalYear: z.number().int().min(1900).max(2200),
    candidates: z.array(phase6PlanCandidateSchema),
    contentSha256: sha256Schema,
  })
  .strict();

type Phase6ProjectionPlanDocument = z.infer<typeof phase6ProjectionPlanDocumentSchema>;

export interface EligibilityBoundProjectionPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

interface ProjectionPlanRowV1 {
  projectionPlanId: string;
  recordSchemaVersion: string;
  schemaVersion: string;
  family: string;
  cycleId: string;
  fiscalYear: number;
  contentSha256: string;
  producerVersion: string;
  certificationId: string | null;
  certificationSha256: string;
  artifactSetSha256: string;
  status: string;
  conflictCount: number;
  unsupportedCount: number;
  planDocument: unknown;
}

interface Phase6CertificationRowV1 {
  certificationId: string;
  cycleId: string;
  fiscalYear: number;
  contentSha256: string;
  projectionSetSha256: string | null;
  projectionCount: number | null;
}

interface Phase6ProjectionRowV1 {
  projectionId: string;
  naturalKey: string;
  idempotencyKey: string;
  projectionKind: string;
  verificationCandidateId: string;
  verificationRunId: string;
  artifactId: string;
  artifactContentSha256: string;
  sourceDocumentId: string;
  sourcePdfSha256: string;
  sourceProfileHash: string;
  nativeIdentityHash: string;
  track: string;
  stage: string;
  fundingField: string | null;
  originalValue: string | null;
  originalUnit: string | null;
  amountMillions: unknown;
  directOrDerived: string;
  evidenceIds: unknown;
  bindingStatus: string;
  projectionStatus: string;
  enactmentProofId: string | null;
  supersedesProjectionId: string | null;
  payload: unknown;
}

export interface EligibilityBoundProjectionLoadV1 {
  eligibility: DefenseBudgetPromotionEligibilityV1;
  projections: PromotionProjectionInputV1[];
  refusals: ProjectorRefusalRecordV1[];
  projectionPlans: DefenseBudgetProjectionPlanRecordV1[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameScope(left: PromotionScopeV1, right: PromotionScopeV1): boolean {
  return sha256CanonicalJson(left as unknown as JsonValue) === sha256CanonicalJson(right as unknown as JsonValue);
}

function verifyRdtePlanContentV1(document: unknown): ReturnType<typeof proofBoundRdteCanonicalProjectionPlanV1Schema.parse> {
  const parsed = proofBoundRdteCanonicalProjectionPlanV1Schema.parse(document);
  const { contentSha256, ...withoutHash } = parsed;
  const actual = computeProjectionPlanContentSha256(withoutHash);
  if (actual !== contentSha256) {
    throw new Error(
      `RDT&E projection plan declares content SHA ${contentSha256} but recomputes to ${actual}`,
    );
  }
  return parsed;
}

function verifyNonRdtePlanContentV1(document: unknown) {
  const parsed = nonRdteCanonicalProjectionPlanV1Schema.parse(document);
  const { contentSha256, ...withoutHash } = parsed;
  const actual = computeNonRdteProjectionPlanContentSha256(withoutHash);
  if (actual !== contentSha256) {
    throw new Error(
      `non-RDT&E projection plan declares content SHA ${contentSha256} but recomputes to ${actual}`,
    );
  }
  return parsed;
}

function verifyPhase6PlanContentV1(document: unknown): Phase6ProjectionPlanDocument {
  const parsed = phase6ProjectionPlanDocumentSchema.parse(document);
  const { contentSha256, ...withoutHash } = parsed;
  const actual = sha256CanonicalJson(withoutHash as unknown as JsonValue);
  if (actual !== contentSha256) {
    throw new Error(
      `Phase 6 projection plan declares content SHA ${contentSha256} but recomputes to ${actual}`,
    );
  }
  return parsed;
}

function phase6ProjectionFromRowV1(row: Phase6ProjectionRowV1): Phase6NativeProjectionV1 {
  const hasMoney =
    row.originalValue != null && row.originalUnit != null && row.amountMillions != null;
  return phase6NativeProjectionV1Schema.parse({
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: row.projectionId,
    naturalKey: row.naturalKey,
    idempotencyKey: row.idempotencyKey,
    projectionKind: row.projectionKind,
    verificationCandidateId: row.verificationCandidateId,
    verificationRunId: row.verificationRunId,
    artifactId: row.artifactId,
    artifactContentSha256: row.artifactContentSha256,
    sourceDocumentId: row.sourceDocumentId,
    sourcePdfSha256: row.sourcePdfSha256,
    sourceProfileHash: row.sourceProfileHash,
    nativeIdentityHash: row.nativeIdentityHash,
    track: row.track,
    stage: row.stage,
    ...(row.fundingField != null ? { fundingField: row.fundingField } : {}),
    ...(hasMoney
      ? {
          money: {
            originalValue: row.originalValue!,
            originalUnit: row.originalUnit,
            valueMillions: parseCanonicalDecimalString(String(row.amountMillions)),
          },
        }
      : {}),
    directOrDerived: row.directOrDerived,
    evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds : [],
    bindingStatus: row.bindingStatus,
    projectionStatus: row.projectionStatus,
    ...(row.enactmentProofId != null ? { enactmentProofId: row.enactmentProofId } : {}),
    ...(row.supersedesProjectionId != null
      ? { supersedesProjectionId: row.supersedesProjectionId }
      : {}),
    payload: row.payload ?? {},
    canonicalWriteAllowed: false,
  });
}

export class PrismaEligibilityBoundProjectionSourceV1 {
  constructor(private readonly prisma: EligibilityBoundProjectionPrismaLikeV1) {}

  /** Planning path: exact persisted eligibility is the source of producer-plan IDs. */
  async loadForEligibilityHash(eligibilityHash: string): Promise<EligibilityBoundProjectionLoadV1> {
    const eligibility = await this.loadEligibilityV1(eligibilityHash);
    return this.loadEligibilityV1(eligibility);
  }

  /** Execution path: the authorized plan's eligibility hash and scope must still agree. */
  async loadForPlan(plan: StoredExecutionPlanV1): Promise<PromotionProjectionInputV1[]> {
    const eligibility = await this.loadEligibilityV1(plan.eligibilityHash);
    if (!sameScope(eligibility.scope, plan.plan.scope)) {
      throw new Error(
        `promotion plan ${plan.planId} scope does not match its persisted eligibility scope`,
      );
    }
    const loaded = await this.loadEligibilityV1(eligibility);
    if (loaded.refusals.length > 0) {
      throw new Error(
        `exact producer-plan reload produced ${loaded.refusals.length} projector refusal(s): ` +
          loaded.refusals.map((refusal) => `${refusal.naturalKey}:${refusal.reason}`).join(', '),
      );
    }
    return loaded.projections;
  }

  private async loadEligibilityV1(
    input: string | DefenseBudgetPromotionEligibilityV1,
  ): Promise<DefenseBudgetPromotionEligibilityV1 | EligibilityBoundProjectionLoadV1> {
    if (typeof input === 'string') {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ document: unknown }>>(
        `SELECT "document" FROM "defense_budget_promotion_eligibility" WHERE "eligibility_hash" = $1`,
        input,
      );
      const row = rows[0];
      if (row == null) throw new Error(`promotion eligibility ${input} was not found`);
      const eligibility = defenseBudgetPromotionEligibilityV1Schema.parse(row.document);
      if (promotionEligibilityHashV1(eligibility) !== input) {
        throw new Error(`promotion eligibility ${input} no longer hashes to its storage key`);
      }
      return eligibility;
    }

    const eligibility = input;
    const records = await this.loadExactProjectionPlansV1(eligibility);
    const projections: PromotionProjectionInputV1[] = [];
    const refusals: ProjectorRefusalRecordV1[] = [];

    for (const record of records) {
      if (record.status !== 'PROJECTABLE') {
        throw new Error(
          `eligibility ${eligibility.eligibilityId} names blocked producer plan ${record.projectionPlanId}`,
        );
      }
      if (record.family === 'rdte') {
        const document = verifyRdtePlanContentV1(record.planDocument);
        const projected = projectRdteCandidatesV1(document.candidates);
        projections.push(...projected.projections);
        refusals.push(...projected.refusals);
        continue;
      }
      if (record.family === 'procurement' || record.family === 'om' || record.family === 'milcon') {
        const document = verifyNonRdtePlanContentV1(record.planDocument);
        if (document.family !== record.family) {
          throw new Error(
            `producer plan ${record.projectionPlanId} row says ${record.family} but document says ${document.family}`,
          );
        }
        const projected =
          record.family === 'procurement'
            ? projectProcurementCandidatesV1(document.candidates)
            : record.family === 'om'
              ? projectOmCandidatesV1(document.candidates)
              : projectMilconCandidatesV1(document.candidates);
        projections.push(...projected.projections);
        refusals.push(...projected.refusals);
        continue;
      }
      if (record.family === 'committee') {
        const projected = await this.projectCommitteePlanV1(record, eligibility.scope);
        projections.push(...projected.projections);
        refusals.push(...projected.refusals);
        continue;
      }
      const exhaustive: never = record.family;
      throw new Error(`unsupported persisted producer-plan family ${String(exhaustive)}`);
    }

    projections.sort(
      (a, b) => a.naturalKey.localeCompare(b.naturalKey) || a.projectionId.localeCompare(b.projectionId),
    );
    refusals.sort(
      (a, b) => a.naturalKey.localeCompare(b.naturalKey) || a.candidateId.localeCompare(b.candidateId),
    );
    return { eligibility, projections, refusals, projectionPlans: records };
  }

  private async loadExactProjectionPlansV1(
    eligibility: DefenseBudgetPromotionEligibilityV1,
  ): Promise<DefenseBudgetProjectionPlanRecordV1[]> {
    const expectedIds = eligibility.projectionPlanIds;
    if (expectedIds.length === 0) {
      throw new Error(`eligibility ${eligibility.eligibilityId} names no producer projection plans`);
    }
    const placeholders = expectedIds.map((_, index) => `$${index + 1}`).join(', ');
    const rows = await this.prisma.$queryRawUnsafe<ProjectionPlanRowV1[]>(
      `SELECT "projection_plan_id" AS "projectionPlanId",
              "record_schema_version" AS "recordSchemaVersion",
              "schema_version" AS "schemaVersion",
              "family", "cycle_id" AS "cycleId", "fiscal_year" AS "fiscalYear",
              "content_sha256" AS "contentSha256", "producer_version" AS "producerVersion",
              "certification_id" AS "certificationId",
              "certification_sha256" AS "certificationSha256",
              "artifact_set_sha256" AS "artifactSetSha256", "status",
              "conflict_count" AS "conflictCount", "unsupported_count" AS "unsupportedCount",
              "plan_document" AS "planDocument"
         FROM "defense_budget_projection_plan"
        WHERE "projection_plan_id" IN (${placeholders})
        ORDER BY "projection_plan_id"`,
      ...expectedIds,
    );

    if (!sameStringSet(rows.map((row) => row.projectionPlanId), expectedIds)) {
      throw new Error(
        `eligibility ${eligibility.eligibilityId} names producer plan IDs that could not all be reloaded`,
      );
    }

    const records = rows.map((row) => this.verifyProjectionPlanRowV1(row));
    if (!sameStringSet(records.map((record) => record.contentSha256), eligibility.projectionPlanHashes)) {
      throw new Error(
        `eligibility ${eligibility.eligibilityId} producer plan hashes do not match reloaded plan contents`,
      );
    }

    for (const record of records) {
      if (record.cycleId !== eligibility.scope.cycleId || record.fiscalYear !== eligibility.scope.fiscalYear) {
        throw new Error(
          `producer plan ${record.projectionPlanId} scope ${record.cycleId}/FY${record.fiscalYear} ` +
            `does not match eligibility ${eligibility.scope.cycleId}/FY${eligibility.scope.fiscalYear}`,
        );
      }
    }
    if (!sameStringSet(records.map((record) => record.family), eligibility.scope.families)) {
      throw new Error(
        `eligibility ${eligibility.eligibilityId} families do not exactly match its producer-plan families`,
      );
    }
    return records;
  }

  private verifyProjectionPlanRowV1(row: ProjectionPlanRowV1): DefenseBudgetProjectionPlanRecordV1 {
    const family = budgetFamilyV1Schema.parse(row.family);
    // Rebuild every derived field from the document. This catches a row whose
    // denormalized status/count/artifact-set metadata was altered independently
    // of the immutable document.
    const rebuilt = buildProjectionPlanRecordV1({
      family,
      producerVersion: row.producerVersion,
      certificationId: row.certificationId,
      certificationSha256: row.certificationSha256,
      planDocument: row.planDocument,
    });
    const comparisons: Array<[string, unknown, unknown]> = [
      ['projectionPlanId', row.projectionPlanId, rebuilt.projectionPlanId],
      ['recordSchemaVersion', row.recordSchemaVersion, rebuilt.recordSchemaVersion],
      ['schemaVersion', row.schemaVersion, rebuilt.schemaVersion],
      ['cycleId', row.cycleId, rebuilt.cycleId],
      ['fiscalYear', Number(row.fiscalYear), rebuilt.fiscalYear],
      ['contentSha256', row.contentSha256, rebuilt.contentSha256],
      ['artifactSetSha256', row.artifactSetSha256, rebuilt.artifactSetSha256],
      ['status', row.status, rebuilt.status],
      ['conflictCount', Number(row.conflictCount), rebuilt.conflictCount],
      ['unsupportedCount', Number(row.unsupportedCount), rebuilt.unsupportedCount],
    ];
    for (const [field, stored, derived] of comparisons) {
      if (stored !== derived) {
        throw new Error(
          `producer plan ${row.projectionPlanId} ${field} disagrees with its immutable document`,
        );
      }
    }

    // Recompute the family plan's own content hash rather than merely checking
    // that the document repeats the hash under which the row was filed.
    if (family === 'rdte') verifyRdtePlanContentV1(row.planDocument);
    else if (family === 'committee') verifyPhase6PlanContentV1(row.planDocument);
    else verifyNonRdtePlanContentV1(row.planDocument);
    return rebuilt;
  }

  private async projectCommitteePlanV1(
    record: DefenseBudgetProjectionPlanRecordV1,
    scope: PromotionScopeV1,
  ): Promise<{ projections: PromotionProjectionInputV1[]; refusals: ProjectorRefusalRecordV1[] }> {
    const document = verifyPhase6PlanContentV1(record.planDocument);
    if (record.certificationId == null) {
      throw new Error(`committee producer plan ${record.projectionPlanId} has no Phase 6 certification ID`);
    }

    const certifications = await this.prisma.$queryRawUnsafe<Phase6CertificationRowV1[]>(
      `SELECT "id"::text AS "certificationId", "cycle_id" AS "cycleId",
              "fiscal_year" AS "fiscalYear", "content_sha256" AS "contentSha256",
              "projection_set_sha256" AS "projectionSetSha256",
              "projection_count" AS "projectionCount"
         FROM "phase6_cycle_certification"
        WHERE "content_sha256" = $1`,
      record.certificationSha256,
    );
    const certification = certifications[0];
    if (certification == null) {
      throw new Error(`committee producer plan ${record.projectionPlanId} certification was not found`);
    }
    if (
      certification.certificationId !== record.certificationId ||
      certification.cycleId !== record.cycleId ||
      certification.fiscalYear !== record.fiscalYear ||
      certification.projectionSetSha256 == null ||
      certification.projectionCount == null
    ) {
      throw new Error(`committee producer plan ${record.projectionPlanId} certification binding is stale or incomplete`);
    }

    const rows = await this.prisma.$queryRawUnsafe<Phase6ProjectionRowV1[]>(
      `SELECT p."projection_id" AS "projectionId", p."natural_key" AS "naturalKey",
              p."idempotency_key" AS "idempotencyKey", p."projection_kind" AS "projectionKind",
              p."verification_candidate_id" AS "verificationCandidateId",
              p."verification_run_id" AS "verificationRunId", p."artifact_id" AS "artifactId",
              p."artifact_content_sha256" AS "artifactContentSha256",
              p."source_document_id" AS "sourceDocumentId",
              p."source_pdf_sha256" AS "sourcePdfSha256",
              p."source_profile_hash" AS "sourceProfileHash",
              p."native_identity_hash" AS "nativeIdentityHash", p."track", p."stage",
              p."funding_field" AS "fundingField", p."original_value" AS "originalValue",
              p."original_unit" AS "originalUnit", p."amount_millions"::text AS "amountMillions",
              p."direct_or_derived" AS "directOrDerived", p."evidence_ids_jsonb" AS "evidenceIds",
              p."binding_status" AS "bindingStatus", p."projection_status" AS "projectionStatus",
              p."enactment_proof_id" AS "enactmentProofId",
              p."supersedes_projection_id" AS "supersedesProjectionId",
              p."payload_jsonb" AS "payload"
         FROM "phase6_cycle_certification_projection" cp
         JOIN "phase6_audit_projection" p ON p."projection_id" = cp."projection_id"
        WHERE cp."certification_content_sha256" = $1
        ORDER BY cp."projection_ordinal", p."projection_id"`,
      record.certificationSha256,
    );
    const reconstructed = rows.map(phase6ProjectionFromRowV1);
    if (
      reconstructed.length !== certification.projectionCount ||
      phase6ProjectionSetSha256V1(reconstructed) !== certification.projectionSetSha256
    ) {
      throw new Error(`committee producer plan ${record.projectionPlanId} certification projection set no longer verifies`);
    }

    const boundIds = sortedUnique(reconstructed.map((projection) => projection.projectionId));
    const planIds = sortedUnique(document.candidates.flatMap((candidate) => candidate.sourceProjectionIds));
    if (!sameStringSet(boundIds, planIds)) {
      throw new Error(
        `committee producer plan ${record.projectionPlanId} does not account for the exact certified projection set`,
      );
    }

    const selected =
      scope.stages.length === 0
        ? reconstructed
        : reconstructed.filter((projection) => scope.stages.includes(projection.stage));
    return projectPhase6ProjectionsV1(selected);
  }
}

/** Kept explicit so a future family addition is a compile/test event. */
export const ELIGIBILITY_BOUND_PROJECTION_FAMILIES_V1: readonly BudgetFamilyV1[] = [
  'rdte',
  'procurement',
  'om',
  'milcon',
  'committee',
];
