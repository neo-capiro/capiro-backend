// Codex local preparation. NOT RUN. Root owns ECS lifecycle and independent review.
// This adapter does not approve memory or account for approval projection providers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PIN = Object.freeze({
  source: 'c0f393f863bf73bd4e65e7a94e17c073e7be021e',
  namespace: 'meri-foundation-20260928',
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  tenantSlug: 'meri-foundation-20260928-t1',
  reviewerId: 'fb218bf5-2674-4ced-bca3-7a5d0c01592f',
  reviewerClerkId: 'user_3Jw2G2jbyyDlrrg6zCNd4gYUDfH',
  proposerId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
  fixtureInstanceId: 'dee4e90e-8e91-4782-9488-10b8e52a2146',
  candidateId: '6f4545a1-dcd5-5eba-8606-db2043b238ac',
  recipeSha256: '1668649c84550f701faea8e30617da11c944c84caeb99965afa311acd017e593',
  manifestContentSha256: '5deda70f94698a8f8ed82d40fa804d16ae2e39a091012af0d70203a0e1b5fc14',
  setupReceiptSha256: 'c2c80bdef51e6b8b22d13c809e77e76c61eb680fa10aca88372f258d53a155f8',
  seedPlanSha256: '42ed4d5a6466c9834a9d578092b98f07039808cf424a6a77095aca22202c21f2',
  ownershipMarkerSha256: '48b95413d7b876a412e3c5352ac4e3fecfea5eb8b260e2cd327736829ee1faab',
  payloadSha256: '1b2333f97623789682efa51f479a8a0a452a2c4d1181b121437c51f4f0be499e',
  rateEvidenceSha256: 'a1a179383c8451495336169f46025eb8cee8ec95487f1a43017078387b768b11',
  rateEvidenceExpiresAt: '2026-10-04T05:29:01.587Z',
});
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
export const stableHash = v => hash(JSON.stringify(stable(v)));
const keys = (v, expected) => assert.deepEqual(Object.keys(v).sort(), [...expected].sort());
const sha = value => assert.match(value, HASH);
const zero = r => { assert.equal(r.sharedCorpusWrites, 0); assert.equal(r.approvalDecisions, 0); assert.equal(r.liveAcceptance, 'NOT_RUN'); };

export function validateInput(input, now = Date.now()) {
  keys(input, ['kind', 'version', 'sourceSha', 'captureRunId', 'ctx', 'clientId', 'approvalEvidenceSha256', 'approvedOwner', 'limits', 'rateEvidence']);
  assert.equal(input.kind, 'case14-postapproval-native-setup-input'); assert.equal(input.version, 1);
  assert.equal(input.sourceSha, PIN.source); assert.match(input.captureRunId, UUID);
  keys(input.ctx, ['tenantId', 'tenantSlug', 'userId', 'clerkUserId', 'role']);
  assert.deepEqual(input.ctx, { tenantId: PIN.tenantId, tenantSlug: PIN.tenantSlug,
    userId: PIN.reviewerId, clerkUserId: PIN.reviewerClerkId, role: 'user_admin' });
  assert.equal(input.clientId, PIN.clientId); sha(input.approvalEvidenceSha256);
  const o = input.approvedOwner;
  keys(o, ['kind','schemaVersion','caseId','fixtureNamespace','fixtureVersion','fixtureInstanceId',
    'manifestContentSha256','recipeSha256','seedPlanSha256','setupReceiptSha256','tenantId','clientId',
    'proposerUserId','reviewerUserId','reviewerRole','logicalSourceId','candidateId','candidateRowVersion',
    'revision','ownershipMarkerSha256','payloadSha256','text','state','item','decision','currentVerifySha256']);
  const { currentVerifySha256, ...body } = o; assert.equal(currentVerifySha256, stableHash(body));
  assert.equal(o.kind, 'meri-case14-current-memory-owner'); assert.equal(o.schemaVersion, 1);
  assert.equal(o.caseId, '14'); assert.equal(o.fixtureNamespace, PIN.namespace);
  assert.equal(o.fixtureVersion, 'meri-live-v1-2026-09-26.1');
  for (const field of ['fixtureInstanceId','recipeSha256','manifestContentSha256','setupReceiptSha256','tenantId','clientId','candidateId','seedPlanSha256','ownershipMarkerSha256','payloadSha256']) assert.equal(o[field], PIN[field]);
  assert.equal(o.proposerUserId, PIN.proposerId); assert.equal(o.reviewerUserId, PIN.reviewerId);
  assert.equal(o.reviewerRole, 'user_admin'); assert.equal(o.logicalSourceId, 'MEM-PROPOSAL-14');
  assert.equal(o.revision, 1); assert.equal(o.state, 'approved');
  assert.equal(o.text, 'Synthetic Aster candidate for approval'); assert.match(o.candidateRowVersion, /^\d+$/u);
  for (const field of ['seedPlanSha256','ownershipMarkerSha256','payloadSha256']) sha(o[field]);
  keys(o.item, ['id','clioMemoryId','rowVersion','sourceVersion','contentSha256','status','governedStatus']);
  assert.match(o.item.id, UUID); assert.match(o.item.clioMemoryId, UUID); assert.match(o.item.rowVersion, /^\d+$/u);
  assert.equal(o.item.sourceVersion, 'candidate:' + PIN.candidateId); sha(o.item.contentSha256);
  assert.equal(o.item.status, 'active'); assert.equal(o.item.governedStatus, 'active');
  keys(o.decision, ['transitionAuditId','actorUserId','decision']); assert.match(o.decision.transitionAuditId, UUID);
  assert.equal(o.decision.actorUserId, PIN.reviewerId); assert.equal(o.decision.decision, 'approved');
  keys(input.limits, ['maxAttempts','maxTokens','maxCostMicros']);
  assert.equal(input.limits.maxAttempts, 32); assert.equal(input.limits.maxTokens, 500000);
  assert.ok(Number.isSafeInteger(input.limits.maxCostMicros) && input.limits.maxCostMicros > 0 && input.limits.maxCostMicros <= 15000000);
  assert.equal(stableHash(input.rateEvidence), PIN.rateEvidenceSha256);
  assert.equal(input.rateEvidence.expiresAt, PIN.rateEvidenceExpiresAt);
  assert.ok(Date.parse(input.rateEvidence.observedAt) <= now);
  // 30-minute policy lifetime plus 15 minutes for setup/collection. Never extend evidence.
  assert.ok(Date.parse(input.rateEvidence.expiresAt) > now + 45 * 60000, 'RATE_EVIDENCE_LESS_THAN_45_MINUTES');
  return input;
}

const PLAN_KEYS = ['kind','schemaVersion','caseId','captureRunId','tenantId','actorUserId','clientId','tenantRowVersion',
  'priorSettingsSha256','approvedOwnerSha256','physicalMapSha256','sharedCorpusWrites','approvalDecisions','liveAcceptance','planSha256'];
const BIND_KEYS = ['status','operationId','binding','sourceMap','seedReceipt','resetReceipt','sharedCorpusWrites','approvalDecisions','synthesisSubmissionCount','liveAcceptance'];
const BUDGET_PLAN_KEYS = ['status','caseId','captureRunId','currentVerifySha256','captureBindingSha256','priorQualificationSha256','tenantRowVersion','liveAcceptance'];
const INSTALL_KEYS = ['status','tenantId','clientId','captureRunId','currentVerifySha256','captureBindingSha256','qualificationSha256',
  'priorQualificationSha256','tenantRowVersion','maxCostMicros','rateEvidenceSha256','rateEvidenceExpiresAt','liveAcceptance'];
const STAGES = Object.freeze([
  { name: 'recall-plan', cli: 'meri-case14-recall-setup.mjs', mode: 'plan', inputEnv: 'MERI_CASE14_RECALL_SETUP_INPUT', resultKeys: PLAN_KEYS, writes: false },
  { name: 'recall-bind', cli: 'meri-case14-recall-setup.mjs', mode: 'bind', inputEnv: 'MERI_CASE14_RECALL_SETUP_INPUT', resultKeys: BIND_KEYS, writes: true },
  { name: 'budget-plan', cli: 'meri-capture-provider-budget.mjs', mode: 'plan', inputEnv: 'MERI_CAPTURE_PROVIDER_BUDGET_INPUT', resultKeys: BUDGET_PLAN_KEYS, writes: false },
  { name: 'budget-install', cli: 'meri-capture-provider-budget.mjs', mode: 'install', inputEnv: 'MERI_CAPTURE_PROVIDER_BUDGET_INPUT', resultKeys: INSTALL_KEYS, writes: true },
]);
function sourceMap(input) { return { 'MEM-PROPOSAL-14': { frozenFixtureId: 'MEM-PROPOSAL-14', kind: 'memory',
  physicalId: input.approvedOwner.item.id, tenantPhysicalId: PIN.tenantId, clientPhysicalId: PIN.clientId,
  version: 'candidate:' + PIN.candidateId } }; }
function verifyReceiptHash(receipt, kind) {
  assert.equal(receipt.kind, kind); const { contentSha256, ...body } = receipt;
  assert.equal(contentSha256, stableHash(body));
}

// Injection is a local test seam only. main() always supplies the fixed native implementation.
export async function sequence(input, invoke, frame, now = Date.now) {
  validateInput(input, now());
  const scope = { ctx: input.ctx, caseId: '14', clientId: input.clientId, captureRunId: input.captureRunId };
  const budgetScope = { target: 'capiro-dev', fixtureNamespace: PIN.namespace, caseId: '14', ctx: input.ctx, clientId: input.clientId };
  const results = {}, phaseInputs = {}, completed = [];
  let active = null;
  try {
    for (const stage of STAGES) {
      active = stage;
      // Recheck expiry before each possible settings write.
      validateInput(input, now());
      let body;
      if (stage.name === 'recall-plan') body = scope;
      if (stage.name === 'recall-bind') body = { ...scope, expectedPlanSha256: results['recall-plan'].planSha256,
        confirmation: 'BIND_EXISTING_CASE14_CANONICAL_APPROVAL' };
      if (stage.name === 'budget-plan') body = budgetScope;
      if (stage.name === 'budget-install') {
        const p = results['budget-plan'];
        body = { ...budgetScope, qualification: { version: 1, caseId: '14', captureRunId: input.captureRunId,
          currentVerifySha256: p.currentVerifySha256, rateEvidenceSha256: PIN.rateEvidenceSha256,
          rateEvidenceExpiresAt: PIN.rateEvidenceExpiresAt, priceKind: input.rateEvidence.priceKind,
          ...input.limits, rates: input.rateEvidence.rates }, rateEvidence: input.rateEvidence,
          expectedCurrentVerifySha256: p.currentVerifySha256, expectedCaptureBindingSha256: p.captureBindingSha256,
          expectedPriorQualificationSha256: p.priorQualificationSha256, expectedTenantRowVersion: p.tenantRowVersion };
      }
      phaseInputs[stage.name] = body;
      await frame({ phase: 'INTENT', stage: stage.name, ownerInputSha256: stableHash(body), mayWriteSettings: stage.writes, automaticRetryAllowed: false });
      const child = await invoke(stage, body);
      let result = null;
      if (child.bytes?.length > 0 && child.bytes.length <= 32768) {
        try {
          result = JSON.parse(child.bytes.toString('utf8'));
          // Only known CLI receipt shapes are permitted in the cloud log. Never print child stdout/stderr.
          if (result.status === 'FAILED') { keys(result, ['status','code','liveAcceptance']); assert.match(result.code, /^meri_capture_provider_budget_[A-Za-z0-9_]+$/u); }
          else keys(result, stage.resultKeys);
          await frame({ phase: 'RECEIPT', stage: stage.name, childExitCode: child.status,
            sha256: hash(child.bytes), bytes: child.bytes.length, data: child.bytes.toString('base64') });
        } catch { result = null; }
      }
      assert.equal(child.status, 0, 'NATIVE_CHILD_FAILED_OR_UNKNOWN'); assert.ok(result, 'NATIVE_RECEIPT_MISSING_OR_INVALID');
      assert.equal(result.liveAcceptance, 'NOT_RUN');
      if (stage.name === 'recall-plan') {
        const { planSha256, ...p } = result; assert.equal(planSha256, stableHash(p));
        assert.equal(p.kind, 'meri-case14-recall-binding-plan'); assert.equal(p.schemaVersion, 1); zero(p);
        for (const [k, value] of Object.entries({ caseId: '14', captureRunId: input.captureRunId,
          tenantId: PIN.tenantId, actorUserId: PIN.reviewerId, clientId: PIN.clientId,
          approvedOwnerSha256: input.approvedOwner.currentVerifySha256, physicalMapSha256: stableHash(sourceMap(input)) })) assert.equal(p[k], value);
        sha(p.priorSettingsSha256); assert.match(p.tenantRowVersion, /^\d+$/u);
      } else if (stage.name === 'recall-bind') {
        assert.equal(result.status, 'CASE14_RECALL_BOUND'); zero(result); assert.equal(result.synthesisSubmissionCount, 0);
        assert.match(result.operationId, UUID); assert.deepEqual(result.sourceMap, sourceMap(input));
        verifyReceiptHash(result.seedReceipt, 'meri-synthetic-fixture-seed-receipt');
        verifyReceiptHash(result.resetReceipt, 'meri-synthetic-fixture-reset-receipt');
        const seed = result.seedReceipt, reset = result.resetReceipt;
        assert.equal(seed.owner, 'meri_case14_canonical_approval_v1'); assert.equal(reset.owner, seed.owner);
        for (const receipt of [seed, reset]) assert.equal(receipt.operationId, result.operationId);
        for (const [k, value] of Object.entries({ tenantId: PIN.tenantId, actorUserId: PIN.reviewerId, clientId: PIN.clientId,
          caseId: '14', captureRunId: input.captureRunId, approvedOwnerSha256: input.approvedOwner.currentVerifySha256,
          physicalMapSha256: stableHash(sourceMap(input)), setupReceiptSha256: PIN.setupReceiptSha256,
          transitionAuditId: input.approvedOwner.decision.transitionAuditId })) assert.equal(seed[k], value);
        assert.equal(reset.scope, 'replace_owned_capture_binding_only_after_canonical_approval'); assert.equal(reset.sharedCorpusWrites, 0);
        assert.equal(reset.priorSettingsSha256, results['recall-plan'].priorSettingsSha256);
        assert.deepEqual(result.binding, { caseId: '14', captureRunId: input.captureRunId,
          fixtureVersion: input.approvedOwner.fixtureVersion, physicalMapSha256: stableHash(sourceMap(input)),
          seedReceiptId: 'meri-synthetic-fixture-seed-receipt:sha256:' + seed.contentSha256,
          resetReceiptId: 'meri-synthetic-fixture-reset-receipt:sha256:' + reset.contentSha256,
          fixtureNamespace: PIN.namespace, actorUserId: PIN.reviewerId, clientId: PIN.clientId,
          currentVerifySha256: stableHash({ kind: 'meri-case14-current-approved-source', schemaVersion: 1,
            canonicalOwner: input.approvedOwner, seedReceiptSha256: seed.contentSha256, resetReceiptSha256: reset.contentSha256 }) });
      } else if (stage.name === 'budget-plan') {
        assert.equal(result.status, 'READY_FOR_RATE_QUALIFICATION'); assert.equal(result.caseId, '14');
        assert.equal(result.captureRunId, input.captureRunId);
        assert.equal(result.currentVerifySha256, results['recall-bind'].binding.currentVerifySha256);
        assert.equal(result.captureBindingSha256, stableHash(results['recall-bind'].binding));
        assert.equal(result.priorQualificationSha256, stableHash(null)); assert.match(result.tenantRowVersion, /^\d+$/u);
      } else {
        assert.equal(result.status, 'PROVIDER_QUALIFICATION_INSTALLED');
        for (const [k, value] of Object.entries({ tenantId: PIN.tenantId, clientId: PIN.clientId, captureRunId: input.captureRunId,
          currentVerifySha256: body.expectedCurrentVerifySha256, captureBindingSha256: body.expectedCaptureBindingSha256,
          priorQualificationSha256: body.expectedPriorQualificationSha256, qualificationSha256: stableHash(body.qualification),
          maxCostMicros: input.limits.maxCostMicros, rateEvidenceSha256: PIN.rateEvidenceSha256,
          rateEvidenceExpiresAt: PIN.rateEvidenceExpiresAt })) assert.equal(result[k], value);
        assert.match(result.tenantRowVersion, /^\d+$/u);
      }
      results[stage.name] = result; completed.push(stage.name);
      await frame({ phase: 'VERIFIED', stage: stage.name, receiptSha256: hash(child.bytes) });
    }
    const value = { kind: 'case14-postapproval-native-setup', status: 'RECALL_BOUND_AND_BUDGET_INSTALLED',
      preparedBy: 'Codex', sourceSha: PIN.source, captureRunId: input.captureRunId,
      approvalEvidenceSha256: input.approvalEvidenceSha256, inputContentSha256: stableHash(input),
      phaseInputs, results, completed, adapterProviderCalls: 0, approvalProviderEffects: 'NOT_ACCOUNTED_BY_THIS_ADAPTER',
      reviewDecisions: 0, synthesisSubmissions: 0, aggregateJournalMutations: 0, liveAcceptance: 'NOT_RUN', acceptanceAuthority: false };
    await frame({ phase: 'COMPLETE', value }); return value;
  } catch {
    await frame({ phase: 'FAILURE', stage: active?.name ?? null, completed,
      code: 'CASE14_POSTAPPROVAL_SETUP_FAILED', automaticRetryAllowed: false,
      effectStatus: completed.includes('recall-bind') || active?.writes ? 'RECONCILE_PARTIAL_NATIVE_SETUP_NO_RETRY' : 'NO_NATIVE_WRITE_DISPATCHED',
      liveAcceptance: 'NOT_RUN', acceptanceAuthority: false });
    throw new Error('CASE14_POSTAPPROVAL_SETUP_FAILED');
  }
}

async function main() {
  let inputByteSha256 = null;
  const emit = value => new Promise((resolve, reject) => process.stdout.write('C2_CASE14_POSTAPPROVAL ' + JSON.stringify({sourceSha: PIN.source, inputByteSha256, ...value}) + '\n', e => e ? reject(e) : resolve()));
  try {
    assert.equal(process.env.RELEASE_SHA, PIN.source); assert.equal(process.env.GIT_SHA, PIN.source);
    assert.equal(process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE, PIN.namespace);
    const bytes = Buffer.from(process.env.C2_CASE14_POSTAPPROVAL_INPUT_B64 ?? '', 'base64');
    assert.ok(bytes.length > 0 && bytes.length <= 32768); sha(process.env.C2_CASE14_POSTAPPROVAL_INPUT_SHA256);
    assert.equal(hash(bytes), process.env.C2_CASE14_POSTAPPROVAL_INPUT_SHA256);
    inputByteSha256 = hash(bytes);
    const input = validateInput(JSON.parse(bytes));
    const root = '/dev/shm/case14-postapproval-' + input.captureRunId;
    // One process attempt. A recovered/replayed task must never reuse a partial operation.
    for (const stage of STAGES) assert.equal(existsSync(root + '-' + stage.name + '.json'), false);
    writeFileSync(root + '-intent.json', JSON.stringify({ inputByteSha256: hash(bytes), captureRunId: input.captureRunId }) + '\n', { flag: 'wx', mode: 0o600 });
    const env = {};
    for (const name of ['PATH','TMPDIR','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME','PGSSLMODE',
      'AWS_REGION_DEFAULT','MERI_SYNTHETIC_FIXTURE_NAMESPACE','RELEASE_SHA','GIT_SHA','MEMORY_CLIENT_REVIEW',
      'MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_ENFORCE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_TENANTS']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    // Only the existing composer receives the four injected DB secret fields.
    const composed = spawnSync(process.execPath, ['/app/apps/api/scripts/lib/pe-compose-database-url.js'], {
      env, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 30000, maxBuffer: 65536 });
    assert.equal(composed.status, 0); assert.match(composed.stdout, /^postgresql:\/\//u);
    env.DATABASE_URL = composed.stdout.trim();
    const deadline = Date.now() + 240000;
    const invoke = async (stage, body) => {
      const remaining = deadline - Date.now(); assert.ok(remaining > 1000);
      const path = root + '-' + stage.name + '.json';
      const child = spawnSync(process.execPath, ['/app/apps/api/scripts/' + stage.cli, stage.mode,
        '--input-env', stage.inputEnv, '--out', path], { env: { ...env, [stage.inputEnv]: JSON.stringify(body) },
        encoding: 'utf8', stdio: ['ignore','ignore','ignore'], timeout: Math.min(90000, remaining), maxBuffer: 262144 });
      let receiptBytes = null; try { receiptBytes = readFileSync(path); } catch {}
      return { status: child.status, bytes: receiptBytes };
    };
    await sequence(input, invoke, emit);
  } catch { await emit({ phase: 'FATAL', code: 'CASE14_POSTAPPROVAL_ADAPTER_FAILED', automaticRetryAllowed: false,
    effectStatus: 'RECONCILE_SAVED_PHASE_RECEIPTS_BEFORE_ANY_FURTHER_OPERATION', acceptanceAuthority: false }); process.exitCode = 1; }
}
// Run for a direct file or the outer's inline `node --input-type=module -e` body;
// importing the builder from another inline program must remain side-effect free.
if (process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : /\/\[eval\d+\]$/u.test(import.meta.url)) await main();
