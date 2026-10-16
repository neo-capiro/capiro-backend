// Pure owner-input projection cases. No Nest, DB, provider, children or hooks.
// Hash equality does not prove custody of the actual row or Meri acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
const custody = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const asModule = value => `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;
async function moduleSource(path, replacements = []) {
  const url = new URL(path, import.meta.url), original = await readFile(url, 'utf8');
  let source = original;
  for (const [from, to] of replacements) {
    const parts = source.split(from); assert.equal(parts.length, 2, `one declared dependency ${from}`); source = parts.join(to);
  }
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url.href });
  custody.push({ path, sha256: sha(original), replacementSpecifiers: replacements.map(([from]) => from), transformedSha256: sha(stripped) });
  return asModule(stripped);
}
const appUrl = await moduleSource('../src/planner/objective-canonical-application.ts');
const generationUrl = await moduleSource('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(appUrl)],
]);
const inputUrl = await moduleSource('../src/meri/objective-canonical-job-input.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(appUrl)],
  ["'./objective-canonical-generation.js'", JSON.stringify(generationUrl)],
]);
const { applicationHash } = await import(appUrl);
const { GENERATION_ADMISSION, GENERATION_ADMISSION_NAMESPACE, generationLedgerId } = await import(generationUrl);
const { deriveCanonicalJobInput } = await import(inputUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hash = c => c.repeat(64);
const clone = x => structuredClone(x);
const refuses = run => assert.throws(run, e => ['INPUT_INVALID', 'REQUEST_CONFLICT', 'OUTCOME_UNCONFIRMED'].includes(e.code));
function fixture() {
  const admission = { schemaVersion: 1, namespace: GENERATION_ADMISSION_NAMESPACE,
    canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
      canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
      requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 4, snapshotHash: hash('a') },
    actorUserId: id(9), clerkUserId: 'user_fixture', consentId: id(12), controlVersion: 3,
    generationJobId: id(10), generationRequestId: id(11), admittedAtMs: 1_000_000,
    effectExpiresAtMs: 1_020_000, expectedStrategyVersionId: null };
  const request = { requestId: id(11), clientId: id(3), objective: { objectiveId: id(4), objectiveVersion: 4 }, type: 'appropriations' };
  const envelope = { request, fingerprint: applicationHash(request),
    receipt: { schemaVersion: 1, requestId: id(11),
      source: { clientId: id(3), objectiveId: id(4), objectiveVersion: 4, objectiveRevisionId: id(8) },
      context: { reobservedAt: null, state: 'complete', packetId: id(20), compiledAt: '2026-10-16T04:00:00Z',
        sourceDigest: hash('b'), coverageDigest: hash('c'), inputDigest: hash('d'), issues: [] }, result: null, failure: null },
    localDigest: hash('e'), externalDigest: hash('f'), historyDigest: hash('1'), historyObservedAt: '2026-10-16T04:00:00Z',
    coverage: [{ group: 'relationship_history', status: 'complete' }], contactIds: ['member-1', 'staff-2'] };
  const claim = `canonical:${hash('2')}`;
  const job = { tenantId: id(2), id: id(10), ownerUserId: 'user_fixture', clientId: id(3),
    status: 'running', attempt: 2, claimedBy: claim, strategyId: null,
    requestKey: `objective-v1:${applicationHash([id(2), 'user_fixture', id(11)])}`,
    input: { bearer: null, dto: { clientId: id(3), type: 'appropriations', goal: ' Literal actual goal ',
      meriContext: ' Original context ', ownerUserId: 'user_actual_owner', targetDate: '2028-02-29',
      attachmentIds: ['attachment-b', 'attachment-a', 'attachment-b'] }, objectiveGeneration: envelope,
      canonicalGeneration: { admissionId: generationLedgerId(GENERATION_ADMISSION, id(2), 'user_fixture', id(10)) } },
    createdAt: new Date('2026-10-16T03:59:59Z') };
  return { job, admission, runtime: clone(envelope), claim };
}
const derive = x => deriveCanonicalJobInput(x.job, x.admission, x.runtime, x.claim);

test('custody pins three actual sources with only declared static import rewrites', t => {
  assert.equal(custody.length, 3); assert.deepEqual(custody.map(x => x.replacementSpecifiers.length), [0, 1, 2]);
  t.diagnostic(JSON.stringify({ sourceCustody: custody }));
});
test('DTO and envelope derive from actual row, retain literal fields/order and omit bearer/wider owner row', () => {
  const x = fixture(), result = derive(x);
  assert.deepEqual(result.dto, x.job.input.dto); assert.deepEqual(result.envelope, x.job.input.objectiveGeneration);
  assert.deepEqual(result.dto.attachmentIds, ['attachment-b', 'attachment-a', 'attachment-b']);
  assert.equal(result.dto.goal, ' Literal actual goal ');
  assert.equal(Object.hasOwn(result, 'bearer'), false); assert.equal(Object.hasOwn(result, 'createdAt'), false);
  assert.equal(result.dtoHash, applicationHash(result.dto));
  assert.equal(result.requestHash, applicationHash(result.envelope.request));
  assert.equal(result.sourceHash, applicationHash(result.envelope.receipt.source));
  assert.equal(result.markerHash, applicationHash(x.job.input.canonicalGeneration));
  assert.equal(result.inputHash, applicationHash({ dto: result.dto, request: result.envelope.request,
    fingerprint: result.envelope.fingerprint, source: result.envelope.receipt.source, canonicalGeneration: x.job.input.canonicalGeneration }));
});
test('all current job scope/lifecycle and exact accepted claim must match', () => {
  for (const [key, value] of [['tenantId', id(99)], ['id', id(99)], ['clientId', id(99)], ['ownerUserId', 'user_other'],
    ['status', 'queued'], ['status', 'completed'], ['attempt', 1], ['attempt', 3], ['strategyId', id(5)],
    ['claimedBy', `canonical:${hash('3')}`], ['claimedBy', 'legacy-worker'], ['claimedBy', null], ['requestKey', 'other']]) {
    const x = fixture(); x.job[key] = value; refuses(() => derive(x));
  }
  for (const value of ['', `canonical:${hash('2')}\n`, `canonical:${hash('A')}`, 'worker']) {
    const x = fixture(); x.claim = value; refuses(() => derive(x));
  }
});
test('canonical marker must have exactly its actual deterministic admission ledger identity', () => {
  for (const mutate of [i => { delete i.canonicalGeneration; }, i => { i.canonicalGeneration.admissionId = id(99); },
    i => { i.canonicalGeneration.extra = true; }, i => { i.other = true; }]) {
    const x = fixture(); mutate(x.job.input); refuses(() => derive(x));
  }
});
test('stored request/fingerprint/requestKey and original source identity are all pinned', () => {
  for (const mutate of [e => { e.fingerprint = hash('4'); }, e => { e.request.requestId = id(99); },
    e => { e.request.clientId = id(99); }, e => { e.request.objective.objectiveId = id(99); },
    e => { e.request.objective.objectiveVersion++; }, e => { e.receipt.requestId = id(99); },
    e => { e.receipt.source.objectiveRevisionId = id(99); }, e => { e.receipt.source.clientId = id(99); },
    e => { e.receipt.source.objectiveVersion++; }, e => { e.receipt.source.objectiveId = id(99); }]) {
    const x = fixture(); mutate(x.job.input.objectiveGeneration); x.runtime = clone(x.job.input.objectiveGeneration); refuses(() => derive(x));
  }
});
test('actual DTO type/client cannot disagree with actual request/job scope', () => {
  for (const [key, value] of [['type', 'authorization'], ['type', 'meri_propose'], ['clientId', id(99)]]) {
    const x = fixture(); x.job.input.dto[key] = value; refuses(() => derive(x));
  }
});
test('valid goal/owner/attachment mutations change immutable hashes for pre-read versus locked-tx comparison', () => {
  for (const mutate of [d => { d.goal = 'Different actual goal'; }, d => { d.ownerUserId = 'user_different_owner'; },
    d => { d.attachmentIds.sort(); }, d => { d.attachmentIds.push('new-attachment'); },
    d => { d.meriContext = 'Different context'; }, d => { d.targetDate = '2028-03-01'; }]) {
    const x = fixture(), before = derive(x); mutate(x.job.input.dto); const after = derive(x);
    assert.notEqual(after.dtoHash, before.dtoHash); assert.notEqual(after.inputHash, before.inputHash);
    assert.equal(after.requestHash, before.requestHash);
    // Admission contains no original DTO hash. The real accepted-request owner
    // and caller's locked comparison supply that temporal/custody boundary.
  }
});
test('DTO bounds are defended with literal optional/null/absent distinctions', () => {
  for (const mutate of [d => { d.goal = 'x'.repeat(4001); }, d => { d.meriContext = 'x'.repeat(8001); },
    d => { d.ownerUserId = 'x'.repeat(121); }, d => { d.targetDate = '2027-02-29'; },
    d => { d.attachmentIds = Array(11).fill('a'); }, d => { d.attachmentIds = ['x'.repeat(201)]; },
    d => { d.attachmentIds = [null]; }, d => { d.unknown = true; }]) {
    const x = fixture(); mutate(x.job.input.dto); refuses(() => derive(x));
  }
  const x = fixture(); x.job.input.dto.goal = null; delete x.job.input.dto.meriContext; x.job.input.dto.attachmentIds = null;
  const result = derive(x); assert.equal(result.dto.goal, null); assert.equal(result.dto.attachmentIds, null);
  assert.equal(Object.hasOwn(result.dto, 'meriContext'), false);
});
test('full runtime compiled envelope must match, including source/receipt/context/coverage/contacts/digests', () => {
  for (const mutate of [e => { e.receipt.context.sourceDigest = hash('3'); },
    e => { e.receipt.context.packetId = id(99); }, e => { e.receipt.context.compiledAt = '2026-10-16T04:00:01Z'; },
    e => { e.localDigest = hash('3'); }, e => { e.externalDigest = hash('3'); }, e => { e.historyDigest = hash('3'); },
    e => { e.historyObservedAt = '2026-10-16T04:00:01Z'; }, e => { e.coverage[0].status = 'different'; },
    e => { e.contactIds.push('extra'); }, e => { e.request.type = 'authorization'; e.fingerprint = applicationHash(e.request); }]) {
    const x = fixture(); mutate(x.runtime); refuses(() => derive(x));
  }
});
test('only real as-of historyCheckedAt may differ; it is timestamp-validated and excluded from hash comparison', () => {
  const x = fixture(), before = derive(x);
  x.runtime.historyCheckedAt = '2026-10-16T04:00:05Z';
  const after = derive(x); assert.equal(after.envelopeHash, before.envelopeHash); assert.equal(after.inputHash, before.inputHash);
  assert.equal(Object.hasOwn(after.envelope, 'historyCheckedAt'), false);
  x.job.input.objectiveGeneration.historyCheckedAt = '2026-10-16T04:00:04Z';
  assert.equal(derive(x).envelope.historyCheckedAt, '2026-10-16T04:00:04Z');
  x.runtime.historyCheckedAt = 'not-a-date'; refuses(() => derive(x));
});
test('changed valid compiled context is visible in envelopeHash while immutable inputHash remains stable', () => {
  const x = fixture(), before = derive(x);
  x.job.input.objectiveGeneration.receipt.context.coverageDigest = hash('5');
  x.runtime = clone(x.job.input.objectiveGeneration);
  const after = derive(x); assert.notEqual(after.envelopeHash, before.envelopeHash); assert.equal(after.inputHash, before.inputHash);
});
test('pending and incomplete contexts retain the existing Objective outcome state rules', () => {
  const x = fixture(), c = x.job.input.objectiveGeneration.receipt.context;
  Object.assign(c, { state: 'pending', packetId: null, compiledAt: null, sourceDigest: null, coverageDigest: null, inputDigest: null });
  x.runtime = clone(x.job.input.objectiveGeneration); assert.equal(derive(x).envelope.receipt.context.state, 'pending');
  c.state = 'incomplete'; c.issues = [{ group: 'government_targets', code: 'REQUIRED_CONTEXT_UNAVAILABLE', message: 'Unavailable.' }];
  x.runtime = clone(x.job.input.objectiveGeneration); assert.equal(derive(x).envelope.receipt.context.state, 'incomplete');
  c.issues = []; x.runtime = clone(x.job.input.objectiveGeneration); refuses(() => derive(x));
});
test('inconsistent running receipts or unknown envelope/context fields refuse rather than project away', () => {
  for (const mutate of [e => { e.receipt.result = { strategyId: id(5) }; }, e => { e.receipt.failure = { code: 'failed', message: 'failed' }; },
    e => { e.receipt.context.reobservedAt = '2026-10-16T04:00:01Z'; }, e => { e.receipt.context.state = 'unknown'; },
    e => { e.receipt.context.extra = true; }, e => { e.extra = true; }, e => { e.receipt.source.extra = true; },
    e => { e.request.extra = true; }, e => { e.receipt.context.sourceDigest += '\n'; }]) {
    const x = fixture(); mutate(x.job.input.objectiveGeneration); x.runtime = clone(x.job.input.objectiveGeneration); refuses(() => derive(x));
  }
});
test('bearer-bearing input is refused with a safe code and no returned secret/config fields', () => {
  const x = fixture(); x.job.input.bearer = 'synthetic-not-a-real-token';
  assert.throws(() => derive(x), e => e.code === 'OUTCOME_UNCONFIRMED' && !e.message.includes('synthetic'));
});
test('UUID/digest full match and safe reflection reject newline/proxy/accessor/sparse inputs', () => {
  for (const mutate of [x => { x.job.id += '\n'; }, x => { x.job.input.dto.clientId += '\n'; },
    x => { x.job.input.objectiveGeneration.fingerprint += '\n'; },
    x => { x.job.input.dto.attachmentIds = new Array(1); },
    x => { Object.defineProperty(x.job.input.dto, 'goal', { enumerable: true, get() { throw Error('must not invoke'); } }); },
    x => { Object.defineProperty(x.job, 'claimedBy', { get() { throw Error('must not invoke'); } }); },
    x => { x.runtime = new Proxy(x.runtime, { ownKeys() { throw Error('must not invoke'); } }); }]) {
    const x = fixture(); mutate(x); refuses(() => derive(x));
  }
});
test('derived values are deep frozen and detached from later owner/runtime mutation', () => {
  const x = fixture(), result = derive(x);
  x.job.input.dto.goal = 'Changed'; x.job.input.objectiveGeneration.coverage[0].status = 'Changed';
  x.runtime.contactIds.push('Changed');
  assert.equal(result.dto.goal, ' Literal actual goal '); assert.equal(result.envelope.coverage[0].status, 'complete');
  assert.deepEqual(result.envelope.contactIds, ['member-1', 'staff-2']);
  for (const value of [result, result.dto, result.dto.attachmentIds, result.envelope, result.envelope.request,
    result.envelope.request.objective, result.envelope.receipt, result.envelope.receipt.context,
    result.envelope.receipt.context.issues, result.envelope.coverage, result.envelope.coverage[0], result.envelope.contactIds]) assert.ok(Object.isFrozen(value));
});
