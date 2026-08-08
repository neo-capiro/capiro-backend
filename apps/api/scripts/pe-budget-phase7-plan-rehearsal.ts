/**
 * Phase 7 Workstream N — plan/validate operator verbs against a real database.
 *
 * Invoked by `scripts/pe-budget-phase7-migration-rehearsal.sh` against a
 * disposable PostgreSQL container. Never point this at a shared database.
 *
 * What it proves that the unit tests cannot:
 *
 *   * the SQL inside `promotion-projection-source-prisma-v1.ts` matches the
 *     Phase 5 projection schema — the unit tests answer it with a fake client
 *     and prove nothing about column names;
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
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const ADMIN_URL = required('ADMIN_DATABASE_URL');
const APP_URL = required('APP_DATABASE_URL');

// `process.argv[1]` rather than `import.meta.url`: this package builds to
// CommonJS, where import.meta is a compile error (TS1470).
const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1] ?? ''));
const API_ROOT = path.resolve(SCRIPT_DIR, '..');

// A distinct environment from every other section, so this plans against an
// empty pointer without interfering with the engine or read rehearsals.
const ENVIRONMENT = 'planrehearsal';
// And a distinct fiscal year, which matters more than it looks: the planner
// reads every O&M SAG funded in the requested year, and the engine rehearsal
// seeds its own FY2027 SAG into this same database. Sharing the year made the
// plan legitimately cover 4 items instead of 2 — correct behaviour, useless
// assertion. Isolating the year is what lets the counts below be exact.
const CYCLE_ID = 'cycle-fy2029-plan';
const FISCAL_YEAR = 2029;
const ELIGIBILITY_HASH = 'e'.repeat(64);
const SHA = (c: string): string => c.repeat(64);
const SOURCE_DOC_ID = '00000000-0000-0000-0000-0000000000a1';

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
}

/** Runs one operator verb the way an operator runs it, and parses its JSON. */
function runVerb(script: string, args: string[], databaseUrl: string): CliResultV1 {
  const result = spawnSync('npx', ['tsx', path.join(SCRIPT_DIR, script), ...args], {
    cwd: API_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
    shell: process.platform === 'win32',
  });
  if (result.stdout == null || result.stdout.trim() === '') {
    fail(`${script} produced no stdout (status ${result.status}); stderr: ${result.stderr ?? ''}`);
  }
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    fail(`${script} stdout was not JSON: ${result.stdout.slice(0, 400)}`);
  }
  return { status: result.status ?? -1, report };
}

function checkOf(report: Record<string, unknown>, name: string): { ok: boolean; detail: string } {
  const checks = (report.checks ?? []) as Array<{ check: string; ok: boolean; detail: string }>;
  const found = checks.find((entry) => entry.check === name);
  if (found == null) fail(`validate report carried no check named ${name}`);
  return found;
}

async function main(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

  try {
    /* ---- Seed verified O&M projections ---- */
    // om_sag_year carries a foreign key to source_document; the projection is
    // proof-bound, so there is no way to seed funding without its source.
    await admin.$executeRawUnsafe(`
      INSERT INTO source_document
        (id, source_key, fiscal_year, budget_cycle, component, document_type,
         title, source_url, sha256, extraction_method)
      VALUES ('${SOURCE_DOC_ID}', 'p7-plan-rehearsal', ${FISCAL_YEAR},
              'pb_fy2029', 'ARMY', 'o1', 'Phase 7 plan rehearsal', 'file:///o1-plan.pdf',
              '${SHA('9')}', 'structured_import')
      ON CONFLICT DO NOTHING;`);

    await admin.$executeRawUnsafe(`
      INSERT INTO om_sag (natural_key, component, account, sag_code, printed_sag_code, title)
      VALUES ('OM_SAG:ARMY:OMA:431', 'ARMY', 'OMA', '431', '431', 'Plan rehearsal SAG')
      ON CONFLICT DO NOTHING;`);

    await admin.$executeRawUnsafe(`
      INSERT INTO om_sag_year
        (om_sag_id, fiscal_year, funding_field, amount_millions, original_value, original_unit,
         source_document_id, extraction_artifact_id, extraction_artifact_content_sha256,
         assertion_id, verification_candidate_id, verification_run_id, verification_decision_id,
         source_pdf_sha256, evidence_ids_jsonb)
      SELECT id, ${FISCAL_YEAR}, 'request', 87.654321, '87654.321', 'thousands',
             '${SOURCE_DOC_ID}', 'artifact-plan-om', '${SHA('8')}',
             'assert-plan-om', 'cand-plan-om', 'run-plan-om', 'decision-plan-om',
             '${SHA('9')}', '["ev-plan-om"]'::jsonb
        FROM om_sag WHERE natural_key = 'OM_SAG:ARMY:OMA:431'
      ON CONFLICT DO NOTHING;`);
    ok('seeded verified O&M projections for the plan rehearsal');

    /* ---- 1. plan runs as the application role ---- */

    // Built by family rather than spliced by index: an earlier version sliced
    // this array to swap the family and silently dropped the
    // --eligibility-hash flag, so the "unreadable family" case below failed on
    // a usage error instead of on the thing it meant to test.
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
      ELIGIBILITY_HASH,
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
    check(inputs.projectionCount === 2, 'projection source read 2 projections from real tables');
    check(inputs.priorRowCount === 0, 'no prior rows, as there is no active snapshot');

    /* The whole point of reading the real lineage columns: the exact decimal
     * has to survive NUMERIC -> text -> plan without a float in the path. */
    const planDocument = first.report.plan as {
      items: Array<{ projectionKind: string; canonicalNaturalKey: string }>;
    };
    check(
      planDocument.items.some((item) => item.projectionKind === 'non_rdte:OmSagYear'),
      'plan carries the O&M year item',
    );
    // Asserted rather than merely arranged: if another section's fixture ever
    // lands in this fiscal year again, this fails with the reason rather than
    // with a count that has to be reverse-engineered.
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

    /* ---- 3. A family with no reader blocks instead of planning empty ---- */

    const unreadable = runVerb('plan-defense-budget-promotion-v1.ts', planArgsFor('rdte'), APP_URL);
    check(unreadable.status === 3, `plan refused an unreadable family (exit ${unreadable.status})`);
    check(unreadable.report.planProduced === false, 'no plan document was produced for it');
    check(
      Array.isArray(unreadable.report.unsupportedFamilies) &&
        (unreadable.report.unsupportedFamilies as string[]).includes('rdte'),
      'the unreadable family is named rather than silently omitted',
    );

    /* ---- 4. File the plan — through the real verb, not raw SQL — then validate it ---- */

    const planId = String(first.report.planId);
    const planHash = String(first.report.planHash);
    // Gap 3 closeout: eligibility_hash is now a foreign key into
    // defense_budget_promotion_eligibility. One row here covers every plan
    // filed below — they all reuse ELIGIBILITY_HASH.
    //
    // ON CONFLICT DO NOTHING: ELIGIBILITY_HASH ('e'.repeat(64)) collides with
    // pe-budget-phase7-engine-rehearsal.ts's SHA('e') — the same 64-'e' string
    // — and both scripts run against the one shared disposable database within
    // a single rehearsal invocation. A matching hash already present means the
    // identical content was already recorded, which is exactly what a
    // content-addressed table replaying cleanly looks like — not a defect.
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_eligibility
        (eligibility_id, eligibility_hash, cycle_id, mapping_registry_version,
         mapping_registry_hash, scope, scope_hash, open_conflict_count,
         unsupported_item_count, document, generated_at)
      VALUES ('elig-plan-rehearsal', '${ELIGIBILITY_HASH}', '${CYCLE_ID}',
              '${String(first.report.mappingRegistryVersion)}',
              '${String(first.report.mappingRegistryHash)}',
              '{"cycleId":"${CYCLE_ID}","fiscalYear":${FISCAL_YEAR},"families":["om"],"stages":[]}'::jsonb,
              '${SHA('a')}', 0, 0, '{}'::jsonb, now())
      ON CONFLICT ("eligibility_hash") DO NOTHING;`);

    // Gap 4 closeout: this used to be a raw SQL INSERT — the exact gap the
    // rehearsal itself proved existed (nothing filed a plan through an actual
    // operator command). Now it spawns the real verb, matching how plan/
    // validate below are already tested as real CLIs rather than imported.
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

    // A filed plan is append-only. Assert it rather than assume it: this is the
    // Workstream D ledger property, and it is what forces the drift case below
    // to be staged by filing a second plan instead of editing the first.
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

    // The drifted twin carries the same document and the same hash, so the only
    // check that can fail is the pointer one. That keeps the failure attributable.
    const driftedPlanId = `${planId}-drifted`;
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_plan
        (plan_id, plan_hash, eligibility_hash, mapping_registry_version, mapping_registry_hash,
         cycle_id, fiscal_year, scope, scope_hash, mode, expected_active_snapshot_id,
         proposed_snapshot_id, item_count, blocked_count, plan_document)
      VALUES ('${driftedPlanId}', '${planHash}', '${ELIGIBILITY_HASH}',
              '${String(first.report.mappingRegistryVersion)}',
              '${String(first.report.mappingRegistryHash)}',
              '${CYCLE_ID}', ${FISCAL_YEAR}, '{"families":["om"]}'::jsonb, '${SHA('a')}',
              'baseline_hydration', '11111111-1111-1111-1111-111111111111',
              '${String(first.report.proposedSnapshotId)}',
              ${counts.total}, 0, $$${JSON.stringify(first.report.plan)}$$::jsonb);`);
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
