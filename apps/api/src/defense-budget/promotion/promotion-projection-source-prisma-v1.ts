/**
 * Phase 7 Workstream N — the production projection source.
 *
 * Until this module existed, the only `PromotionProjectionSourceV1` in the
 * repository was `OmProjectionSource`, declared inline in
 * `scripts/pe-budget-phase7-engine-rehearsal.ts`, which hardcodes its lineage
 * (`artifact-1`, `doc-1`, `ev-1`) because the rehearsal only needed the engine
 * to move rows. A plan built from those values would bind every canonical row
 * to provenance that does not exist. This module reads the real lineage columns
 * the Phase 5 projection schema already carries.
 *
 * Two rules govern what it does with what it cannot do:
 *
 *   * A requested family with no loader in this build is reported in
 *     `unsupportedFamilies` and never silently contributes zero projections.
 *     An empty plan for a family that simply was not read is indistinguishable
 *     from an empty plan for a family with nothing to promote, and the second
 *     is a legitimate promotion while the first is a missing half of one.
 *   * Projector refusals are returned, never dropped, matching
 *     `ProjectorResultV1`'s own contract.
 *
 * Both are the Phase 7 invariant that unsupported items block promotion rather
 * than disappearing.
 */
import type { BudgetFamilyV1 } from '../contracts/extraction-artifact-v1.js';
import type { Phase6NativeProjectionV1 } from '../phase6/phase6-native-projection-v1.js';
import type { StageTrackV1, StageV1 } from '../stages/stage-vocabulary-v1.js';
import {
  projectOmCandidatesV1,
  projectPhase6ProjectionsV1,
  type ProjectionCandidateInputV1,
  type ProjectorResultV1,
} from './canonical-projectors-v1.js';
import type { PromotionProjectionInputV1 } from './promotion-planner-v1.js';
import type { PromotionProjectionSourceV1 } from './canonical-promotion-repository-prisma-v1.js';
import type { StoredExecutionPlanV1 } from './canonical-promotion-service-v1.js';

/** Derived from the result type so this module does not depend on the name. */
type ProjectorRefusalV1 = ProjectorResultV1['refusals'][number];

/**
 * The families this build can actually read. Every other family in
 * `BUDGET_FAMILY_V1_VALUES` has a projector (Workstreams F–J) but no verified
 * projection reader, so a plan cannot yet be built for it.
 *
 * `committee` reads Phase 6 audit projections (Gap 1) — HASC/SASC/HAC-D/SAC-D/
 * NDAA conference/appropriations conference `stage_position` and identity-
 * scoped `stage_action` rows persisted by `Phase6AuditProjectionRepository`.
 * Enacted (`public_law`), reprogramming, and execution positions are not
 * persisted by this build yet (see `phase6-projection-builder-v1.ts`'s own
 * scope note), so `committee` covers a real subset of Phase 6, not all of it.
 */
export const PROJECTION_SOURCE_SUPPORTED_FAMILIES_V1: readonly BudgetFamilyV1[] = [
  'om',
  'committee',
];

/** The narrowest Prisma surface this adapter needs. */
export interface ProjectionPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface ProjectionScopeV1 {
  fiscalYear: number;
  families: readonly BudgetFamilyV1[];
}

export interface ProjectionLoadResultV1 {
  projections: PromotionProjectionInputV1[];
  /** Returned, never dropped; each one blocks the promotion upstream. */
  refusals: ProjectorRefusalV1[];
  /** Requested families this build has no reader for. Blocking. */
  unsupportedFamilies: BudgetFamilyV1[];
  /**
   * Identities that carry no funding row inside the requested fiscal year.
   * Reported for transparency: they are out of scope rather than refused, but
   * an operator comparing counts against a source document should see them.
   */
  identitiesWithoutScopedFunding: number;
}

interface OmSagYearRowV1 {
  naturalKey: string;
  component: string;
  account: string;
  sagCode: string;
  title: string | null;
  fiscalYear: number;
  fundingField: string;
  amountMillions: string;
  originalValue: string;
  originalUnit: string;
  assertionId: string;
  verificationCandidateId: string;
  verificationRunId: string;
  verificationDecisionId: string;
  artifactId: string;
  artifactContentSha256: string;
  sourcePdfSha256: string;
  evidenceIds: unknown;
  sourceDocumentKey: string;
}

/** NUMERIC(20,6) renders as "1.250000"; canonical form drops trailing zeros. */
function normalizeDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/** `evidence_ids_jsonb` is JSONB; accept an array and refuse to invent one. */
function evidenceIdsOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

export class PrismaPromotionProjectionSourceV1 implements PromotionProjectionSourceV1 {
  constructor(private readonly prisma: ProjectionPrismaLikeV1) {}

  async loadForScope(scope: ProjectionScopeV1): Promise<ProjectionLoadResultV1> {
    const requested = [...new Set(scope.families)];
    const unsupportedFamilies = requested.filter(
      (family) => !PROJECTION_SOURCE_SUPPORTED_FAMILIES_V1.includes(family),
    );

    const projections: PromotionProjectionInputV1[] = [];
    const refusals: ProjectorRefusalV1[] = [];
    let identitiesWithoutScopedFunding = 0;

    if (requested.includes('om')) {
      const result = await this.loadOm(scope.fiscalYear);
      projections.push(...result.projections);
      refusals.push(...result.refusals);
      identitiesWithoutScopedFunding += result.identitiesWithoutScopedFunding;
    }

    if (requested.includes('committee')) {
      const result = await this.loadCommittee(scope.fiscalYear);
      projections.push(...result.projections);
      refusals.push(...result.refusals);
    }

    return { projections, refusals, unsupportedFamilies, identitiesWithoutScopedFunding };
  }

  /**
   * Workstream E reloads projections through this method rather than trusting
   * the plan's own recorded inputs, so a refusal or an unreadable family must
   * throw here — returning fewer projections than the plan authorized would
   * make the executor's row-count check pass against a short read.
   */
  async loadForPlan(plan: StoredExecutionPlanV1): Promise<PromotionProjectionInputV1[]> {
    const scope = plan.plan.scope;
    const result = await this.loadForScope({
      fiscalYear: scope.fiscalYear,
      families: scope.families,
    });
    if (result.unsupportedFamilies.length > 0) {
      throw new Error(
        `promotion projection source has no reader for family/families ${result.unsupportedFamilies.join(', ')}; plan ${plan.planId} cannot be reloaded`,
      );
    }
    if (result.refusals.length > 0) {
      throw new Error(
        `promotion projection source refused ${result.refusals.length} candidate(s) for plan ${plan.planId}: ${result.refusals.map((refusal) => refusal.detail).join('; ')}`,
      );
    }
    return result.projections;
  }

  /**
   * O&M (Workstream H). One query: a SAG identity is only in scope when it has
   * a funding row in the requested fiscal year, which also guarantees the
   * planner sees every year row's structural parent.
   */
  private async loadOm(fiscalYear: number): Promise<{
    projections: PromotionProjectionInputV1[];
    refusals: ProjectorRefusalV1[];
    identitiesWithoutScopedFunding: number;
  }> {
    const rows = await this.prisma.$queryRawUnsafe<OmSagYearRowV1[]>(
      `SELECT s."natural_key" AS "naturalKey", s."component", s."account",
              s."sag_code" AS "sagCode", s."title",
              y."fiscal_year" AS "fiscalYear", y."funding_field" AS "fundingField",
              y."amount_millions"::text AS "amountMillions",
              y."original_value" AS "originalValue", y."original_unit" AS "originalUnit",
              y."assertion_id" AS "assertionId",
              y."verification_candidate_id" AS "verificationCandidateId",
              y."verification_run_id" AS "verificationRunId",
              y."verification_decision_id" AS "verificationDecisionId",
              y."extraction_artifact_id" AS "artifactId",
              y."extraction_artifact_content_sha256" AS "artifactContentSha256",
              y."source_pdf_sha256" AS "sourcePdfSha256",
              y."evidence_ids_jsonb" AS "evidenceIds",
              d."source_key" AS "sourceDocumentKey"
         FROM "om_sag_year" y
         JOIN "om_sag" s ON s."id" = y."om_sag_id"
         JOIN "source_document" d ON d."id" = y."source_document_id"
        WHERE y."fiscal_year" = $1
        ORDER BY s."natural_key", y."fiscal_year", y."funding_field"`,
      fiscalYear,
    );

    const totalIdentities = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS "count" FROM "om_sag"`,
    );

    const candidates: ProjectionCandidateInputV1[] = [];
    const identitySeen = new Set<string>();

    for (const row of rows) {
      const evidenceIds = evidenceIdsOf(row.evidenceIds);

      /* The identity row carries no lineage columns of its own — `om_sag` is a
       * pure identity table. Its provenance is therefore taken from the first
       * of its funding rows in deterministic (fiscal year, funding field)
       * order, which is the document that actually attested the identity.
       * Deterministic ordering matters: the plan hash must be reproducible. */
      if (!identitySeen.has(row.naturalKey)) {
        identitySeen.add(row.naturalKey);
        candidates.push({
          candidateId: `om_sag:${row.naturalKey}`,
          target: 'OmSag',
          naturalKey: row.naturalKey,
          operation: 'insert',
          reason: 'verified_projection',
          artifactId: row.artifactId,
          artifactContentSha256: row.artifactContentSha256,
          verificationCandidateId: row.verificationCandidateId,
          verificationRunId: row.verificationRunId,
          verificationDecisionId: row.verificationDecisionId,
          sourceDocumentKey: row.sourceDocumentKey,
          sourcePdfSha256: row.sourcePdfSha256,
          assertionIds: [row.assertionId],
          evidenceIds,
          values: {
            naturalKey: row.naturalKey,
            component: row.component,
            account: row.account,
            sagCode: row.sagCode,
            title: row.title,
          },
        });
      }

      candidates.push({
        candidateId: `om_sag_year:${row.naturalKey}:${row.fiscalYear}:${row.fundingField}`,
        target: 'OmSagYear',
        naturalKey: `${row.naturalKey}|${row.fiscalYear}|${row.fundingField}`,
        operation: 'insert',
        reason: 'verified_projection',
        artifactId: row.artifactId,
        artifactContentSha256: row.artifactContentSha256,
        verificationCandidateId: row.verificationCandidateId,
        verificationRunId: row.verificationRunId,
        verificationDecisionId: row.verificationDecisionId,
        sourceDocumentKey: row.sourceDocumentKey,
        sourcePdfSha256: row.sourcePdfSha256,
        assertionIds: [row.assertionId],
        evidenceIds,
        values: {
          identityNaturalKey: row.naturalKey,
          fiscalYear: row.fiscalYear,
          fundingField: row.fundingField,
          // Exact decimal string straight from NUMERIC — never parsed to float.
          valueMillions: normalizeDecimal(row.amountMillions),
          originalValue: row.originalValue,
          originalUnit: row.originalUnit,
        },
      });
    }

    const { projections, refusals } = projectOmCandidatesV1(candidates);
    return {
      projections,
      refusals,
      identitiesWithoutScopedFunding: Math.max(
        0,
        Number(totalIdentities[0]?.count ?? 0) - identitySeen.size,
      ),
    };
  }

  /**
   * Committee/Phase 6 (Gap 1). Reads what `phase6-projection-builder-v1.ts`
   * actually persists — `stage_position` and identity-scoped `stage_action`
   * rows for stages HASC/SASC/HAC-D/SAC-D/NDAA conference/appropriations
   * conference — and reconstructs each into the exact
   * `Phase6NativeProjectionV1` shape `projectPhase6ProjectionsV1` already
   * validates, rather than re-deriving a looser shape from raw columns. Only
   * `verified` rows are read: `candidate`/`blocked`/`superseded` are review
   * data and `projectPhase6ProjectionsV1` refuses them anyway, but filtering
   * here keeps a promotion plan from growing every review-only row a real
   * cycle accumulates.
   *
   * Fiscal year lives only in `payload_jsonb.fiscalYear` (there is no
   * dedicated column on `phase6_audit_projection`), so the scope filter reads
   * it out of the JSONB payload.
   */
  private async loadCommittee(fiscalYear: number): Promise<{
    projections: PromotionProjectionInputV1[];
    refusals: ProjectorRefusalV1[];
  }> {
    const rows = await this.prisma.$queryRawUnsafe<Phase6ProjectionRowV1[]>(
      `SELECT "projection_id" AS "projectionId", "natural_key" AS "naturalKey",
              "idempotency_key" AS "idempotencyKey", "projection_kind" AS "projectionKind",
              "verification_candidate_id" AS "verificationCandidateId",
              "verification_run_id" AS "verificationRunId",
              "artifact_id" AS "artifactId",
              "artifact_content_sha256" AS "artifactContentSha256",
              "source_document_id" AS "sourceDocumentId",
              "source_pdf_sha256" AS "sourcePdfSha256",
              "source_profile_hash" AS "sourceProfileHash",
              "native_identity_hash" AS "nativeIdentityHash",
              "track", "stage", "funding_field" AS "fundingField",
              "original_value" AS "originalValue", "original_unit" AS "originalUnit",
              "amount_millions"::text AS "amountMillions",
              "direct_or_derived" AS "directOrDerived",
              "evidence_ids_jsonb" AS "evidenceIds", "binding_status" AS "bindingStatus",
              "projection_status" AS "projectionStatus",
              "enactment_proof_id" AS "enactmentProofId",
              "payload_jsonb" AS "payload"
         FROM "phase6_audit_projection"
        WHERE "projection_status" = 'verified'
          AND "projection_kind" IN ('stage_position', 'stage_action')
          AND ("payload_jsonb"->>'fiscalYear')::int = $1
        ORDER BY "natural_key"`,
      fiscalYear,
    );

    const reconstructed: Phase6NativeProjectionV1[] = rows.map((row) => ({
      schemaVersion: 'phase6_native_projection_v1',
      projectionId: row.projectionId,
      naturalKey: row.naturalKey,
      idempotencyKey: row.idempotencyKey,
      projectionKind: row.projectionKind as Phase6NativeProjectionV1['projectionKind'],
      verificationCandidateId: row.verificationCandidateId,
      verificationRunId: row.verificationRunId,
      artifactId: row.artifactId,
      artifactContentSha256: row.artifactContentSha256,
      sourceDocumentId: row.sourceDocumentId,
      sourcePdfSha256: row.sourcePdfSha256,
      sourceProfileHash: row.sourceProfileHash,
      nativeIdentityHash: row.nativeIdentityHash,
      track: row.track as StageTrackV1,
      stage: row.stage as StageV1,
      ...(row.fundingField != null
        ? { fundingField: row.fundingField as Phase6NativeProjectionV1['fundingField'] }
        : {}),
      ...(row.originalValue != null && row.originalUnit != null
        ? {
            money: {
              originalValue: row.originalValue,
              originalUnit: row.originalUnit as 'dollars' | 'thousands' | 'millions',
              valueMillions: normalizeDecimal(row.amountMillions ?? '0'),
            },
          }
        : {}),
      directOrDerived: row.directOrDerived as Phase6NativeProjectionV1['directOrDerived'],
      evidenceIds: evidenceIdsOf(row.evidenceIds),
      bindingStatus: row.bindingStatus as Phase6NativeProjectionV1['bindingStatus'],
      projectionStatus: row.projectionStatus as Phase6NativeProjectionV1['projectionStatus'],
      ...(row.enactmentProofId != null ? { enactmentProofId: row.enactmentProofId } : {}),
      payload: (row.payload ?? {}) as Phase6NativeProjectionV1['payload'],
      canonicalWriteAllowed: false,
    }));

    return projectPhase6ProjectionsV1(reconstructed);
  }
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
  amountMillions: string | null;
  directOrDerived: string;
  evidenceIds: unknown;
  bindingStatus: string;
  projectionStatus: string;
  enactmentProofId: string | null;
  payload: unknown;
}
