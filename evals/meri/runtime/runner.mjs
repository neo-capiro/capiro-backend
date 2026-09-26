/**
 * Offline Meri runtime runner.
 *
 * Called via `node --import tsx runner.mjs` from packages/meriv2-core cwd.
 * Receives JSON via stdin with:
 *   - caseId: "core/..." | "ga/..." | "plan/..." | "sequence/..." | "calibration/..."
 *   - resultPath: path to write record JSON
 *   - For plan: request, selectedClientId (string|null)
 *   - For sequence: firstRequest, request, selectedClientId, priorTargetHint
 *
 * Writes single-line JSON to resultPath, exits 0.
 * stdout is reserved for the provider wrapper.
 * NEVER imports run-evals.ts (it persists DB audit rows on import).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

// env scrub: must happen before any module imports that read env
const SENSITIVE_KEYS = [
  'DATABASE_URL',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY',
  'STRIPE_SECRET_KEY',
  'MERIV2_EVAL_SEED_FAILURE',
  'MERI_EVAL_DATASET_VERSION',
  'ASSURANCE_EVAL_TENANT_ID',
];
for (const k of SENSITIVE_KEYS) delete process.env[k];

// Workspace root is two levels up from packages/meriv2-core (cwd at call time)
const WORKSPACE = resolve(process.cwd(), '..', '..');
const SOURCE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: WORKSPACE, encoding: 'utf8', timeout: 3000, windowsHide: true,
}).trim();
if (!/^[a-f0-9]{40}$/.test(SOURCE_SHA)) throw new Error('Cannot resolve source Git commit');
const FIXTURE_VERSION = '2026-09-06.1';
const DATASET_VERSION = 'meri-offline-v1';

function tsUrl(relFromWorkspace) {
  return pathToFileURL(join(WORKSPACE, relFromWorkspace)).href;
}

// Load all case modules via pathToFileURL (valid JS - no template literals in import position)
const [
  { crossTenantLeakageCase },
  { claimGroundingCase },
  { complianceGateCase },
  { entityGroundingCase },
  { billStatusCase },
  { stateBillStatusCase },
  { stateRuleStatusCase },
  { committeeRosterCase },
  { multiStateComparisonCase },
  { federalStateMixedCase },
  { governmentAffairsAssuranceCase },
] = await Promise.all([
  import(tsUrl('packages/meriv2-core/test/evals/leakage/cross-tenant-leakage.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/grounding/claim-grounding.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/compliance/gate-enforcement.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/entity/entity-grounding.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/legislation/bill-status.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/legislation/state-bill-status.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/legislation/state-rule-status.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/legislation/committee-roster.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/legislation/multi-state-comparison.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/legislation/federal-state-mixed.eval.ts')),
  import(tsUrl('packages/meriv2-core/test/evals/assurance/government-affairs-assurance.eval.ts')),
]);

const { GOVERNMENT_AFFAIRS_FIXTURES, GA_FIXTURE_VERSION } = await import(
  tsUrl('apps/api/src/meri/evals/government-affairs-fixtures.ts')
);
const { classifyMeriRetrievalIntent } = await import(
  tsUrl('apps/meriv2-orchestrator/src/meri/retrieval/meri-retrieval-intent.ts')
);
const { buildMeriRetrievalPlan } = await import(
  tsUrl('apps/meriv2-orchestrator/src/meri/retrieval/meri-retrieval-plan.ts')
);
const { gradeGovernmentAffairsAnswer } = await import(
  tsUrl('apps/api/src/meri/evals/government-affairs-grader.ts')
);

// case registry - built from actual source IDs, prefixed with "core/"
const CORE_CASES = {
  'core/leakage.cross-tenant.matrix': crossTenantLeakageCase,
  'core/grounding.claim-evidence': claimGroundingCase,
  'core/compliance.gate.enforcement': complianceGateCase,
  'core/entity.grounding.canonical-ids': entityGroundingCase,
  'core/legislation.bill-status.hr8800-rule-failed': billStatusCase,
  'core/legislation.state-bill-status.crossover-dead': stateBillStatusCase,
  'core/legislation.state-rule-status.no-fabrication': stateRuleStatusCase,
  'core/legislation.committee-roster.never-guess': committeeRosterCase,
  'core/legislation.multi-state-comparison.order-independent': multiStateComparisonCase,
  'core/legislation.federal-state-mixed.no-cross-contamination': federalStateMixedCase,
};
// GA assurance case uses its actual runtime id from source
CORE_CASES['core/' + governmentAffairsAssuranceCase.id] = governmentAffairsAssuranceCase;

const GA_MAP = Object.fromEntries(GOVERNMENT_AFFAIRS_FIXTURES.map((f) => [f.id, f]));

function baseProvenance() {
  return { gitSha: SOURCE_SHA, fixtureVersion: FIXTURE_VERSION, model: 'none' };
}
function offlineCtx() {
  return {
    tenantId: 'eval-offline', userId: 'offline-runner', clerkUserId: 'offline-runner', role: 'standard_user',
    clientRoster: [
      { name: 'Arbor Sensors', status: 'active' },
      { name: 'Sable Maritime', status: 'active' },
      { name: 'Former Client', status: 'inactive' },
    ],
  };
}

async function runCore(caseId) {
  const testCase = CORE_CASES[caseId];
  if (!testCase) throw new Error('Unknown core caseId: ' + caseId);
  const t0 = Date.now();
  const outcome = await testCase.run();
  return {
    schemaVersion: 1, datasetVersion: DATASET_VERSION, caseId,
    measurement: { status: outcome.pass ? 'pass' : 'fail', durationMs: Date.now() - t0 },
    result: { pass: outcome.pass, detail: outcome.detail, results: outcome.results ?? null },
    answer: null, sources: null, requiredSourceIds: null, expect: null,
    plan: null, turns: null, grade: null,
    provenance: baseProvenance(),
  };
}

async function runGA(caseId) {
  const fixtureId = caseId.slice(3); // strip "ga/"
  const fixture = GA_MAP[fixtureId];
  if (!fixture) throw new Error('Unknown GA fixture: ' + fixtureId);
  const t0 = Date.now();
  const grade = gradeGovernmentAffairsAnswer(fixture, fixture.referenceAnswer);
  return {
    schemaVersion: 1, datasetVersion: DATASET_VERSION, caseId,
    measurement: { status: grade.pass ? 'pass' : 'fail', durationMs: Date.now() - t0 },
    result: null,
    answer: fixture.referenceAnswer,
    sources: fixture.sources.map((s) => ({ id: s.id, title: s.title, text: s.text })),
    requiredSourceIds: fixture.requiredSourceIds,
    expect: fixture.expect,
    plan: null, turns: null,
    grade: { pass: grade.pass, failures: grade.failures },
    provenance: { gitSha: SOURCE_SHA, fixtureVersion: GA_FIXTURE_VERSION ?? FIXTURE_VERSION, model: 'none' },
  };
}

async function runPlan(caseId, vars) {
  const { request, selectedClientId } = vars;
  if (!request) throw new Error('plan case requires request var');
  const t0 = Date.now();
  const intent = classifyMeriRetrievalIntent(request, selectedClientId ?? null);
  const plan = buildMeriRetrievalPlan(request, intent, offlineCtx(), null);
  return {
    schemaVersion: 1, datasetVersion: DATASET_VERSION, caseId,
    measurement: { status: 'complete', durationMs: Date.now() - t0 },
    result: null, answer: null, sources: null, requiredSourceIds: null, expect: null,
    plan, turns: null, grade: null,
    provenance: baseProvenance(),
  };
}

async function runSequence(caseId, vars) {
  const { firstRequest, request, selectedClientId } = vars;
  if (!firstRequest || !request) throw new Error('sequence case requires firstRequest and request vars');
  const ctx = offlineCtx();
  const t0 = Date.now();
  const firstIntent = classifyMeriRetrievalIntent(firstRequest, selectedClientId ?? null);
  const firstPlan = buildMeriRetrievalPlan(firstRequest, firstIntent, ctx, null);
  const secondIntent = classifyMeriRetrievalIntent(request, selectedClientId ?? null);
  // The real planner decides which follow-up recipes may reuse the actual
  // first-turn target; a supplied expectation must never become input state.
  const secondPlan = buildMeriRetrievalPlan(request, secondIntent, ctx, firstPlan.targetHint ?? null);
  return {
    schemaVersion: 1, datasetVersion: DATASET_VERSION, caseId,
    measurement: { status: 'complete', durationMs: Date.now() - t0 },
    result: null, answer: null, sources: null, requiredSourceIds: null, expect: null,
    plan: secondPlan,
    turns: [firstPlan, secondPlan],
    grade: null,
    provenance: baseProvenance(),
  };
}

async function runCalibrationBadCitation() {
  // Derive bad answer from actual fixture referenceAnswer + fabricated citation [999]
  const fixture = GOVERNMENT_AFFAIRS_FIXTURES[0];
  if (!fixture) throw new Error('No GA fixture available for bad-citation calibration');
  const badAnswer = fixture.referenceAnswer + ' [999]';
  const grade = gradeGovernmentAffairsAnswer(fixture, badAnswer);
  return {
    schemaVersion: 1, datasetVersion: DATASET_VERSION, caseId: 'calibration/bad-citation',
    measurement: { status: 'complete', durationMs: 0 },
    result: null,
    answer: badAnswer,
    sources: fixture.sources.map((s) => ({ id: s.id, title: s.title, text: s.text })),
    requiredSourceIds: fixture.requiredSourceIds,
    expect: fixture.expect,
    plan: null, turns: null,
    grade: { pass: grade.pass, failures: grade.failures },
    provenance: { gitSha: SOURCE_SHA, fixtureVersion: GA_FIXTURE_VERSION ?? FIXTURE_VERSION, model: 'none' },
  };
}

async function runCalibrationTenantLeak() {
  // Set seed-failure flag only for this case, then clean up in finally
  process.env.MERIV2_EVAL_SEED_FAILURE = '1';
  try {
    const t0 = Date.now();
    const outcome = await crossTenantLeakageCase.run();
    return {
      schemaVersion: 1, datasetVersion: DATASET_VERSION, caseId: 'calibration/tenant-leak',
      measurement: { status: outcome.pass ? 'pass' : 'fail', durationMs: Date.now() - t0 },
      result: { pass: outcome.pass, detail: outcome.detail, results: outcome.results ?? null },
      answer: null, sources: null, requiredSourceIds: null, expect: null,
      plan: null, turns: null, grade: null,
      provenance: baseProvenance(),
    };
  } finally {
    delete process.env.MERIV2_EVAL_SEED_FAILURE;
  }
}

async function main() {
  let vars;
  try {
    const input = readFileSync(0, 'utf8');
    vars = JSON.parse(input);
  } catch (e) {
    process.stderr.write('Failed to parse stdin: ' + e.message + '\n');
    process.exit(1);
  }

  const { caseId, resultPath, ...rest } = vars;
  if (!caseId) { process.stderr.write('Missing caseId\n'); process.exit(1); }
  if (!resultPath) { process.stderr.write('Missing resultPath\n'); process.exit(1); }

  const mode = caseId.split('/')[0];
  const sub = caseId.split('/').slice(1).join('/');

  let record;
  try {
    if (mode === 'core') record = await runCore(caseId);
    else if (mode === 'ga') record = await runGA(caseId);
    else if (mode === 'plan') record = await runPlan(caseId, rest);
    else if (mode === 'sequence') record = await runSequence(caseId, rest);
    else if (mode === 'calibration') {
      if (sub === 'bad-citation') record = await runCalibrationBadCitation();
      else if (sub === 'tenant-leak') record = await runCalibrationTenantLeak();
      else throw new Error('Unknown calibration sub-case: ' + sub);
    } else throw new Error('Unknown caseId mode: ' + mode);
  } catch (err) {
    process.stderr.write('Runner error for ' + caseId + ': ' + err.message + '\n');
    process.exit(1);
  }

  try {
    writeFileSync(resultPath, JSON.stringify(record));
  } catch (err) {
    process.stderr.write('Failed to write result: ' + err.message + '\n');
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write('Fatal runner error: ' + (err.stack ?? err.message) + '\n');
  process.exit(1);
});
