/**
 * Phase 10B-2 Gap 2b — real `FamilyReconciliationCertificationPortV1` adapter.
 *
 * Design choice (documented per the repair brief, and restated in the PR
 * report): this adapter reads the ALREADY-PERSISTED certification outcome
 * that the existing Phase 4/5/6 pipelines wrote when they last ran — it does
 * NOT re-invoke `certifyRdteCycle` / `certifyNonRdteCycle` /
 * `certifyPhase6CycleV1` itself. Those pure certifier functions each need a
 * full family-specific input assembled from a full annual cycle's documents,
 * artifacts, and verifications (`RdteCycleCertifyInput`,
 * `NonRdteCycleCertifyInput`, `Phase6CycleCertificationInputV1`); there is no
 * durable table that stores a re-callable copy of that whole input for
 * later replay — only the OUTPUT is durably stored. Re-deriving the INPUT
 * here would mean silently rebuilding the entire Phase 4/5/6 annual pipeline
 * inside a "thin adapter", which is explicitly out of scope. Reading the
 * already-certified OUTPUT is therefore the only honest thin-wrapper design.
 *
 * Where the output actually lives, precisely (verified against this repo's
 * real schema and the real Phase 7 `loadCycleCertifications` implementation
 * — see `promotion-eligibility-read-repository-prisma-v1.ts`):
 *
 *   - `rdte` | `procurement` | `om` | `milcon`: Phase 4/5 certify INSIDE the
 *     cycle bundle document itself (`certification: cycleCertificationV1Schema`
 *     on `RdteCycleBundleV1`/`NonRdteCycleBundleV1`) and that bundle is filed
 *     as one row in `defense_budget_projection_plan` (`family`, `cycleId`,
 *     `certificationSha256` = the bundle's own `contentSha256`,
 *     `certificationId` = null for these families — there is no separate
 *     certification row to name).
 *   - `committee`: Phase 6 certifies via a SEPARATE row in
 *     `phase6_cycle_certification` (`content_sha256`, `status`), which
 *     `defense_budget_projection_plan.certificationId` names for committee
 *     plans.
 *
 * HISTORICAL NOTE (fixed by Phase 10B-2C — read this only if you are
 * wondering why the eligibility gate used to reject a genuinely certified
 * RDT&E/procurement/O&M/MILCON family): `DefenseBudgetPromotionEligibilityServiceV1`
 * used to read its certified set EXCLUSIVELY from `phase6_cycle_certification`
 * via `loadCycleCertifications(cycleId, fiscalYear)`. Nothing in the RDT&E or
 * non-RDT&E pipelines (`rdte-cycle-pipeline-v1.ts`, `non-rdte-cycle-pipeline-v1.ts`,
 * `build-rdte-cycle.ts`) ever inserts a row into `phase6_cycle_certification`
 * — only Phase 6's own `phase6-audit-projection-repository-prisma-v1.ts`
 * does — so a real RDT&E/procurement/om/milcon cycle this adapter correctly
 * reported `certified: true` for would still fail the very next orchestrator
 * step with `cycle_certification_missing`. This was
 * `PHASE10B2_EXISTING_ELIGIBILITY_CERTIFICATION_BOUNDARY_GAP`, and Phase
 * 10B-2C closed it by widening `PrismaPromotionEligibilityReadRepositoryV1
 * .loadCycleCertifications` to ALSO read the same embedded-bundle
 * certification this adapter reads (via the shared
 * `family-certified-plan-read-v1.ts` helper both modules now import), scoped
 * to the exact families in the eligibility request — never by writing a fake
 * Phase 6 committee row for a non-committee family. See
 * `promotion-eligibility-read-repository-prisma-v1.ts`'s own header for the
 * exact mechanics.
 */
import type { CycleFamilyReadinessIdentityV1 } from './cycle-family-readiness-v1.js';
import type {
  FamilyReconciliationCertificationPortV1,
  FamilyReconciliationCertificationResultV1,
} from './cycle-family-readiness-orchestrator-v1.js';
import type { CycleFamilyCorpusInputV1 } from './cycle-family-readiness-v1.js';
import { deriveFamilyCertifiedPlanFactV1 } from '../family-certified-plan-read-v1.js';

export interface FamilyCertificationPrismaQueryPortV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

type ProjectionPlanCertRow = {
  certificationSha256: string;
  certificationId: string | null;
  status: string;
  conflictCount: number;
  planDocument: unknown;
};

type Phase6CertRow = {
  certificationId: string;
  contentSha256: string;
  status: string;
};

/**
 * Real thin adapter for `FamilyReconciliationCertificationPortV1`. Selects
 * exactly one existing certified-output source per `identity.familyGroup`
 * and maps its status literal to the port's result shape — it never
 * computes, recomputes, or fabricates a certification decision.
 */
export class PrismaFamilyReconciliationCertificationV1
  implements FamilyReconciliationCertificationPortV1
{
  constructor(private readonly prisma: FamilyCertificationPrismaQueryPortV1) {}

  async reconcileAndCertify(
    identity: CycleFamilyReadinessIdentityV1,
    corpus: CycleFamilyCorpusInputV1,
  ): Promise<FamilyReconciliationCertificationResultV1> {
    if (identity.familyGroup === 'committee') {
      return this.readCommitteeCertification(corpus.cycleId, identity.fiscalYear);
    }
    return this.readProjectionPlanCertification(corpus.cycleId, identity.familyGroup);
  }

  private async readProjectionPlanCertification(
    cycleId: string,
    family: string,
  ): Promise<FamilyReconciliationCertificationResultV1> {
    const rows = await this.prisma.$queryRawUnsafe<ProjectionPlanCertRow[]>(
      `SELECT "certification_sha256" AS "certificationSha256",
              "certification_id" AS "certificationId",
              "status", "conflict_count" AS "conflictCount", "plan_document" AS "planDocument"
         FROM "defense_budget_projection_plan"
        WHERE "cycle_id" = $1 AND "family" = $2
        ORDER BY "created_at" DESC LIMIT 1`,
      cycleId,
      family,
    );
    const row = rows[0];
    if (row == null) {
      return {
        certified: false,
        certificationStatus: 'INCOMPLETE',
        blockingFindingCount: 0,
        certificationContentSha256: null,
        certificationRowId: null,
        reason: `no projection plan has been filed for cycle ${cycleId} family ${family} yet; Phase 4/5 has not certified this family`,
      };
    }
    const { certified, certificationStatus } = deriveFamilyCertifiedPlanFactV1(row);
    return {
      certified,
      certificationStatus,
      blockingFindingCount: row.conflictCount,
      certificationContentSha256: certified ? row.certificationSha256 : null,
      certificationRowId: null, // RDT&E/non-RDT&E self-certify inside the bundle; no separate row to name.
      reason: certified
        ? `filed projection plan for cycle ${cycleId} family ${family} is certified (${certificationStatus})`
        : `filed projection plan for cycle ${cycleId} family ${family} reports ${certificationStatus}`,
    };
  }

  private async readCommitteeCertification(
    cycleId: string,
    fiscalYear: number,
  ): Promise<FamilyReconciliationCertificationResultV1> {
    const rows = await this.prisma.$queryRawUnsafe<Phase6CertRow[]>(
      `SELECT "id"::text AS "certificationId", "content_sha256" AS "contentSha256", "status"
         FROM "phase6_cycle_certification"
        WHERE "cycle_id" = $1 AND "fiscal_year" = $2
        ORDER BY "created_at" DESC LIMIT 1`,
      cycleId,
      fiscalYear,
    );
    const row = rows[0];
    if (row == null) {
      return {
        certified: false,
        certificationStatus: 'INCOMPLETE',
        blockingFindingCount: 0,
        certificationContentSha256: null,
        certificationRowId: null,
        reason: `no Phase 6 cycle certification exists for ${cycleId} FY${fiscalYear} yet`,
      };
    }
    const certified = row.status === 'CERTIFIED';
    return {
      certified,
      certificationStatus: row.status,
      blockingFindingCount: 0,
      certificationContentSha256: certified ? row.contentSha256 : null,
      certificationRowId: certified ? row.certificationId : null,
      reason: certified
        ? `Phase 6 committee certification ${row.certificationId} for ${cycleId} FY${fiscalYear} is CERTIFIED`
        : `Phase 6 committee certification for ${cycleId} FY${fiscalYear} reports ${row.status}`,
    };
  }
}
