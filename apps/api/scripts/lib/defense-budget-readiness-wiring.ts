/**
 * Shared production construction for the Phase 10B cycle/family readiness
 * orchestrator. Both one-shot CLIs use this exact adapter graph so their
 * materialization, eligibility, planning, and persistence behavior cannot
 * drift through duplicated wiring.
 */
import type { PrismaClient } from '@prisma/client';
import type { CycleFamilyReadinessOrchestratorPortsV1 } from '../../src/defense-budget/promotion/readiness/cycle-family-readiness-orchestrator-v1.js';
import { PrismaReadinessCorpusLoaderV1 } from '../../src/defense-budget/promotion/readiness/prisma-readiness-corpus-loader-v1.js';
import { PrismaFamilyReconciliationCertificationV1 } from '../../src/defense-budget/promotion/readiness/prisma-family-reconciliation-certification-v1.js';
import { MaterializingFamilyReconciliationCertificationV1 } from '../../src/defense-budget/promotion/readiness/materializing-family-reconciliation-certification-v1.js';
import { PrismaCycleManifestRegistryV1 } from '../../src/defense-budget/promotion/readiness/prisma-cycle-manifest-registry-v1.js';
import { PrismaMaterializationArtifactSourceV1 } from '../../src/defense-budget/promotion/readiness/prisma-materialization-artifact-source-v1.js';
import { PrismaPromotionPlanInputLoaderV1 } from '../../src/defense-budget/promotion/readiness/prisma-promotion-plan-input-loader-v1.js';
import { PrismaPromotionPlanPersistenceV1 } from '../../src/defense-budget/promotion/readiness/prisma-promotion-plan-persistence-v1.js';
import { PrismaPromotionEligibilityReadRepositoryV1 } from '../../src/defense-budget/promotion/promotion-eligibility-read-repository-prisma-v1.js';
import { PrismaPromotionAuditSinkV1 } from '../../src/defense-budget/promotion/promotion-eligibility-service-v1.js';
import { PrismaProjectionPlanRepositoryV1 } from '../../src/defense-budget/projection-plan/projection-plan-repository-prisma-v1.js';
import { SdkS3ProofClient } from '../../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';

function productionS3ArtifactReader() {
  const client = new SdkS3ProofClient();
  return {
    async readObject(locator: string): Promise<Buffer> {
      const parsed = new URL(locator);
      if (parsed.protocol !== 's3:' || !parsed.hostname || parsed.pathname.length < 2) {
        throw new Error(`invalid S3 materialization artifact locator: ${locator}`);
      }
      const bytes = await client.getObjectBytes(
        parsed.hostname,
        parsed.pathname.slice(1),
        parsed.searchParams.get('versionId') ?? undefined,
      );
      if (!bytes) throw new Error(`materialization artifact object missing: ${locator}`);
      return bytes;
    },
  };
}

export function buildCycleFamilyReadinessPorts(
  prisma: PrismaClient,
  options: { domain: string; environment: string },
): CycleFamilyReadinessOrchestratorPortsV1 {
  const readOnly = new PrismaFamilyReconciliationCertificationV1(prisma);
  return {
    corpusLoader: new PrismaReadinessCorpusLoaderV1(prisma),
    reconciliationCertification: new MaterializingFamilyReconciliationCertificationV1(
      readOnly,
      new PrismaCycleManifestRegistryV1(prisma),
      new PrismaMaterializationArtifactSourceV1(prisma, productionS3ArtifactReader()),
      new PrismaProjectionPlanRepositoryV1(prisma),
      'run-defense-budget-cycle-family-readiness-v1@1',
    ),
    eligibilityRepository: new PrismaPromotionEligibilityReadRepositoryV1(prisma),
    eligibilityAudit: new PrismaPromotionAuditSinkV1(prisma.defenseBudgetPromotionAudit),
    planInputs: new PrismaPromotionPlanInputLoaderV1(prisma, options.domain, options.environment),
    planPersistence: new PrismaPromotionPlanPersistenceV1(prisma),
    now: () => new Date(),
  };
}
