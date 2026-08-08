/**
 * Gap 1 closeout — end-to-end producer rehearsal against a real database.
 *
 * Invoked by `scripts/phase6-producer-rehearsal.sh` against a disposable
 * PostgreSQL container carrying only the `phase6-projection` schema's
 * migrations. Never point this at a shared database.
 *
 * What it proves that the unit tests (which fake the Prisma surface) cannot:
 *
 *   * `phase6-projection-builder-v1.ts`'s output actually satisfies the real
 *     `phase6_audit_projection` table's constraints (not just the zod schema);
 *   * `PrismaPhase6AuditProjectionTransactionClientV1`'s raw SQL — column
 *     names, parameter order, the `::numeric`/`::jsonb` casts — is correct
 *     against the migration-created table, not just against a hand-rolled
 *     fake that mimics what the migration is believed to look like;
 *   * a value written as an exact decimal string comes back an exact decimal
 *     string, surviving Postgres's own `NUMERIC` padding;
 *   * `PrismaPromotionProjectionSourceV1`'s `committee` family reconstructs a
 *     real persisted row into a real `PromotionProjectionInputV1` that
 *     `buildPromotionPlanV1` could consume — the full chain the phase-7
 *     architecture gap said had no producer at any link.
 */
import { PrismaClient } from '@prisma/client';
import {
  buildStageActionProjectionV1,
  buildStagePositionProjectionV1,
  type Phase6ProjectionProvenanceV1,
} from '../src/defense-budget/phase6/phase6-projection-builder-v1.js';
import { certifyPhase6CycleV1 } from '../src/defense-budget/phase6/phase6-cycle-certification-v1.js';
import { Phase6AuditProjectionRepository } from '../src/defense-budget/phase6/phase6-audit-projection-repository.js';
import { PrismaPhase6AuditProjectionTransactionClientV1 } from '../src/defense-budget/phase6/phase6-audit-projection-repository-prisma-v1.js';
import { PrismaPromotionProjectionSourceV1 } from '../src/defense-budget/promotion/promotion-projection-source-prisma-v1.js';
import { nativeIdentityHashV1 } from '../src/defense-budget/stages/budget-line-reference-v1.js';
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

    const certification = certifyPhase6CycleV1({
      schemaVersion: 'phase6_cycle_certification_input_v1',
      cycleId: 'cycle-rehearsal-fy2027',
      fiscalYear: 2027,
      manifestHash: SHA('d'),
      documents: [{ documentKey: 'hac-d-report', required: true, status: 'present' }],
      projections: [positionResult.projection, actionResult.projection],
      comparisons: [],
      lineFamilyCoverage: { RDTE_PE: 1 },
      bindingCounts: { accepted: 2, candidate: 0, unresolved: 0, conflicting: 0 },
      enactmentProofCoverage: { direct: 0, incorporated: 0, unresolved: 0, blocked: 0 },
      reprogrammingCoverage: 0,
      executionCoverage: 0,
      parserStats: { localPages: 1, paidPages: 0, cacheHits: 0 },
    });
    check(certification.status === 'CERTIFIED', `cycle certified (status=${certification.status})`);

    const repository = new Phase6AuditProjectionRepository(
      new PrismaPhase6AuditProjectionTransactionClientV1(prisma),
    );
    const receipt = await repository.persistAuditOnly({
      projections: [positionResult.projection, actionResult.projection],
      certification,
      auditPersistenceAuthorized: true,
    });
    check(receipt.insertedProjectionIds.length === 2, 'persisted both projections on first write');
    check(!receipt.certificationReplayed, 'certification inserted, not replayed, on first write');

    const replay = await repository.persistAuditOnly({
      projections: [positionResult.projection, actionResult.projection],
      certification,
      auditPersistenceAuthorized: true,
    });
    check(
      replay.replayedProjectionIds.length === 2 && replay.insertedProjectionIds.length === 0,
      'replaying the identical cycle recognizes existing rows rather than duplicating them',
    );
    check(replay.certificationReplayed, 'certification replay detected on second write');

    const source = new PrismaPromotionProjectionSourceV1(prisma);
    const { projections, refusals, unsupportedFamilies } = await source.loadForScope({
      fiscalYear: 2027,
      families: ['committee'],
    });
    check(unsupportedFamilies.length === 0, 'committee family is recognized as supported');
    check(refusals.length === 0, `no refusals reading back (${JSON.stringify(refusals)})`);
    check(projections.length === 2, `both kinds round-tripped (got ${projections.length})`);

    const readPosition = projections.find((p) => p.projectionKind === 'phase6:stage_position');
    if (readPosition == null) fail('stage_position projection missing from read-back');
    check(readPosition.fundingField === 'hacDMark', 'read-back position kept its funding field');
    check(
      readPosition.values.money?.valueMillions === '125.5',
      `exact decimal survived the NUMERIC round trip (got ${readPosition.values.money?.valueMillions})`,
    );
    check(
      readPosition.lineage.verificationRunId === 'vr-rehearsal',
      'read-back position kept real lineage, not a placeholder',
    );

    const readAction = projections.find((p) => p.projectionKind === 'phase6:stage_action');
    if (readAction == null) fail('stage_action projection missing from read-back');
    check(
      readAction.fundingField === null,
      'stage_action carries no funding field, even after round-trip',
    );
    check(
      readAction.values.attributes?.signedValueMillions === '-5',
      'stage_action signed amount survived as a payload attribute',
    );

    check(
      readPosition.naturalKey.startsWith(nativeIdentityHashV1(PE_IDENTITY)),
      'read-back natural key leads with the real nativeIdentityHash, not a placeholder',
    );

    console.log(`\n[p6-producer] Gap 1 producer rehearsal PASS (${passed} checks)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
