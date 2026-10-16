import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const hashSource = await readFile(new URL('../../clients/objectives/objective-work-intent.ts', import.meta.url), 'utf8');
const hashUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(hashSource)).toString('base64')}`;
const { objectiveRevisionSnapshotHash: hash } = await import(hashUrl);
const errorSource = await readFile(new URL('./objective-workload-current.ts', import.meta.url), 'utf8');
const errorUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(errorSource.replace(
  "from '../../clients/objectives/objective-work-intent.js'", `from '${hashUrl}'`))).toString('base64')}`;
const laterSource = await readFile(new URL('./objective-workload-later-current.ts', import.meta.url), 'utf8');
const laterUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(laterSource.replace(
  "from '../../clients/objectives/objective-work-intent.js'", `from '${hashUrl}'`).replace(
  "from './objective-workload-current.js'", `from '${errorUrl}'`))).toString('base64')}`;
const { decideObjectiveLaterCurrentWithinTx: decide } = await import(laterUrl);
const { ObjectiveCurrentSourceUnavailable } = await import(errorUrl);
const denied = error => error instanceof ObjectiveCurrentSourceUnavailable;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now = 1_800_000_000_000;
const policy = 'a'.repeat(64);
function fixture(phase = 'publish') {
  const tenant = id(1), client = id(2), objective = id(3), jobId = id(4), requestId = id(5),
    actor = id(6), membership = id(7), consent = id(8), delegation = id(9), clerk = 'user_clerk_fixture';
  const request = { requestId, clientId: client, objective: { objectiveId: objective, objectiveVersion: 1 }, type: 'appropriations' };
  const canonical = { canonicalPlanId: id(10), tenantId: tenant, clientId: client, objectiveId: objective,
    canonicalStrategyId: id(11), canonicalProjectId: id(12), bindingVersion: 1, epoch: 1,
    requestedIntentId: id(13), requestedObjectiveRevisionId: id(14), requestedObjectiveVersion: 1,
    snapshotHash: 'b'.repeat(64) };
  const admission = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1', canonical,
    actorUserId: actor, clerkUserId: clerk, consentId: consent, controlVersion: 1,
    generationJobId: jobId, generationRequestId: requestId, admittedAtMs: now - 3_000,
    effectExpiresAtMs: now + 20_000, expectedStrategyVersionId: null };
  const admissionSha = hash(admission), binding = { tenantId: tenant, actorId: clerk, conversationId: id(20),
    runId: id(21), attemptId: id(22), workerId: id(23), writerFence: 1 };
  const issuanceKey = hash(binding), owner = { sourceAdmissionSha256: admissionSha,
    sourceBinding: binding, sourceRequestSha256: 'c'.repeat(64), issuanceKey,
    expiresAtMs: now + 18_000, grantId: id(24), capabilitySha256: 'd'.repeat(64),
    factsSha256: 'e'.repeat(64), typedRequestSha256: 'f'.repeat(64),
    executionContextSha256: '1'.repeat(64), acceptedRequestId: requestId,
    acceptedPromptSha256: '2'.repeat(64) };
  const h = hash(['objective_canonical_generation_admission',tenant,clerk,jobId]);
  const markerId = `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
  const rows = {
    job: { id: jobId, tenantId: tenant, clientId: client, clerkUserId: clerk,
      status: 'queued', attempt: 1, claimedBy: null, claimedAt: null, strategyId: null,
      requestKey: `objective-v1:${hash([tenant,clerk,requestId])}`, deadlineAtMs: now + 30_000,
      input: { objectiveGeneration: { request, fingerprint: hash(request) }, canonicalGeneration: { admissionId: markerId } } },
    admission,
    native: { tenantId: tenant, clientId: client, objectiveId: objective, actorUserId: actor,
      membershipId: membership, clerkUserId: clerk, tenantActive: true, membershipActive: true,
      roleAllowed: true, featureEnabled: true, clientActive: true, wallAllowed: true, objectiveExists: true },
    effect: { actorUserId: actor, membershipId: membership, controlId: id(15), consentId: consent,
      controlVersion: 1, canonicalPlanId: id(10), canonicalStrategyId: id(11), canonicalProjectId: id(12),
      bindingVersion: 1, intentId: id(13), objectiveRevisionId: id(14), objectiveVersion: 1,
      snapshotHash: 'b'.repeat(64), objectiveReady: true, controlActive: true, consentCurrent: true,
      confirmedAtMs: now - 5_000, consentExpiresAtMs: now + 25_000 },
    delegation: { ref: delegation, tenantId: tenant, clientId: client, objectiveId: objective,
      action: 'objective.strategy.draft', controlId: id(15), consentId: consent, controlVersion: 1,
      generationJobId: jobId, generationRequestId: requestId, generationRequestFingerprint: hash(request),
      jobRequestKey: `objective-v1:${hash([tenant,clerk,requestId])}`, clerkUserId: clerk,
      serviceSubject: 'capiro-objective-generation-worker:v1', audience: 'capiro:objective-strategy-api:v1',
      policyRevision: policy, issuedAtMs: now - 4_000, absoluteExpiresAtMs: now + 60_000,
      authorityVersion: 1, enabled: true, cancelledAt: null },
    publication: { sourceAdmissionSha256: admissionSha, publicationSha256: '3'.repeat(64),
      generationRequestId: requestId, typedRequestSha256: owner.typedRequestSha256,
      executionContextSha256: owner.executionContextSha256,
      promptSha256: owner.acceptedPromptSha256, originalExpiresAtMs: now + 19_000 },
    acceptance: { sourceAdmissionSha256: admissionSha, sourceBinding: binding,
      sourceRequestSha256: owner.sourceRequestSha256, acceptedAtMs: now - 2_000,
      issuance: { issuanceKey, binding, requestSha256: owner.sourceRequestSha256,
        expiresAtMs: owner.expiresAtMs, grantId: owner.grantId,
        capabilitySha256: owner.capabilitySha256, factsSha256: owner.factsSha256 } },
    noWrites: true,
    outcome: { kind: 'completed', sourceAdmissionSha256: admissionSha,
      sourceBindingSha256: hash(binding), generationJobId: jobId },
    now,
  };
  const calls = [];
  const tx = Object.fromEntries([
    ['lockJob','job'], ['readAdmission','admission'], ['readCurrentNative','native'],
    ['readCurrentEffect','effect'], ['lockDelegation','delegation'], ['readPublication','publication'],
    ['readAcceptance','acceptance'], ['readTerminalNoWrites','noWrites'],
    ['readRetainedOutcome','outcome'], ['databaseNowMs','now'],
  ].map(([method,key]) => [method, async () => { calls.push(method); return structuredClone(rows[key]); }]));
  const selector = { tenantId: tenant, delegationRef: delegation, consentId: consent,
    generationJobId: jobId, phase };
  const accounting = { phase, tenantId: tenant, delegationRef: delegation, generationJobId: jobId,
    actorUserId: actor, membershipId: membership, sourceAdmissionSha256: admissionSha,
    bindingSha256: hash(binding), checkedAtMs: now - 100,
    expiresAtMs: now + 10_000, absoluteExpiresAtMs: rows.delegation.absoluteExpiresAtMs };
  return { selector, options: { enabled: true, policyRevision: policy, originalMeri: owner,
    terminalAccounting: accounting }, rows, tx, calls };
}

test('disabled and malformed phase deny before source access', async () => {
  const f = fixture();
  await assert.rejects(decide(f.tx, f.selector), denied);
  await assert.rejects(decide(f.tx, { ...f.selector, phase: 'unknown' }, f.options), denied);
  assert.equal(f.calls.length, 0);
});

test('unexpected source faults propagate for transaction rollback', async () => {
  for (const method of ['lockJob','readAdmission','readCurrentEffect','lockDelegation']) {
    const f = fixture();
    const fault = new Error(`transient ${method}`);
    f.tx[method] = async () => { throw fault; };
    await assert.rejects(decide(f.tx,f.selector,f.options), error => error === fault);
  }
});

test('publish requires queued job, current consent and retained admission marker', async () => {
  const f = fixture();
  const result = await decide(f.tx, f.selector, f.options);
  assert.equal(result.purpose, 'effect');
  assert.equal(result.acceptedBindingSha256, null);
  assert.equal(result.validUntilMs, now + 20_000);
  assert.deepEqual(f.calls, ['lockJob','readAdmission','readCurrentNative','readCurrentEffect',
    'lockDelegation','databaseNowMs']);
  for (const edit of [
    x => { x.rows.job.input.canonicalGeneration.admissionId = id(99); },
    x => { x.rows.effect.consentCurrent = false; },
    x => { x.rows.job.attempt = 2; },
  ]) { const x = fixture(); edit(x); await assert.rejects(decide(x.tx,x.selector,x.options),denied); }
});

test('accept requires original Meri owner readback and exact publication binding', async () => {
  const f = fixture('accept'); f.rows.acceptance = null;
  await assert.rejects(decide(f.tx, f.selector, { ...f.options, originalMeri: undefined }), denied);
  const permitted = await decide(f.tx, f.selector, f.options);
  assert.equal(permitted.acceptedBindingSha256, hash(f.options.originalMeri.sourceBinding));
  const bad = fixture('accept'); bad.options.originalMeri.acceptedPromptSha256 = '0'.repeat(64);
  await assert.rejects(decide(bad.tx,bad.selector,bad.options),denied);
});

test('complete requires accepted ledger and exact running claim within original deadlines', async () => {
  const f = fixture('complete');
  f.rows.job.status = 'running'; f.rows.job.attempt = 2;
  f.rows.job.claimedAt = now - 2_000;
  f.rows.job.claimedBy = `canonical:${f.options.originalMeri.issuanceKey}`;
  const decision = await decide(f.tx,f.selector,f.options);
  assert.equal(decision.purpose,'effect');
  const missing = fixture('complete'); missing.rows.acceptance = null;
  await assert.rejects(decide(missing.tx,missing.selector,missing.options),denied);
  const expired = fixture('complete'); expired.rows.job.status='running'; expired.rows.job.attempt=2;
  expired.rows.job.claimedAt=now-2_000;
  expired.rows.job.claimedBy=`canonical:${expired.options.originalMeri.issuanceKey}`;
  expired.rows.now += 31_000;
  await assert.rejects(decide(expired.tx,expired.selector,expired.options),denied);
});

test('terminal accounting uses its distinct fresh grant after original effect expiry', async () => {
  const f = fixture('terminal-account'); f.rows.job.status='running'; f.rows.job.attempt=2;
  f.rows.job.claimedAt=now-2_000;
  f.rows.job.claimedBy=`canonical:${f.options.originalMeri.issuanceKey}`;
  f.rows.job.deadlineAtMs = now - 1;
  f.rows.effect.consentExpiresAtMs = now - 1;
  f.options.originalMeri.expiresAtMs = now - 1;
  f.rows.acceptance.issuance.expiresAtMs = now - 1;
  // The ledger and original owner still match. Old deadlines are historical.
  const result = await decide(f.tx,f.selector,f.options);
  assert.equal(result.purpose,'terminal-accounting');
  assert.equal(result.validUntilMs,now+10_000);
  const noSource = fixture('terminal-account'); noSource.options.terminalAccounting = undefined;
  await assert.rejects(decide(noSource.tx,noSource.selector,noSource.options),denied);
  const writes = fixture('terminal-account'); writes.rows.job.status='running'; writes.rows.job.attempt=2;
  writes.rows.job.claimedAt=now-2_000;
  writes.rows.job.claimedBy=`canonical:${writes.options.originalMeri.issuanceKey}`;
  writes.rows.noWrites=false;
  await assert.rejects(decide(writes.tx,writes.selector,writes.options),denied);
});

test('readbacks require exact retained outcome and native visibility', async () => {
  const complete = fixture('completion-read'); complete.rows.job.status='completed';
  assert.equal((await decide(complete.tx,complete.selector,complete.options)).purpose,'read');
  const terminal = fixture('terminal-read'); terminal.rows.job.status='failed';
  terminal.rows.outcome.kind='terminal'; terminal.rows.outcome.outcome='needs-information';
  assert.equal((await decide(terminal.tx,terminal.selector,terminal.options)).purpose,'terminal-accounting');
  const bad = fixture('terminal-read'); bad.rows.job.status='failed';
  bad.rows.outcome.kind='terminal'; bad.rows.outcome.outcome='failed';
  await assert.rejects(decide(bad.tx,bad.selector,bad.options),denied);
  const hidden = fixture('retained-result-read'); hidden.rows.job.status='running';
  hidden.rows.native.wallAllowed=false;
  await assert.rejects(decide(hidden.tx,hidden.selector,hidden.options),denied);
});
