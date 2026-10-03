// Prepared operator only. Run inside the separately qualified immutable API image.
// No task launcher, fixture seeding, conversation creation, or capture is included.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createCase01SetupDependencies } from '/app/apps/api/scripts/meri-case01-setup-dependencies.mjs';
import { readCase01MemoryCorpusInTx } from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs';
import { buildFixtureManifest } from '/app/evals/meri/live-v1/fixture-provisioning/manifest.mjs';
import { createCase01MemoryFixtureRuntime } from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-runtime.mjs';
import { createCaptureBindingOwner } from '/app/evals/meri/live-v1/fixture-provisioning/capture-binding-owner.mjs';
import { sha256Stable } from '/app/evals/meri/live-v1/artifact-collector.mjs';

const SOURCE = '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642';
const RUN = 'bd35c0f4-1604-4371-b7e9-a1338369e53f';
const NAMESPACE = 'meri-foundation-20260928';
const CLIENT = '41f9ec63-3963-479f-b747-59a3767ef44b';
const CTX = Object.freeze({
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  tenantSlug: `${NAMESPACE}-t1`,
  userId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  clerkUserId: 'user_3Jw2FvWZkYGKmxWGx13tNJxFD2A',
  role: 'standard_user',
});
const RATE_BYTES = '3531e09dfcce9f66b4ea2b3564db47bd72dc507cdcf1aecdda277b838007704e';
const RATE_VALUE = 'a1a179383c8451495336169f46025eb8cee8ec95487f1a43017078387b768b11';
const request = Object.freeze({
  tenantId: CTX.tenantId, tenantSlug: CTX.tenantSlug, actorUserId: CTX.userId,
  clerkUserId: CTX.clerkUserId, clientId: CLIENT, caseId: '01', captureRunId: RUN,
});
const require = createRequire('/app/apps/api/package.json');
const { captureBudgetHash, validateCaptureBudgetQualification } = require('./dist/meri/meri-capture-provider-budget.js');
const { assertRateEvidence, inspectCaptureProviderBudgetInstallation, installCaptureProviderBudgetQualification } = require('./dist/meri/meri-capture-provider-budget-install.js');
let factory, output, stage = 'VALIDATING', sequence = 0, diagnosticSubstage = 'START';
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const log = async (phase, value = {}) => {
  const event = { sequence: ++sequence, recordedAt: new Date().toISOString(), stage, phase, ...value };
  const line = `${JSON.stringify(event)}\n`;
  await output.writeFile(line, 'utf8');
  await output.sync();
  process.stdout.write(`C2_CASE01_NATIVE_SETUP ${JSON.stringify(event)}\n`);
};

// The only SQL owned by this composition is SELECT. Mutations belong to the two
// existing canonical owners. Hash every other setting to detect unrelated drift.
// Only the binding owner's inspect/bind receives this known-slow transaction budget.
// The actual scoped Prisma method receives the identical callback and owns the tx.
function bindingTransactionScope(prisma) {
  assert.equal(typeof prisma?.withTenantUser, 'function');
  return Object.freeze({
    withTenantUser(tenantId, userId, callback, ...options) {
      assert.equal(arguments.length, 3, 'CASE01_BINDING_TRANSACTION_ARGUMENTS');
      assert.equal(options.length, 0, 'CASE01_BINDING_TRANSACTION_OPTIONS');
      assert.equal(tenantId, CTX.tenantId, 'CASE01_BINDING_TRANSACTION_TENANT');
      assert.equal(userId, CTX.userId, 'CASE01_BINDING_TRANSACTION_ACTOR');
      assert.equal(typeof callback, 'function', 'CASE01_BINDING_TRANSACTION_CALLBACK');
      return prisma.withTenantUser(tenantId, userId, callback, { timeoutMs: 30000 });
    },
  });
}

async function savedState() {
  return factory.deps.prisma.withTenantUser(CTX.tenantId, CTX.userId, async tx => {
    const rows = await tx.$queryRawUnsafe(
      'SELECT settings_jsonb AS settings,xmin::text AS version FROM tenants WHERE id=$1::uuid AND slug=$2 FOR UPDATE',
      CTX.tenantId, CTX.tenantSlug,
    );
    assert.equal(rows.length, 1);
    const settings = structuredClone(rows[0].settings);
    const fixture = settings.meriFoundationFixture;
    assert.equal(fixture.fixtureNamespace, NAMESPACE);
    const binding = fixture.captureEvidence ?? null;
    const qualification = fixture.captureProviderBudget ?? null;
    delete fixture.captureEvidence;
    delete fixture.captureProviderBudget;
    return {
      tenantRowVersion: rows[0].version,
      binding,
      bindingSha256: sha256Stable(binding),
      qualificationSha256: captureBudgetHash(qualification),
      protectedSettingsSha256: sha256Stable(settings),
    };
  });
}

try {
  const [mode, flag, out, ...extra] = process.argv.slice(2);
  assert.ok(['plan', 'execute'].includes(mode));
  assert.equal(flag, '--out');
  assert.equal(extra.length, 0);
  assert.match(out ?? '', /^\/dev\/shm\/case01-native-setup-[a-z0-9-]+\.jsonl$/u);
  assert.equal(process.env.RELEASE_SHA, SOURCE);
  assert.equal(process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE, NAMESPACE);
  const input = JSON.parse(process.env.MERI_C2_CASE01_SETUP_INPUT ?? 'null');
  assert.deepEqual(Object.keys(input).sort(), mode === 'plan'
    ? ['confirmation', 'expectedSourceSha']
    : ['confirmation', 'expectedSourceSha', 'plan', 'planSha256']);
  assert.equal(input.expectedSourceSha, SOURCE);
  assert.equal(input.confirmation, mode === 'plan'
    ? 'INSPECT_EXISTING_CASE01_BIND_AND_BUDGET_ONLY'
    : 'BIND_EXISTING_CASE01_AND_INSTALL_BOUNDED_BUDGET_ONCE');
  const rateBytes = await readFile('/dev/shm/case01-reviewed-rates-v2.json');
  assert.equal(bytesHash(rateBytes), RATE_BYTES);
  const rates = JSON.parse(rateBytes.toString('utf8'));
  assert.equal(captureBudgetHash(rates), RATE_VALUE);
  const qualificationFor = currentVerifySha256 => {
    const q = {
      version: 1, caseId: '01', captureRunId: RUN, currentVerifySha256,
      rateEvidenceSha256: RATE_VALUE, rateEvidenceExpiresAt: rates.expiresAt,
      priceKind: 'qualified_text_token_upper_bound', maxAttempts: 32,
      maxTokens: 500000, maxCostMicros: 15000000, rates: rates.rates,
    };
    // Reserve at least the current maximum policy lifetime; this is real time.
    validateCaptureBudgetQualification(q, { caseId: '01', captureRunId: RUN, expiresAt: Date.now() + 30 * 60000 });
    assertRateEvidence(rates, q);
    return q;
  };
  qualificationFor('0'.repeat(64)); // Fail expired/malformed rates before any DB work.
  output = await open(out, 'wx');
  await log('START', { mode, sourceSha: SOURCE, captureRunId: RUN, rateBytesSha256: RATE_BYTES });
  process.env.DATABASE_URL = execFileSync(process.execPath,
    ['/app/apps/api/scripts/lib/pe-compose-database-url.js'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  factory = await createCase01SetupDependencies();
  const result = await factory.runWithTenant(CTX, async () => {
    let actualProof;
    const sourceAuthority = { qualifyInTx: async (tx, ctx, scope) => {
      assert.deepEqual(ctx, CTX);
      assert.deepEqual(scope, { caseId: '01', clientId: CLIENT });
      diagnosticSubstage = 'READ_INVENTORY';
      const inventory = await readCase01MemoryCorpusInTx(factory.deps, tx, ctx, scope.clientId);
      diagnosticSubstage = 'VERIFY_INVENTORY';
      assert.equal(inventory.fixtureReady, true);
      assert.deepEqual(inventory.missing, []);
      assert.equal(inventory.captureAuthority, false);
      const rows = await tx.$queryRawUnsafe(
        "SELECT settings_jsonb->'meriFoundationFixture'->'case01MemoryOwner' AS locator FROM tenants WHERE id=$1::uuid FOR UPDATE",
        ctx.tenantId,
      );
      assert.equal(rows.length, 1);
      const locator = rows[0].locator;
      diagnosticSubstage = 'VERIFY_LOCATOR';
      assert.equal(locator.fixtureNamespace, NAMESPACE);
      assert.equal(locator.proposerUserId, CTX.userId);
      assert.equal(locator.clients.ASTER.physicalId, CLIENT);
      const config = { clients: locator.clients, actors: locator.actors, uploaderActors: locator.uploaderActors };
      diagnosticSubstage = 'BUILD_PREVIOUS_MANIFEST';
      const previousManifest = await buildFixtureManifest({ ...config, fixtureInstanceId: locator.previousFixtureInstanceId });
      diagnosticSubstage = 'BUILD_CURRENT_MANIFEST';
      const currentManifest = await buildFixtureManifest({ ...config, fixtureInstanceId: locator.currentFixtureInstanceId });
      const runtimeDeps = { ...factory.deps,
        proposerForTenant: id => { assert.equal(id, CTX.tenantId); return CTX.userId; },
        reviewerForTenant: () => { throw new Error('CASE01_SETUP_NO_REVIEW_AUTHORITY'); },
      };
      const previous = createCase01MemoryFixtureRuntime({ ...runtimeDeps, manifest: previousManifest });
      diagnosticSubstage = 'HYDRATE_PREVIOUS';
      await previous.hydrateInTx(tx, ctx, { lifecycle: 'retired' });
      const current = createCase01MemoryFixtureRuntime({ ...runtimeDeps, manifest: currentManifest, previousOwner: previous });
      diagnosticSubstage = 'HYDRATE_CURRENT';
      await current.hydrateInTx(tx, ctx, { lifecycle: 'current' });
      diagnosticSubstage = 'QUALIFY_CURRENT';
      actualProof = await current.qualifyInTx(tx, ctx, scope);
      diagnosticSubstage = 'COMPARE_CANONICAL_PROOF';
      for (const key of ['fixtureVersion', 'physicalMapSha256', 'seedReceiptId', 'resetReceiptId', 'currentVerifySha256'])
        assert.equal(actualProof[key], inventory[key]);
      assert.equal(sha256Stable(actualProof.currentVerify), inventory.currentVerifySha256);
      return actualProof; // Only the actual canonical runtime proof enters bind.
    } };
    const owner = createCaptureBindingOwner({ prisma: bindingTransactionScope(factory.deps.prisma), sourceAuthority });
    stage = 'INSPECT';
    diagnosticSubstage = 'OWNER_INSPECT';
    const bindingPlan = await owner.inspect(request);
    diagnosticSubstage = 'VERIFY_BINDING_PLAN';
    assert.equal(bindingPlan.status, 'READY');
    diagnosticSubstage = 'READ_SAVED_STATE';
    const before = await savedState();
    diagnosticSubstage = 'VERIFY_SAVED_STATE';
    assert.equal(before.tenantRowVersion, bindingPlan.expectedTenantRowVersion);
    assert.equal(before.bindingSha256, bindingPlan.expectedPriorBindingSha256);
    assert.notEqual(before.binding?.captureRunId, RUN); // No repeat or partial-run repair.
    diagnosticSubstage = 'BUILD_QUALIFICATION';
    const qualification = qualificationFor(bindingPlan.currentVerifySha256);
    const plan = {
      sourceSha: SOURCE, request, rateBytesSha256: RATE_BYTES, rateValueSha256: RATE_VALUE,
      bindingPlan, qualification, priorQualificationSha256: before.qualificationSha256,
      protectedSettingsSha256: before.protectedSettingsSha256,
      fixture: Object.fromEntries(['fixtureVersion', 'sourceMap', 'physicalMapSha256', 'seedReceiptId', 'resetReceiptId', 'currentVerifySha256'].map(k => [k, actualProof[k]])),
    };
    const planSha256 = sha256Stable(plan);
    if (mode === 'plan') return { status: 'PLAN_ONLY', plan, planSha256 };
    assert.equal(input.planSha256, sha256Stable(input.plan));
    assert.equal(input.planSha256, planSha256); // Fresh re-inspection; never caller READY.
    assert.deepEqual(input.plan, plan);
    stage = 'BIND_DISPATCHING';
    await log('INTENT', { planSha256 });
    diagnosticSubstage = 'OWNER_BIND';
    const bound = await owner.bind({ ...request,
      expectedPriorBindingSha256: bindingPlan.expectedPriorBindingSha256,
      expectedTenantRowVersion: bindingPlan.expectedTenantRowVersion,
      expectedCurrentVerifySha256: bindingPlan.currentVerifySha256,
    });
    assert.equal(bound.status, 'BOUND');
    stage = 'BOUND';
    await log('VERIFIED', { bound });
    diagnosticSubstage = 'BUDGET_PLAN';
    const budgetPlan = await inspectCaptureProviderBudgetInstallation(factory.deps, { ctx: CTX, clientId: CLIENT });
    assert.equal(budgetPlan.status, 'READY_FOR_RATE_QUALIFICATION');
    assert.equal(budgetPlan.captureRunId, RUN);
    assert.equal(budgetPlan.caseId, '01');
    assert.equal(budgetPlan.currentVerifySha256, bindingPlan.currentVerifySha256);
    assert.equal(budgetPlan.captureBindingSha256, bound.bindingSha256);
    assert.equal(budgetPlan.tenantRowVersion, bound.tenantRowVersion);
    assert.equal(budgetPlan.priorQualificationSha256, before.qualificationSha256);
    diagnosticSubstage = 'READ_MIDDLE_STATE';
    const middle = await savedState();
    assert.equal(middle.tenantRowVersion, budgetPlan.tenantRowVersion);
    assert.equal(middle.protectedSettingsSha256, before.protectedSettingsSha256);
    qualificationFor(budgetPlan.currentVerifySha256); // Recheck real expiry before install.
    stage = 'BUDGET_INSTALL_DISPATCHING';
    await log('INTENT', { budgetPlan, qualificationSha256: captureBudgetHash(qualification) });
    diagnosticSubstage = 'BUDGET_INSTALL';
    const installed = await installCaptureProviderBudgetQualification(factory.deps, {
      ctx: CTX, clientId: CLIENT, qualification, rateEvidence: rates,
      expectedCurrentVerifySha256: budgetPlan.currentVerifySha256,
      expectedCaptureBindingSha256: budgetPlan.captureBindingSha256,
      expectedPriorQualificationSha256: budgetPlan.priorQualificationSha256,
      expectedTenantRowVersion: budgetPlan.tenantRowVersion,
    });
    assert.equal(installed.status, 'PROVIDER_QUALIFICATION_INSTALLED');
    stage = 'BUDGET_INSTALLED';
    await log('VERIFIED', { installed });
    diagnosticSubstage = 'BUDGET_READBACK';
    const readback = await inspectCaptureProviderBudgetInstallation(factory.deps, { ctx: CTX, clientId: CLIENT });
    diagnosticSubstage = 'READ_FINAL_STATE';
    const after = await savedState();
    assert.equal(readback.tenantRowVersion, installed.tenantRowVersion);
    assert.equal(after.tenantRowVersion, installed.tenantRowVersion);
    assert.equal(after.bindingSha256, bound.bindingSha256);
    assert.equal(readback.priorQualificationSha256, captureBudgetHash(qualification));
    assert.equal(after.qualificationSha256, captureBudgetHash(qualification));
    assert.equal(after.protectedSettingsSha256, before.protectedSettingsSha256);
    return { status: 'BOUND_AND_BUDGET_READ_BACK', bound, installed, readback, fixture: plan.fixture,
      protectedSettingsSha256: after.protectedSettingsSha256, planSha256 };
  });
  stage = 'COMPLETE';
  await log('RESULT', { ...result, providerCalls: 0, conversationCreations: 0,
    journalOpened: false, fixtureLifecycleMutations: 0, liveAcceptance: 'NOT_RUN' });
} catch (error) {
  const code = /^(?:CASE01_|CAPTURE_BINDING_|meri_capture_provider_budget_)[a-zA-Z0-9_]+$/u.test(error?.code ?? error?.message ?? '')
    ? (error.code ?? error.message) : 'CASE01_SETUP_GUARD_OR_RUNTIME_FAILURE';
  const diagnostic = {
    substage: diagnosticSubstage,
    errorClass: ['AssertionError','Error','PrismaClientKnownRequestError','PrismaClientUnknownRequestError','PrismaClientInitializationError','FixtureProvisioningError','TypeError'].includes(error?.name) ? error.name : 'OTHER_ERROR_CLASS',
    errorCode: /^(?:P[0-9]{4}|ERR_ASSERTION|CASE01_[A-Z0-9_]+|CAPTURE_BINDING_[A-Z0-9_]+)$/u.test(error?.code ?? '') ? error.code : null,
    messageSha256: bytesHash(String(error?.message ?? '')),
    timeoutMentioned: /timeout|timed out|transaction already closed/iu.test(String(error?.message ?? '')),
    frames: String(error?.stack ?? '').split('\n').slice(1).filter(line => /^\s+at /u.test(line) && /\/(?:app|dev\/shm)\//u.test(line)).slice(0,12).map(line => line.trim().slice(0,300)),
    assertionOperator: /^[A-Za-z]+$/u.test(error?.operator ?? '') ? error.operator : null,
    assertionActualType: typeof error?.actual,
    assertionExpectedType: typeof error?.expected,
    messageOmitted: true, sqlAndMetaOmitted: true,
  };
  const failure = { status: 'BLOCKED_OR_UNCERTAIN', code, lastStage: stage, diagnostic,
    automaticRetryAllowed: false, liveAcceptance: 'NOT_RUN' };
  try { if (output) await log('FAILURE', failure); }
  catch { /* Preserve earlier intents; stdout still reports uncertainty. */ }
  process.stderr.write(`C2_CASE01_NATIVE_SETUP_FAILURE ${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
} finally {
  if (factory) await factory.close();
  if (output) await output.close();
}
