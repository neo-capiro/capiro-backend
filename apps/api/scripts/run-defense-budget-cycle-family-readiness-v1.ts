/**
 * run-defense-budget-cycle-family-readiness-v1 (Phase 10B-2D) — the real,
 * end-to-end production wiring site for
 * `evaluateAndAdvanceCycleFamilyReadinessV1`.
 *
 * Phase 10B-2A/B/C only ever exercised the orchestrator via specs (fakes,
 * or real-adapter-pairs assembled inline in a spec file) — there was no
 * script or NestJS provider anywhere in `apps/api` that actually
 * constructed `CycleFamilyReadinessOrchestratorPortsV1` with every real
 * adapter and called `run()`. This script is that site, matching the
 * orchestrator's own file header ("a caller — a one-shot CLI, or the
 * bridge's own post-success hook in a LATER phase — invokes run() once per
 * affected (fiscalYear, authorityTrack, familyGroup) scope").
 *
 *   run-defense-budget-cycle-family-readiness-v1
 *     --environment <env> --fiscal-year <fy> --authority-track <track>
 *     --family <procurement|om|milcon|rdte|committee>
 *     [--mode new_cycle|baseline_hydration|correction|rollback]
 *     [--domain <domain>] [--requested-by <actorId>]
 *
 * ABSOLUTE INVARIANT (same as the orchestrator itself): this script never
 * imports, references, or calls `DefenseBudgetPromotionAuthorizationServiceV1
 * .issue`, `DefenseBudgetCanonicalPromotionServiceV1.execute`, and never
 * reads the promoter-only database credential env var. It stops at
 * `awaiting_authorization` and prints a read-only report; nothing here
 * authorizes or executes canonical promotion. Grep this file for those
 * identifiers to verify: there are none.
 *
 * `MaterializingFamilyReconciliationCertificationV1` is wired as the
 * `reconciliationCertification` port here — the ONE production construction
 * site the 10B-2D handoff asked for — composing (never replacing) the
 * unchanged #1298 read-only adapter `PrismaFamilyReconciliationCertificationV1`.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  evaluateAndAdvanceCycleFamilyReadinessV1,
  type CycleFamilyReadinessOrchestratorPortsV1,
} from '../src/defense-budget/promotion/readiness/cycle-family-readiness-orchestrator-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from '../src/defense-budget/promotion/readiness/cycle-family-readiness-v1.js';
import { PrismaReadinessCorpusLoaderV1 } from '../src/defense-budget/promotion/readiness/prisma-readiness-corpus-loader-v1.js';
import { PrismaFamilyReconciliationCertificationV1 } from '../src/defense-budget/promotion/readiness/prisma-family-reconciliation-certification-v1.js';
import { MaterializingFamilyReconciliationCertificationV1 } from '../src/defense-budget/promotion/readiness/materializing-family-reconciliation-certification-v1.js';
import { PrismaCycleManifestRegistryV1 } from '../src/defense-budget/promotion/readiness/prisma-cycle-manifest-registry-v1.js';
import { PrismaMaterializationArtifactSourceV1 } from '../src/defense-budget/promotion/readiness/prisma-materialization-artifact-source-v1.js';
import { PrismaPromotionPlanInputLoaderV1 } from '../src/defense-budget/promotion/readiness/prisma-promotion-plan-input-loader-v1.js';
import { PrismaPromotionPlanPersistenceV1 } from '../src/defense-budget/promotion/readiness/prisma-promotion-plan-persistence-v1.js';
import { PrismaPromotionEligibilityReadRepositoryV1 } from '../src/defense-budget/promotion/promotion-eligibility-read-repository-prisma-v1.js';
import { PrismaPromotionAuditSinkV1 } from '../src/defense-budget/promotion/promotion-eligibility-service-v1.js';
import { PrismaProjectionPlanRepositoryV1 } from '../src/defense-budget/projection-plan/projection-plan-repository-prisma-v1.js';
import type { PromotionModeV1 } from '../src/defense-budget/promotion/promotion-planner-v1.js';

dotenvConfig();

const DEFAULT_DOMAIN = 'defense_budget';
const PROMOTION_MODES: readonly PromotionModeV1[] = [
  'baseline_hydration',
  'new_cycle',
  'correction',
  'rollback',
];
const FAMILY_GROUPS: readonly CycleFamilyReadinessIdentityV1['familyGroup'][] = [
  'rdte',
  'procurement',
  'om',
  'milcon',
  'committee',
];

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(message: string): never {
  console.error(`run-defense-budget-cycle-family-readiness-v1: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const environment = argValue('--environment');
  const fiscalYearRaw = argValue('--fiscal-year');
  const authorityTrack = argValue('--authority-track');
  const family = argValue('--family');
  const domain = argValue('--domain') ?? DEFAULT_DOMAIN;
  const requestedByActorId = argValue('--requested-by');
  const mode = (argValue('--mode') ?? 'new_cycle') as PromotionModeV1;

  if (!environment) usage('--environment is required');
  if (!fiscalYearRaw) usage('--fiscal-year is required');
  if (!authorityTrack) usage('--authority-track is required');
  if (!family) usage('--family is required');
  if (!PROMOTION_MODES.includes(mode)) {
    usage(`--mode must be one of ${PROMOTION_MODES.join(', ')} (got ${mode})`);
  }
  if (!(FAMILY_GROUPS as readonly string[]).includes(family)) {
    usage(`--family must be one of ${FAMILY_GROUPS.join(', ')} (got ${family})`);
  }

  const fiscalYear = Number(fiscalYearRaw);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) {
    usage(`--fiscal-year must be an integer between 1900 and 2200 (got ${fiscalYearRaw})`);
  }

  const identity: CycleFamilyReadinessIdentityV1 = {
    fiscalYear,
    authorityTrack: authorityTrack as CycleFamilyReadinessIdentityV1['authorityTrack'],
    familyGroup: family as CycleFamilyReadinessIdentityV1['familyGroup'],
  };

  const prisma = new PrismaClient();
  try {
    // The read-only #1298 adapter, UNCHANGED — the decorator composes it,
    // never replaces it, and the decorator's final answer always flows back
    // through this exact instance (see the decorator's own header).
    const readOnlyCertification = new PrismaFamilyReconciliationCertificationV1(prisma);

    const reconciliationCertification = new MaterializingFamilyReconciliationCertificationV1(
      readOnlyCertification,
      new PrismaCycleManifestRegistryV1(prisma),
      new PrismaMaterializationArtifactSourceV1(prisma),
      // ProjectionPlanRepositoryV1 -- reuse the exact same substrate every
      // other Phase 4/5/6 producer already writes through.
      new PrismaProjectionPlanRepositoryV1(prisma),
      'run-defense-budget-cycle-family-readiness-v1@1',
    );

    const ports: CycleFamilyReadinessOrchestratorPortsV1 = {
      corpusLoader: new PrismaReadinessCorpusLoaderV1(prisma),
      reconciliationCertification,
      eligibilityRepository: new PrismaPromotionEligibilityReadRepositoryV1(prisma),
      eligibilityAudit: new PrismaPromotionAuditSinkV1(prisma.defenseBudgetPromotionAudit),
      planInputs: new PrismaPromotionPlanInputLoaderV1(prisma, domain, environment),
      planPersistence: new PrismaPromotionPlanPersistenceV1(prisma),
      now: () => new Date(),
    };

    const result = await evaluateAndAdvanceCycleFamilyReadinessV1(identity, ports, {
      mode,
      domain,
      environment,
      ...(requestedByActorId != null ? { requestedByActorId } : {}),
    });

    console.log(
      JSON.stringify(
        {
          safety:
            'Stops at awaiting_authorization. No canonical promotion authorization or execution occurs from this script.',
          identity,
          environment,
          domain,
          mode,
          outcome: result.outcome,
          detail: result.detail,
          readinessState: result.readiness.state,
          reconciliationCertified: result.reconciliation?.certified ?? null,
          reconciliationStatus: result.reconciliation?.certificationStatus ?? null,
          planId: result.planId,
          planHash: result.planHash,
          planReplay: result.planReplay,
          eligibilityHash: result.eligibilityHash,
        },
        null,
        2,
      ),
    );

    if (result.outcome === 'reconciliation_failed' || result.outcome === 'certification_failed') {
      process.exit(3);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('run-defense-budget-cycle-family-readiness-v1 FAILED:', error);
  process.exit(1);
});
