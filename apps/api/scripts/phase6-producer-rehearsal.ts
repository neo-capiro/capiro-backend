/**
 * Phase 6 producer rehearsal against a disposable PostgreSQL database.
 *
 * Proves the producer boundary that the repaired Phase 7 path actually trusts:
 * builder -> exact-set certification -> transactional audit persistence ->
 * immutable certification/projection bindings -> deterministic Phase 6 plan.
 *
 * It deliberately does NOT exercise the old broad fiscal-year projection
 * source. Production planning/execution now reload exact producer plans named
 * by persisted eligibility, so a rehearsal of "all rows in FY X" would test a
 * path that is no longer authoritative.
 */
import { PrismaClient } from '@prisma/client';
import {
  buildStageActionProjectionV1,
  buildStagePositionProjectionV1,
  type Phase6ProjectionProvenanceV1,
} from '../src/defense-budget/phase6/phase6-projection-builder-v1.js';
import { buildPhase6ProjectionPlanDocumentV1 } from '../src/defense-budget/phase6/phase6-projection-plan-builder-v1.js';
import { certifyPhase6CycleV1 } from '../src/defense-budget/phase6/phase6-cycle-certification-v1.js';
import { Phase6AuditProjectionRepository } from '../src/defense-budget/phase6/phase6-audit-projection-repository.js';
import { PrismaPhase6AuditProjectionTransactionClientV1 } from '../src/defense-budget/phase6/phase6-audit-projection-repository-prisma-v1.js';
import type { DefenseBudgetStageActionV1 } from '../src/defense-budget/stages/appropriations/actions/defense-budget-stage-action-v1.js';

const SHA = (c: string) => c.repeat(64);
const PE_IDENTITY = { lineKind: 'RDTE_PE' as const, peCode: '0605053A' };

let passed = 0;
function ok(message: string): void {
  passed += 1;
  console.log(`[p6-producer]   ok  ${message}`);
}
function fail(message: string): never {
  console.error(`[p6-producer] FAILED: ${message}`);
  process.exit(1);
}
function check(condition: boolean, message: string): void {
  if (condition) ok(message);
  else fail(message);
}

const PROVENANCE: Phase6ProjectionProvenanceV1 = {
  verificationCandidateId: 'vc-rehearsal',
  verificationRunId: 'vr-rehearsal',
  artifactId: 'artifact-rehearsal',
  artifactContentSha256: SHA('a'),
  sourceDocumentId: 'doc-rehearsal',
  sourcePdfSha256: SHA('b'),
  sourceProfileHash: SHA('c'),
  evidenceIds: ['ev-1', 'ev-2'],
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const positionResult = buildStagePositionProjectionV1(
      {
        identity: PE_IDENTITY,
        field: 'hacDMark',
        fiscalYear: 2027,
        value: '125.5',
        unit: 'millions',
        provenance: 'direct',
        rowIndex: 3,
        page: 12,
      },
      'hac_d',
      PROVENANCE,
      'verified',
    );
    if (!positionResult.ok) fail(`builder refused the position: ${positionResult.refusal.detail}`);
    ok('buildStagePositionProjectionV1 produced a projection');

    const action: DefenseBudgetStageActionV1 = {
      schemaVersion: 'defense_budget_stage_action_v1',
      actionId: 'act-rehearsal-1',
      track: 'appropriations',
      stage: 'hac_d',
      authority: 'hacd_appropriations',
      vehicleClass: 'committee_report',
      actionType: 'transfer_out',
      identity: PE_IDENTITY,
      fiscalYear: 2027,
      amount: { originalValue: '5', originalUnit: 'millions', valueMillions: '5' },
      signedValueMillions: '-5',
      direction: 'out',
      evidenceIds: ['ev-3'],
      languageEvidenceIds: [],
      directOrDerived: 'direct',
    };
    const actionResult = buildStageActionProjectionV1(action, PROVENANCE, 'verified');
    if (!actionResult.ok) fail(`builder refused the action: ${actionResult.refusal.detail}`);
    ok('buildStageActionProjectionV1 produced a projection');

    const sourceProjections = [positionResult.projection, actionResult.projection];
    const certification = certifyPhase6CycleV1({
      schemaVersion: 'phase6_cycle_certification_input_v1',
      cycleId: 'cycle-rehearsal-fy2027',
      fiscalYear: 2027,
      manifestHash: SHA('d'),
      documents: [{ documentKey: 'hac-d-report', required: true, status: 'present' }],
      projections: sourceProjections,
      comparisons: [],
      lineFamilyCoverage: { RDTE_PE: 1 },
      bindingCounts: { accepted: 2, candidate: 0, unresolved: 0, conflicting: 0 },
      enactmentProofCoverage: { direct: 0, incorporated: 0, unresolved: 0, blocked: 0 },
      reprogrammingCoverage: 0,
      executionCoverage: 0,
      parserStats: { localPages: 1, paidPages: 0, cacheHits: 0 },
    });
    check(certification.status === 'CERTIFIED', `cycle certified (status=${certification.status})`);
    check(certification.projectionCount === 2, 'certification binds the exact projection count');
    check(
      /^[0-9a-f]{64}$/.test(certification.projectionSetSha256),
      'certification binds a deterministic exact projection-set hash',
    );

    const repository = new Phase6AuditProjectionRepository(
      new PrismaPhase6AuditProjectionTransactionClientV1(prisma),
    );
    const receipt = await repository.persistAuditOnly({
      projections: sourceProjections,
      certification,
      auditPersistenceAuthorized: true,
    });
    check(receipt.insertedProjectionIds.length === 2, 'persisted both projections on first write');
    check(!receipt.certificationReplayed, 'certification inserted, not replayed, on first write');
    check(
      receipt.certificationProjectionIds.length === 2,
      'receipt reports the exact certification/projection association',
    );

    const replay = await repository.persistAuditOnly({
      projections: sourceProjections,
      certification,
      auditPersistenceAuthorized: true,
    });
    check(
      replay.replayedProjectionIds.length === 2 && replay.insertedProjectionIds.length === 0,
      'replaying the identical cycle recognizes existing rows rather than duplicating them',
    );
    check(replay.certificationReplayed, 'certification replay detected on second write');

    const bindings = await prisma.$queryRawUnsafe<Array<{ projectionId: string; ordinal: number }>>(
      `SELECT "projection_id" AS "projectionId", "projection_ordinal" AS "ordinal"
         FROM "phase6_cycle_certification_projection"
        WHERE "certification_content_sha256" = $1
        ORDER BY "projection_ordinal"`,
      certification.contentSha256,
    );
    check(bindings.length === 2, 'database stores two exact certification bindings');
    check(
      new Set(bindings.map((binding) => binding.projectionId)).size === 2,
      'certification association retains each projection exactly once',
    );

    const persisted = await prisma.$queryRawUnsafe<
      Array<{ projectionId: string; amountMillions: string | null; payload: Record<string, unknown> }>
    >(
      `SELECT "projection_id" AS "projectionId", "amount_millions"::text AS "amountMillions",
              "payload_jsonb" AS "payload"
         FROM "phase6_audit_projection"
        WHERE "projection_id" IN ($1, $2)
        ORDER BY "projection_id"`,
      positionResult.projection.projectionId,
      actionResult.projection.projectionId,
    );
    const persistedPosition = persisted.find(
      (candidate) => candidate.projectionId === positionResult.projection.projectionId,
    );
    const persistedAction = persisted.find(
      (candidate) => candidate.projectionId === actionResult.projection.projectionId,
    );
    check(
      Number(persistedPosition?.amountMillions) === 125.5,
      `exact decimal survives NUMERIC storage (got ${persistedPosition?.amountMillions ?? 'missing'})`,
    );
    check(
      persistedAction?.payload.signedValueMillions === '-5',
      'stage action signed amount survives JSONB storage',
    );

    const plan = buildPhase6ProjectionPlanDocumentV1({
      cycleId: certification.cycleId,
      fiscalYear: certification.fiscalYear,
      rows: sourceProjections,
    });
    check(plan.candidates.length === 2, 'exact certified set becomes two Phase 6 plan candidates');
    check(
      new Set(plan.candidates.flatMap((candidate) => candidate.sourceProjectionIds)).size === 2,
      'plan accounts for every certified projection ID exactly once',
    );
    check(/^[0-9a-f]{64}$/.test(plan.contentSha256), 'Phase 6 plan content is deterministically hashed');

    console.log(`\n[p6-producer] exact producer rehearsal PASS (${passed} checks)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
