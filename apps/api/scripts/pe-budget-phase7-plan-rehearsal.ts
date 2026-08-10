/**
 * Phase 7 Workstream N — plan/validate operator verbs against a real database.
 *
 * Invoked by `scripts/pe-budget-phase7-migration-rehearsal.sh` against a
 * disposable PostgreSQL container. Never point this at a shared database.
 *
 * What it proves that the unit tests cannot:
 *
 *   * the SQL inside `eligibility-bound-projection-source-prisma-v1.ts` reloads
 *     a real producer-plan row and re-projects it — the unit tests answer it
 *     with a fake client and prove nothing about column names;
 *   * `plan-defense-budget-promotion-v1` runs end to end **as the general
 *     application role**, which is the credential Workstream N assigns the
 *     planner, so a missing SELECT grant fails here rather than in production;
 *   * the same scope re-planned produces the same plan hash, which is the
 *     Workstream C determinism criterion and cannot be observed from one run;
 *   * `validate-defense-budget-promotion-v1` accepts a freshly filed plan and
 *     refuses a drifted one.
 *
 * Both verbs are spawned as the actual CLIs rather than imported, so what is
 * demonstrated is the command an operator will type.
 *
 * Gap closeout (eligibility-bound planning): the plan CLI no longer queries
 * live O&M tables by fiscal year. It reloads a content-addressed eligibility
 * document and the exact producer plans that document names. This rehearsal
 * therefore seeds those rows first, with a real v2 eligibility document —
 * not a placeholder hash and not an empty JSON blob.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  sha256CanonicalJson,
  type JsonValue,
} from '../src/defense-budget/contracts/canonical-json.js';
import {
  computeNonRdteProjectionPlanContentSha256,
  NON_RDTE_PROJECTION_PLAN_SCHEMA_VERSION,
  type NonRdteProjectionCandidateV1,
  type NonRdteProjectionExclusionV1,
} from '../src/defense-budget/non-rdte/non-rdte-canonical-projection-plan-v1.js';
import {
  DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
  canonicalMappingRegistryHashV1,
} from '../src/defense-budget/promotion/canonical-mapping-registry-v1.js';
import {
  DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION,
  defenseBudgetPromotionEligibilityV1Schema,
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
} from '../src/defense-budget/promotion/promotion-eligibility-v1.js';
import {
  buildProjectionPlanRecordV1,
  type DefenseBudgetProjectionPlanRecordV1,
} from '../src/defense-budget/projection-plan/projection-plan-record-v1.js';

const ADMIN_URL = required('ADMIN_DATABASE_URL');
const APP_URL = required('APP_DATABASE_URL');

// `process.argv[1]` rather than `import.meta.url`: this package builds to
// CommonJS, where import.meta is a compile error (TS1470).
const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1] ?? ''));
const API_ROOT = path.resolve(SCRIPT_DIR, '..');

// A distinct environment from every other section, so this plans against an
// empty pointer without interfering with the engine or read rehearsals.
const ENVIRONMENT = 'planrehearsal';
// Distinct cycle/year from the engine rehearsal so counts stay exact and the
// eligibility hash never collides with the engine's placeholder SHA('e') row.
const CYCLE_ID = 'cycle-fy2029-plan';
const FISCAL_YEAR = 2029;
const POSITION_CYCLE = 'pb_fy2029';
const SAG_NATURAL_KEY = 'OM_SAG:ARMY:OMA:431';
const MONEY_MILLIONS = '87.654321';
const MONEY_ORIGINAL = '87654.321';
const SHA = (c: string): string => c.repeat(64);
const SOURCE_DOC_ID = '00000000-0000-0000-0000-0000000000a1';
const MAPPING_REGISTRY_VERSION = DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION;
const MAPPING_REGISTRY_HASH = canonicalMappingRegistryHashV1();

let passed = 0;
function ok(message: string): void {
  passed += 1;
  console.log(`[p7-plan]   ok  ${message}`);
}
function fail(message: string): never {
  console.error(`[p7-plan] FAILED: ${message}`);
  process.exit(1);
}
function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
  ok(message);
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env var ${name}`);
  return value;
}

interface CliResultV1 {
  status: number;
  report: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

/** Runs one operator verb the way an operator runs it. */
function runVerb(
  script: string,
  args: string[],
  databaseUrl: string,
  options: { requireStdoutJson?: boolean } = {},
): CliResultV1 {
  const requireStdoutJson = options.requireStdoutJson !== false;
  const result = spawnSync('npx', ['tsx', path.join(SCRIPT_DIR, script), ...args], {
    cwd: API_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
    shell: process.platform === 'win32',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (requireStdoutJson && stdout.trim() === '') {
    fail(`${script} produced no stdout (status ${result.status}); stderr: ${stderr}`);
  }
  let report: Record<string, unknown> = {};
  if (stdout.trim() !== '') {
    try {
      report = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      if (requireStdoutJson) {
        fail(`${script} stdout was not JSON: ${stdout.slice(0, 400)}`);
      }
    }
  }
  return { status: result.status ?? -1, report, stdout, stderr };
}

function checkOf(report: Record<string, unknown>, name: string): { ok: boolean; detail: string } {
  const checks = (report.checks ?? []) as Array<{ check: string; ok: boolean; detail: string }>;
  const found = checks.find((entry) => entry.check === name);
  if (found == null) fail(`validate report carried no check named ${name}`);
  return found;
}

function buildOmProducerPlanRecord(): DefenseBudgetProjectionPlanRecordV1 {
  const candidates: NonRdteProjectionCandidateV1[] = [
    {
      candidateId: 'cand-plan-om-sag',
      target: 'OmSag',
      naturalKey: SAG_NATURAL_KEY,
      operation: 'insert',
      reason: 'plan rehearsal identity',
      artifactId: 'artifact-plan-om',
      artifactContentSha256: SHA('8'),
      verificationCandidateId: 'cand-plan-om',
      verificationRunId: 'run-plan-om',
      verificationDecisionId: 'decision-plan-om',
      sourceDocumentKey: 'p7-plan-rehearsal',
      sourcePdfSha256: SHA('9'),
      assertionIds: ['assert-plan-om-sag'],
      evidenceIds: ['ev-plan-om'],
      values: {
        naturalKey: SAG_NATURAL_KEY,
        component: 'ARMY',
        account: 'OMA',
        sagCode: '431',
        printedSagCode: '431',
        title: 'Plan rehearsal SAG',
      },
    },
    {
      candidateId: 'cand-plan-om-year',
      target: 'OmSagYear',
      naturalKey: `${SAG_NATURAL_KEY}|${FISCAL_YEAR}|request`,
      operation: 'insert',
      reason: 'plan rehearsal year position',
      artifactId: 'artifact-plan-om',
      artifactContentSha256: SHA('8'),
      verificationCandidateId: 'cand-plan-om',
      verificationRunId: 'run-plan-om',
      verificationDecisionId: 'decision-plan-om',
      sourceDocumentKey: 'p7-plan-rehearsal',
      sourcePdfSha256: SHA('9'),
      assertionIds: ['assert-plan-om-year'],
      evidenceIds: ['ev-plan-om'],
      values: {
        identityNaturalKey: SAG_NATURAL_KEY,
        fiscalYear: FISCAL_YEAR,
        fundingField: 'request',
        originalValue: MONEY_ORIGINAL,
        originalUnit: 'thousands',
        valueMillions: MONEY_MILLIONS,
      },
    },
  ];
  const withoutHash = {
    schemaVersion: NON_RDTE_PROJECTION_PLAN_SCHEMA_VERSION,
    cycleId: CYCLE_ID,
    cycleBundleContentSha256: SHA('1'),
    cycleCertification: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION' as const,
    fiscalYear: FISCAL_YEAR,
    family: 'om' as const,
    positionCycle: POSITION_CYCLE,
    candidates,
    exclusions: [] as NonRdteProjectionExclusionV1[],
    diffSummary: [
      {
        target: 'OmSag' as const,
        insertCount: 1,
        updateCount: 0,
        noOpCount: 0,
        conflictCount: 0,
      },
      {
        target: 'OmSagYear' as const,
        insertCount: 1,
        updateCount: 0,
        noOpCount: 0,
        conflictCount: 0,
      },
    ],
    diffedAgainstCanonicalRows: false,
  };
  const document = {
    ...withoutHash,
    contentSha256: computeNonRdteProjectionPlanContentSha256(withoutHash),
  };
  return buildProjectionPlanRecordV1({
    family: 'om',
    producerVersion: 'p7-plan-rehearsal@1',
    certificationId: 'cert-plan-om-1',
    certificationSha256: SHA('2'),
    planDocument: document,
  });
}

function buildEligibility(
  producerPlan: DefenseBudgetProjectionPlanRecordV1,
): DefenseBudgetPromotionEligibilityV1 {
  return defenseBudgetPromotionEligibilityV1Schema.parse({
    schemaVersion: DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION,
    eligibilityId: 'elig-plan-rehearsal',
    cycleId: CYCLE_ID,
    scope: {
      cycleId: CYCLE_ID,
      fiscalYear: FISCAL_YEAR,
      families: ['om'],
      stages: [],
    },
    projectionPlanIds: [producerPlan.projectionPlanId],
    projectionPlanHashes: [producerPlan.contentSha256],
    mappingRegistryVersion: MAPPING_REGISTRY_VERSION,
    mappingRegistryHash: MAPPING_REGISTRY_HASH,
    candidates: [
      {
        candidateId: 'cand-plan-om',
        status: 'VERIFICATION_PASSED',
        terminalVerificationRunId: 'run-plan-om',
        family: 'om',
        extractionMethod: 'deterministic_pdfplumber',
        sourceProfileSha256: null,
        acceptedAssertionIds: ['assert-plan-om-sag', 'assert-plan-om-year'],
        artifactSha256: SHA('8'),
        sourceSha256: SHA('9'),
      },
    ],
    sourceDocumentHashes: [SHA('9')],
    artifactHashes: [SHA('8')],
    manifestHash: SHA('6'),
    sourceProfileHashes: [],
    verificationPolicyHashes: [SHA('7')],
    cycleCertificationIds: ['cert-plan-om-1'],
    cycleCertificationHashes: [producerPlan.certificationSha256],
    expectedActiveSnapshotId: null,
    expectedActiveSnapshotHash: null,
    openConflictCount: 0,
    unsupportedItemCount: 0,
    generatedAt: '2026-08-10T00:00:00.000Z',
  });
}

async function seedProducerPlanAndEligibility(
  admin: PrismaClient,
  producerPlan: DefenseBudgetProjectionPlanRecordV1,
  eligibility: DefenseBudgetPromotionEligibilityV1,
  eligibilityHash: string,
): Promise<void> {
  await admin.$executeRawUnsafe(
    `INSERT INTO "defense_budget_projection_plan" (
       "projection_plan_id", "record_schema_version", "schema_version", "family",
       "cycle_id", "fiscal_year", "content_sha256", "producer_version",
       "certification_id", "certification_sha256", "artifact_set_sha256",
       "status", "conflict_count", "unsupported_count", "plan_document"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
     ON CONFLICT ("projection_plan_id") DO NOTHING`,
    producerPlan.projectionPlanId,
    producerPlan.recordSchemaVersion,
    producerPlan.schemaVersion,
    producerPlan.family,
    producerPlan.cycleId,
    producerPlan.fiscalYear,
    producerPlan.contentSha256,
    producerPlan.producerVersion,
    producerPlan.certificationId,
    producerPlan.certificationSha256,
    producerPlan.artifactSetSha256,
    producerPlan.status,
    producerPlan.conflictCount,
    producerPlan.unsupportedCount,
    JSON.stringify(producerPlan.planDocument),
  );

  await admin.$executeRawUnsafe(
    `INSERT INTO "defense_budget_promotion_eligibility" (
       "eligibility_id", "eligibility_hash", "cycle_id",
       "mapping_registry_version", "mapping_registry_hash",
       "scope", "scope_hash", "open_conflict_count", "unsupported_item_count",
       "document", "generated_at"
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11::timestamptz)
     ON CONFLICT ("eligibility_hash") DO NOTHING`,
    eligibility.eligibilityId,
    eligibilityHash,
    eligibility.cycleId,
    eligibility.mappingRegistryVersion,
    eligibility.mappingRegistryHash,
    JSON.stringify(eligibility.scope),
    sha256CanonicalJson(eligibility.scope as unknown as JsonValue),
    eligibility.openConflictCount,
    eligibility.unsupportedItemCount,
    JSON.stringify(eligibility),
    eligibility.generatedAt,
  );
}

async function main(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

  try {
    /* ---- Seed exact producer plan + eligibility (required before plan CLI) ---- */

    const producerPlan = buildOmProducerPlanRecord();
    const eligibility = buildEligibility(producerPlan);
    const eligibilityHash = promotionEligibilityHashV1(eligibility);
    check(
      /^[0-9a-f]{64}$/.test(eligibilityHash),
      'eligibility document hashes to a 64-hex content address',
    );
    // Must not reuse the engine rehearsal's placeholder SHA('e') row, which
    // stores document='{}' under ON CONFLICT DO NOTHING and would poison this
    // section's reload.
    check(
      eligibilityHash !== SHA('e'),
      'plan eligibility hash is distinct from the engine rehearsal placeholder',
    );

    await seedProducerPlanAndEligibility(admin, producerPlan, eligibility, eligibilityHash);
    ok('seeded immutable O&M producer plan + eligibility v2 document');

    // Optional ambient O&M rows — not read by the eligibility-bound planner,
    // but kept so the disposable DB still looks like a verified Phase 5 cycle.
    await admin.$executeRawUnsafe(`
      INSERT INTO source_document
        (id, source_key, fiscal_year, budget_cycle, component, document_type,
         title, source_url, sha256, extraction_method)
      VALUES ('${SOURCE_DOC_ID}', 'p7-plan-rehearsal', ${FISCAL_YEAR},
              '${POSITION_CYCLE}', 'ARMY', 'o1', 'Phase 7 plan rehearsal', 'file:///o1-plan.pdf',
              '${SHA('9')}', 'structured_import')
      ON CONFLICT DO NOTHING;`);
    await admin.$executeRawUnsafe(`
      INSERT INTO om_sag (natural_key, component, account, sag_code, printed_sag_code, title)
      VALUES ('${SAG_NATURAL_KEY}', 'ARMY', 'OMA', '431', '431', 'Plan rehearsal SAG')
      ON CONFLICT DO NOTHING;`);
    await admin.$executeRawUnsafe(`
      INSERT INTO om_sag_year
        (om_sag_id, fiscal_year, funding_field, amount_millions, original_value, original_unit,
         source_document_id, extraction_artifact_id, extraction_artifact_content_sha256,
         assertion_id, verification_candidate_id, verification_run_id, verification_decision_id,
         source_pdf_sha256, evidence_ids_jsonb)
      SELECT id, ${FISCAL_YEAR}, 'request', ${MONEY_MILLIONS}, '${MONEY_ORIGINAL}', 'thousands',
             '${SOURCE_DOC_ID}', 'artifact-plan-om', '${SHA('8')}',
             'assert-plan-om-year', 'cand-plan-om', 'run-plan-om', 'decision-plan-om',
             '${SHA('9')}', '["ev-plan-om"]'::jsonb
        FROM om_sag WHERE natural_key = '${SAG_NATURAL_KEY}'
      ON CONFLICT DO NOTHING;`);
    ok('seeded ambient verified O&M tables alongside the producer plan');

    /* ---- 1. plan runs as the application role ---- */

    const planArgsFor = (families: string): string[] => [
      '--environment',
      ENVIRONMENT,
      '--cycle-id',
      CYCLE_ID,
      '--fiscal-year',
      String(FISCAL_YEAR),
      '--families',
      families,
      '--eligibility-hash',
      eligibilityHash,
      '--mode',
      'baseline_hydration',
    ];
    const planArgs = planArgsFor('om');

    const first = runVerb('plan-defense-budget-promotion-v1.ts', planArgs, APP_URL);
    check(first.status === 0, `plan exited 0 as capiro_app (got ${first.status})`);
    check(first.report.planProduced === true, 'plan produced a plan document');
    check(first.report.blocked === false, 'plan has no blocked items');

    const counts = first.report.counts as { total: number; insert: number };
    check(counts.total === 2, `plan covers 2 items (identity + year), got ${counts.total}`);
    check(counts.insert === 2, `both items are INSERT on an empty pointer, got ${counts.insert}`);

    const inputs = first.report.inputs as { projectionCount: number; priorRowCount: number };
    check(
      inputs.projectionCount === 2,
      'eligibility-bound source projected 2 rows from the producer plan',
    );
    check(inputs.priorRowCount === 0, 'no prior rows, as there is no active snapshot');

    /* The whole point of reading the real lineage columns: the exact decimal
     * has to survive the producer plan -> projector -> plan path without a float. */
    const planDocument = first.report.plan as {
      items: Array<{ projectionKind: string; canonicalNaturalKey: string }>;
    };
    check(
      planDocument.items.some((item) => item.projectionKind === 'non_rdte:OmSagYear'),
      'plan carries the O&M year item',
    );
    check(
      planDocument.items.every((item) => item.canonicalNaturalKey.includes('431')),
      "every planned item belongs to this section's SAG, not another fixture's",
    );

    /* ---- 2. Determinism: the same scope replans to the same hash ---- */

    const second = runVerb('plan-defense-budget-promotion-v1.ts', planArgs, APP_URL);
    check(second.status === 0, 'second plan run exited 0');
    check(
      second.report.planHash === first.report.planHash,
      `re-planning an unchanged scope reproduces plan hash ${String(first.report.planHash)}`,
    );
    check(
      second.report.proposedSnapshotId === first.report.proposedSnapshotId,
      'the derived proposed snapshot id is stable across runs',
    );

    /* ---- 3. CLI scope must match the persisted eligibility scope ---- */

    // Eligibility is O&M-only. Asking for RDT&E is a scope lie, not an empty
    // reader — the bound planner refuses before it looks at producer plans.
    const mismatched = runVerb(
      'plan-defense-budget-promotion-v1.ts',
      planArgsFor('rdte'),
      APP_URL,
      {
        requireStdoutJson: false,
      },
    );
    check(
      mismatched.status === 1,
      `plan refused a CLI scope that does not match eligibility (exit ${mismatched.status})`,
    );
    check(
      mismatched.stderr.includes('CLI scope does not match persisted eligibility') ||
        mismatched.stdout.includes('CLI scope does not match persisted eligibility'),
      'the refusal names the scope mismatch rather than silently planning empty',
    );

    /* ---- 4. File the plan — through the real verb, not raw SQL — then validate it ---- */

    const planId = String(first.report.planId);
    const planHash = String(first.report.planHash);
    // Eligibility was already seeded above with the real v2 document. Filing
    // reuses that same content-addressed hash.

    const planDocPath = path.join(API_ROOT, '.p7-plan-rehearsal-doc.json');
    fs.writeFileSync(planDocPath, JSON.stringify(first.report));
    let filed: CliResultV1;
    try {
      filed = runVerb(
        'file-defense-budget-promotion-plan-v1.ts',
        ['--plan-document', planDocPath, '--commit'],
        APP_URL,
      );
    } finally {
      fs.rmSync(planDocPath, { force: true });
    }
    check(
      filed.status === 0,
      `file-defense-budget-promotion-plan-v1 exited 0 (got ${filed.status}${
        filed.status !== 0
          ? `: ${String(filed.report.reason)} — ${String(filed.report.detail)}`
          : ''
      })`,
    );
    check(filed.report.filed === true, 'the plan was actually filed, not just dry-run reported');
    ok('filed the plan through the real verb');

    const validated = runVerb(
      'validate-defense-budget-promotion-v1.ts',
      ['--environment', ENVIRONMENT, '--plan-id', planId],
      APP_URL,
    );
    check(validated.status === 0, `validate exited 0 for a fresh plan (got ${validated.status})`);
    check(validated.report.valid === true, 'validate reports the plan valid');
    check(
      validated.report.recomputedPlanHash === planHash,
      'validate reproduced the plan hash from the stored document',
    );
    check(
      checkOf(validated.report, 'plan_hash_matches_document').ok,
      'stored hash still describes the document',
    );
    check(checkOf(validated.report, 'no_blocked_items').ok, 'validate confirms nothing is blocked');
    check(
      checkOf(validated.report, 'mapping_registry_current').ok,
      'validate confirms the mapping registry has not moved',
    );
    check(
      checkOf(validated.report, 'expected_active_snapshot_current').ok,
      'validate confirms the expected active pointer is current',
    );

    /* ---- 5. An unknown plan id is refused, not treated as empty ---- */

    const unknown = runVerb(
      'validate-defense-budget-promotion-v1.ts',
      ['--environment', ENVIRONMENT, '--plan-id', 'plan-does-not-exist'],
      APP_URL,
    );
    check(unknown.status === 3, `validate refused an unknown plan id (exit ${unknown.status})`);
    check(unknown.report.valid === false, 'an unknown plan id is invalid, not vacuously valid');

    /* ---- 6. Active-snapshot drift is detected ---- */

    let updateRefused = false;
    try {
      await admin.$executeRawUnsafe(
        `UPDATE "defense_budget_promotion_plan" SET "blocked_count" = 1 WHERE "plan_id" = $1`,
        planId,
      );
    } catch {
      updateRefused = true;
    }
    check(updateRefused, 'a filed plan cannot be modified — append-only refused the UPDATE');

    const driftedPlanId = `${planId}-drifted`;
    const scopeJson = JSON.stringify(eligibility.scope);
    const scopeHash = sha256CanonicalJson(eligibility.scope as unknown as JsonValue);
    await admin.$executeRawUnsafe(
      `INSERT INTO defense_budget_promotion_plan
        (plan_id, plan_hash, eligibility_hash, mapping_registry_version, mapping_registry_hash,
         cycle_id, fiscal_year, scope, scope_hash, mode, expected_active_snapshot_id,
         proposed_snapshot_id, item_count, blocked_count, plan_document)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
              $12, $13, 0, $14::jsonb)`,
      driftedPlanId,
      planHash,
      eligibilityHash,
      MAPPING_REGISTRY_VERSION,
      MAPPING_REGISTRY_HASH,
      CYCLE_ID,
      FISCAL_YEAR,
      scopeJson,
      scopeHash,
      'baseline_hydration',
      '11111111-1111-1111-1111-111111111111',
      String(first.report.proposedSnapshotId),
      counts.total,
      JSON.stringify(first.report.plan),
    );
    ok('filed a second plan expecting a snapshot that is not active');

    const drifted = runVerb(
      'validate-defense-budget-promotion-v1.ts',
      ['--environment', ENVIRONMENT, '--plan-id', driftedPlanId],
      APP_URL,
    );
    check(drifted.status === 3, `validate refused a drifted plan (exit ${drifted.status})`);
    check(drifted.report.valid === false, 'a drifted plan is invalid');
    check(
      !checkOf(drifted.report, 'expected_active_snapshot_current').ok,
      'the drift is attributed to the active-snapshot expectation, not something else',
    );
    check(
      checkOf(drifted.report, 'plan_hash_matches_document').ok,
      'the plan document itself is still intact — only the expectation drifted',
    );

    console.log(`[p7-plan] PASSED — ${passed} checks.`);
  } finally {
    await admin.$disconnect();
  }
}

void main().catch((error) => {
  console.error('[p7-plan] FAILED:', error);
  process.exit(1);
});
