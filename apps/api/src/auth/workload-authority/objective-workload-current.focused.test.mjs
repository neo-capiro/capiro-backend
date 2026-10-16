import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const hashSource = await readFile(new URL('../../clients/objectives/objective-work-intent.ts', import.meta.url), 'utf8');
const hashUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(hashSource)).toString('base64')}`;
const { objectiveRevisionSnapshotHash: digest } = await import(hashUrl);
const strategyHashSource = await readFile(new URL('../../../../api-strategy/src/planner/objective-canonical-application.ts', import.meta.url), 'utf8');
const strategyHashUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(strategyHashSource)).toString('base64')}`;
const { applicationHash: strategyDigest } = await import(strategyHashUrl);
const source = await readFile(new URL('./objective-workload-current.ts', import.meta.url), 'utf8');
const ownUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source.replace(
  "from '../../clients/objectives/objective-work-intent.js'", `from '${hashUrl}'`))).toString('base64')}`;
const { loadObjectivePreacceptanceCurrentFactsWithinTx: load,
  ObjectiveCurrentSourceUnavailable } = await import(ownUrl);

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = 1_800_000_000_000;
const policy = 'a'.repeat(64);
function fixture() {
  const tenant = id(1), client = id(2), objective = id(3), jobId = id(4), requestId = id(5),
    actor = id(6), member = id(7), consentId = id(8), delegationRef = id(9), clerk = 'user_clerk_fixture';
  const request = { requestId, clientId: client, objective: { objectiveId: objective, objectiveVersion: 1 }, type: 'appropriations' };
  const snapshot = { id: objective, clientId: client, version: 1, status: 'ready', deletedAt: null };
  const requestKey = `objective-v1:${digest([tenant, clerk, requestId])}`;
  const fingerprint = digest(request), snapshotHash = digest(snapshot);
  const selector = { tenantId: tenant, delegationRef, consentId, generationJobId: jobId, phase: 'admit' };
  const rows = {
    job: { id: jobId, clientId: client, clerkUserId: clerk, status: 'queued', attempt: 1, claimedBy: null,
      claimedAt: null, strategyId: null, requestKey, input: { objectiveGeneration: { request, fingerprint } }, deadlineAtMs: String(now + 80_000) },
    hint: { actorUserId: actor, membershipId: member, objectiveVersion: 1 },
    member: { actorUserId: actor, membershipId: member, memoryWall: false },
    objective: { version: 1, status: 'ready', revisionId: id(10) },
    canonical: { id: id(11), strategyId: id(12), projectId: id(13), epoch: 1, bindingVersion: 1,
      intentId: id(14), revisionId: id(10), objectiveVersion: 1, snapshotHash },
    root: { actorUserId: actor, revisionActorUserId: actor, revisionId: id(10), objectiveVersion: 1,
      snapshotHash, purpose: 'objective_strategy_plan', state: 'pending', blockedReason: 'runtime_authority_unconnected',
      operation: 'confirm_ready', snapshot },
    consent: { controlId: id(15), controlVersion: 1, consentId, actorUserId: actor, membershipId: member,
      rootActorUserId: actor, canonicalPlanId: id(11), canonicalEpoch: 1, strategyId: id(12), projectId: id(13),
      bindingVersion: 1, intentId: id(14), revisionId: id(10), objectiveVersion: 1, snapshotHash,
      policyId: 'capiro.objective-generation-consent', policyRevision: 1,
      confirmedAtMs: String(now - 1_000), expiresAtMs: String(now + 100_000),
      configuredMs: '180000', effectiveMs: '180000', expiryValid: true },
    delegation: { ref: delegationRef, clientId: client, objectiveId: objective,
      action: 'objective.strategy.draft', controlId: id(15), consentId, controlVersion: 1,
      jobId, requestId, fingerprint, requestKey, clerkUserId: clerk,
      serviceSubject: 'capiro-objective-generation-worker:v1', audience: 'capiro:objective-strategy-api:v1',
      policyRevision: policy, issuedAtMs: String(now - 500), expiresAtMs: String(now + 90_000),
      authorityVersion: 1, enabled: true, cancelledAt: null },
    clock: { nowMs: String(now) },
  };
  const calls = [];
  const tx = { async $queryRaw(parts, ...values) {
    const sql = parts.join('?');
    const key = sql.includes('FROM sp_draft_job') ? 'job' :
      sql.includes('FROM client_objective_work_consents WHERE') ? 'hint' :
      sql.includes('FROM tenants t JOIN') ? 'member' :
      sql.includes('FROM client_memory_access') ? 'wall' :
      sql.includes('FROM client_objectives o JOIN') ? 'objective' :
      sql.includes('FROM client_objective_canonical_plans') ? 'canonical' :
      sql.includes('FROM client_objective_work_intents') ? 'root' :
      sql.includes('FROM client_objective_work_controls') ? 'consent' :
      sql.includes('FROM client_objective_workload_delegations') ? 'delegation' :
      sql.includes('clock_timestamp()') ? 'clock' : null;
    if (!key) throw Error(`unexpected SQL: ${sql}`);
    calls.push({ sql, values, key });
    return rows[key] ? [structuredClone(rows[key])] : [];
  } };
  return { rows, calls, tx, selector, options: { enabled: true, policyRevision: policy } };
}
const denied = error => error instanceof ObjectiveCurrentSourceUnavailable;

test('disabled source fails closed before any database access', async () => {
  const f = fixture();
  await assert.rejects(load(f.tx, f.selector), denied);
  await assert.rejects(load(f.tx, f.selector, { enabled: false, policyRevision: policy }), denied);
  await assert.rejects(load(f.tx, { ...f.selector, phase: 'publish' }, f.options), denied);
  assert.equal(f.calls.length, 0);
});

test('Core and Strategy use the same digest for ordinary stored JSON values', () => {
  for (const value of [null, true, 'σ', 0, -0, 1.25,
    { z: [3, { β: 'v', a: null }], a: { two: 2, one: 1 } },
    ['tenant', 'clerk', id(5)]]) {
    assert.equal(digest(value), strategyDigest(value));
  }
  const f = fixture();
  assert.equal(f.rows.job.input.objectiveGeneration.fingerprint,
    strategyDigest(f.rows.job.input.objectiveGeneration.request));
});

test('synthetic current source derives bounded facts under the documented lock order', async () => {
  const f = fixture();
  const facts = await load(f.tx, f.selector, f.options);
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(facts.actorUserId, f.rows.member.actorUserId);
  assert.equal(facts.membershipId, f.rows.member.membershipId);
  assert.equal(facts.controlId, f.rows.consent.controlId);
  assert.equal(facts.generationRequestFingerprint, f.rows.delegation.fingerprint);
  assert.equal(facts.effectExpiresAtMs, now + 80_000);
  assert.equal(facts.checkedAtMs, now);
  assert.deepEqual(f.calls.map(c => c.key), [
    'job', 'hint', 'member', 'objective', 'canonical', 'root', 'consent', 'delegation', 'clock',
  ]);
  for (const call of f.calls.slice(0, -1)) assert.match(call.sql, /tenant_id\s*=/);
  assert.match(f.calls[0].sql, /FOR UPDATE/);
  assert.match(f.calls[6].sql, /FOR UPDATE OF ctl/);
  assert.match(f.calls[7].sql, /FOR UPDATE/);
});

test('claimed job, changed typed request, superseded consent and disabled delegation refuse', async () => {
  const edits = [
    f => { f.rows.job.attempt = 2; },
    f => { f.rows.job.input.objectiveGeneration.request.type = 'regulatory'; },
    f => { f.rows.consent.consentId = id(99); },
    f => { f.rows.delegation.enabled = false; },
    f => { f.rows.delegation.controlVersion = 2; },
    f => { f.rows.delegation.policyRevision = 'b'.repeat(64); },
    f => { f.rows.clock.nowMs = String(now + 100_000); },
    f => { f.rows.root.snapshot.status = 'draft'; },
  ];
  for (const edit of edits) {
    const f = fixture(); edit(f);
    await assert.rejects(load(f.tx, f.selector, f.options), denied);
  }
});

test('memory wall and exact native membership are required', async () => {
  const noWall = fixture(); noWall.rows.member.memoryWall = true;
  await assert.rejects(load(noWall.tx, noWall.selector, noWall.options), denied);
  const mismatch = fixture(); mismatch.rows.member.membershipId = id(88);
  await assert.rejects(load(mismatch.tx, mismatch.selector, mismatch.options), denied);
});

test('missing source remains unavailable while database faults escape unchanged', async () => {
  const missing = fixture(); delete missing.rows.job;
  await assert.rejects(load(missing.tx, missing.selector, missing.options), denied);

  for (const failedTable of ['sp_draft_job', 'client_objective_workload_delegations']) {
    const f = fixture();
    const originalQuery = f.tx.$queryRaw;
    const fault = Object.assign(new Error(`database failure at ${failedTable}`), { code: 'P2034' });
    f.tx.$queryRaw = async (parts, ...values) => {
      if (parts.join('?').includes(`FROM ${failedTable}`)) throw fault;
      return originalQuery(parts, ...values);
    };
    await assert.rejects(load(f.tx, f.selector, f.options), error => error === fault);
  }
});
