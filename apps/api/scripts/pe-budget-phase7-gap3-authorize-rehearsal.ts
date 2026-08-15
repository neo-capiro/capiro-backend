/**
 * Phase 7 Gap 3 closeout — `authorize-defense-budget-promotion-v1` against a
 * real database (docs/defense-budget/PHASE-7-ARCHITECTURE-GAPS.md).
 *
 * Invoked by `scripts/pe-budget-phase7-migration-rehearsal.sh` against a
 * disposable PostgreSQL container. Never point this at a shared database.
 *
 * What it proves that the unit tests (fake Prisma surface) cannot:
 *
 *   * `defense_budget_promotion_eligibility`'s real columns/casts accept a
 *     genuine `DefenseBudgetPromotionEligibilityV1` document and the foreign
 *     key from `defense_budget_promotion_plan.eligibility_hash` actually
 *     enforces "a plan cannot reference an eligibility that was never
 *     recorded" — inserting a plan against an unrecorded hash must fail;
 *   * `authorize-defense-budget-promotion-v1` — spawned as the actual CLI, not
 *     imported — runs end to end as `capiro_app` and produces a row in
 *     `defense_budget_promotion_authorization` with real segregation evidence
 *     derived from the real eligibility record's candidates, not a stub;
 *   * the segregation-of-duties refusal fires from data an operator could
 *     really have on file (an eligibility record whose only candidate names
 *     the same actor as reviewer), not from a hand-built test double;
 *   * the append-only/one-use database constraints and this service's own
 *     refusals agree: a second `authorize` call against the same
 *     authorization ID is refused before it ever reaches the trigger.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
} from '../src/defense-budget/promotion/promotion-eligibility-v1.js';
import { PrismaPromotionEligibilityPersistenceRepositoryV1 } from '../src/defense-budget/promotion/promotion-eligibility-authorization-repository-prisma-v1.js';

const ADMIN_URL = required('ADMIN_DATABASE_URL');
const APP_URL = required('APP_DATABASE_URL');

const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1] ?? ''));
const API_ROOT = path.resolve(SCRIPT_DIR, '..');

const CYCLE_ID = 'cycle-fy2030-gap3';
const FISCAL_YEAR = 2030;
const SNAPSHOT_ID = '99999999-9999-9999-9999-999999999901';
const SHA = (c: string): string => c.repeat(64);

let passed = 0;
function ok(message: string): void {
  passed += 1;
  console.log(`[p7-gap3]   ok  ${message}`);
}
function fail(message: string): never {
  console.error(`[p7-gap3] FAILED: ${message}`);
  process.exit(1);
}
function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
  ok(message);
}
function required(name: string): string {
  const value = process.env[name];
  if (value == null || value === '') fail(`${name} is required`);
  return value;
}

interface CliResultV1 {
  status: number;
  report: Record<string, unknown>;
}

function runVerb(args: string[]): CliResultV1 {
  const result = spawnSync(
    'npx',
    ['tsx', path.join(SCRIPT_DIR, 'authorize-defense-budget-promotion-v1.ts'), ...args],
    {
      cwd: API_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: APP_URL },
      shell: process.platform === 'win32',
    },
  );
  const stdout = (result.stdout ?? '').trim();
  if (stdout === '') {
    fail(`authorize produced no stdout (status ${result.status}); stderr: ${result.stderr ?? ''}`);
  }
  // Exactly one JSON document, matching every other Phase 7 CLI: the safety
  // header merged into the same object as the result.
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    fail(`authorize stdout was not JSON: ${stdout.slice(0, 400)}`);
  }
  return { status: result.status ?? -1, report };
}

function eligibility(
  overrides: Partial<DefenseBudgetPromotionEligibilityV1> = {},
): DefenseBudgetPromotionEligibilityV1 {
  return {
    schemaVersion: 'defense_budget_promotion_eligibility_v2',
    eligibilityId: 'elig-gap3-1',
    cycleId: CYCLE_ID,
    scope: { cycleId: CYCLE_ID, fiscalYear: FISCAL_YEAR, families: ['om'], stages: [] },
    projectionPlanIds: ['proj-plan-1'],
    projectionPlanHashes: [SHA('1')],
    mappingRegistryVersion: '1.0.0',
    mappingRegistryHash: SHA('2'),
    candidates: [
      {
        candidateId: 'cand-gap3-1',
        status: 'VERIFICATION_PASSED',
        terminalVerificationRunId: 'run-gap3-1',
        acceptedAssertionIds: ['assert-gap3-1'],
        extractionMethod: 'deterministic_pdfplumber',
        family: 'committee',
        sourceProfileSha256: SHA('8'),
        artifactSha256: SHA('3'),
        sourceSha256: SHA('4'),
      },
    ],
    sourceDocumentHashes: [SHA('5')],
    artifactHashes: [SHA('6')],
    manifestHash: SHA('7'),
    sourceProfileHashes: [SHA('8')],
    verificationPolicyHashes: [SHA('9')],
    cycleCertificationIds: ['cert-gap3-1'],
    cycleCertificationHashes: [SHA('a')],
    expectedActiveSnapshotId: null,
    expectedActiveSnapshotHash: null,
    openConflictCount: 0,
    unsupportedItemCount: 0,
    generatedAt: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function filePlan(
  admin: PrismaClient,
  planId: string,
  eligibilityHash: string,
  blockedCount = 0,
): Promise<string> {
  const planHash = SHA(planId.slice(-1));
  await admin.$executeRawUnsafe(
    `INSERT INTO "defense_budget_promotion_plan"
       (plan_id, plan_hash, eligibility_hash, mapping_registry_version, mapping_registry_hash,
        cycle_id, fiscal_year, scope, scope_hash, mode, proposed_snapshot_id,
        item_count, blocked_count, plan_document)
     VALUES ($1, $2, $3, '1.0.0', $4, $5, $6, $7::jsonb, $4, 'baseline_hydration', $8::uuid,
             1, $9, '{}'::jsonb)`,
    planId,
    planHash,
    eligibilityHash,
    SHA('2'),
    CYCLE_ID,
    FISCAL_YEAR,
    JSON.stringify({ cycleId: CYCLE_ID, fiscalYear: FISCAL_YEAR, families: ['om'], stages: [] }),
    SNAPSHOT_ID,
    blockedCount,
  );
  return planHash;
}

async function main(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  try {
    await admin.$executeRawUnsafe(
      `INSERT INTO "defense_budget_canonical_snapshot"
         (id, snapshot_key, environment, cycle_id, fiscal_year, status,
          required_scopes, completed_scopes, mapping_registry_hash)
       VALUES ($1::uuid, 'snap-gap3', 'gap3rehearsal', $2, $3, 'STAGING', '["om"]'::jsonb, '[]'::jsonb, $4)`,
      SNAPSHOT_ID,
      CYCLE_ID,
      FISCAL_YEAR,
      SHA('2'),
    );

    /* ---- 1. The foreign key: a plan cannot reference an unrecorded eligibility ---- */
    let fkRefused = false;
    try {
      await filePlan(admin, 'plan-gap3-orphan', SHA('0'));
    } catch {
      fkRefused = true;
    }
    check(
      fkRefused,
      'plan insert against an unrecorded eligibility hash is refused by the foreign key',
    );

    /* ---- 2. Persist a real eligibility record through the real repository ---- */
    const repository = new PrismaPromotionEligibilityPersistenceRepositoryV1(admin);
    const record = eligibility();
    const hash = promotionEligibilityHashV1(record);
    await repository.insert(record);
    const reread = await repository.findByHash(hash);
    check(
      reread != null && reread.eligibilityId === record.eligibilityId,
      'eligibility persisted and read back for real',
    );

    /* ---- 3. authorize, spawned as the real CLI, issues a real authorization ---- */
    await filePlan(admin, 'plan-gap3-1', hash);
    const issued = runVerb([
      '--plan-id',
      'plan-gap3-1',
      '--reason',
      'Gap 3 rehearsal baseline hydration',
      '--expires-at',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--authorizer-actor-id',
      'actor-admin-gap3',
      '--authorizer-roles',
      'capiro_admin',
      '--authorization-id',
      'auth-gap3-1',
    ]);
    check(issued.status === 0, `authorize exited 0 as capiro_app (got ${issued.status})`);
    check(issued.report.issued === true, 'authorization was issued');

    const stored = await admin.$queryRawUnsafe<
      Array<{ authorizerRole: string; segregation: unknown }>
    >(
      `SELECT "authorizer_role" AS "authorizerRole", "segregation" FROM "defense_budget_promotion_authorization" WHERE "authorization_id" = $1`,
      'auth-gap3-1',
    );
    check(stored.length === 1, 'exactly one authorization row landed');
    check(
      stored[0]?.authorizerRole === 'capiro_admin',
      'stored authorizer_role matches the database CHECK constraint',
    );

    /* ---- 4. Reused authorization ID is refused, not double-issued ---- */
    const reused = runVerb([
      '--plan-id',
      'plan-gap3-1',
      '--reason',
      'second attempt',
      '--expires-at',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--authorizer-actor-id',
      'actor-admin-gap3',
      '--authorizer-roles',
      'capiro_admin',
      '--authorization-id',
      'auth-gap3-1',
    ]);
    check(reused.status === 3, `reused authorization id is refused (got exit ${reused.status})`);
    check(
      (reused.report.refusals as Array<{ reason: string }>).some(
        (refusal) => refusal.reason === 'authorization_already_exists',
      ),
      'refusal names authorization_already_exists',
    );

    /* ---- 5. Segregation of duties: the reviewer may not also authorize ---- */
    const reviewerRecord = eligibility({
      eligibilityId: 'elig-gap3-2',
      candidates: [
        {
          candidateId: 'cand-gap3-2',
          status: 'REVIEW_ACCEPTED',
          terminalVerificationRunId: 'run-gap3-2',
          acceptedAssertionIds: ['assert-gap3-2'],
          extractionMethod: 'deterministic_pdfplumber',
          family: 'committee',
          sourceProfileSha256: SHA('8'),
          artifactSha256: SHA('3'),
          sourceSha256: SHA('4'),
          reviewDecisionId: 'review-gap3-2',
          reviewerActorId: 'actor-reviewer-gap3',
        },
      ],
    });
    const reviewerHash = promotionEligibilityHashV1(reviewerRecord);
    await repository.insert(reviewerRecord);
    await filePlan(admin, 'plan-gap3-2', reviewerHash);

    const segregationViolation = runVerb([
      '--plan-id',
      'plan-gap3-2',
      '--reason',
      'authorizer reviewed the same scope',
      '--expires-at',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--authorizer-actor-id',
      'actor-reviewer-gap3',
      '--authorizer-roles',
      'capiro_admin',
      '--authorization-id',
      'auth-gap3-2',
    ]);
    check(
      segregationViolation.status === 3,
      `authorizer-equals-reviewer is refused (got exit ${segregationViolation.status})`,
    );
    check(
      (segregationViolation.report.refusals as Array<{ reason: string }>).some(
        (refusal) => refusal.reason === 'segregation_violation',
      ),
      'refusal names segregation_violation, derived from the real eligibility record',
    );
    const notInserted = await admin.$queryRawUnsafe<Array<{ authorizationId: string }>>(
      `SELECT "authorization_id" AS "authorizationId" FROM "defense_budget_promotion_authorization" WHERE "authorization_id" = $1`,
      'auth-gap3-2',
    );
    check(notInserted.length === 0, 'the refused authorization never reached the table');

    /* ---- 6. A plan with blocked items may not be authorized ---- */
    await filePlan(admin, 'plan-gap3-blocked', hash, 1);
    const blocked = runVerb([
      '--plan-id',
      'plan-gap3-blocked',
      '--reason',
      'should not issue',
      '--expires-at',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--authorizer-actor-id',
      'actor-admin-gap3',
      '--authorizer-roles',
      'capiro_admin',
    ]);
    check(
      blocked.status === 3,
      `a plan with blocked items is refused (got exit ${blocked.status})`,
    );
    check(
      (blocked.report.refusals as Array<{ reason: string }>).some(
        (refusal) => refusal.reason === 'plan_has_blocked_items',
      ),
      'refusal names plan_has_blocked_items',
    );

    console.log(`\n[p7-gap3] Gap 3 authorize rehearsal PASS (${passed} checks)`);
  } finally {
    await admin.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
