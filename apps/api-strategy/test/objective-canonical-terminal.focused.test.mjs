// Pure actual-source accounting consistency only. Synthetic owner observations
// confer no Meri physical-terminal, DB CAS/absence, current authority or retry
// permission. The separate production service owns all of those boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const sourceCustody = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function sourceModule(path, replacements = []) {
  const url = new URL(path, import.meta.url), raw = await readFile(url, 'utf8');
  let source = raw;
  for (const [from, to] of replacements) {
    const parts = source.split(from); assert.equal(parts.length, 2, `one declared pure dependency: ${from}`);
    source = parts.join(JSON.stringify(to));
  }
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url.href });
  sourceCustody.push({ path, rawSha256: hash(raw), transformedSha256: hash(stripped),
    replacementSpecifiers: replacements.map(([from]) => from) });
  return dataModule(stripped);
}
const nestLabels = dataModule('export class BadRequestException extends Error{}; export class ConflictException extends Error{};');
const enumLabels = dataModule('export const STRATEGY_TYPES=["appropriations","authorization","regulatory","coalition","procurement","earmark","amendment"];');
const applicationUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const generationUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl],
]);
const objectiveTypesUrl = await sourceModule('../src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", nestLabels], ["'../strategy/dto/create-strategy.dto.js'", enumLabels],
]);
const terminalUrl = await sourceModule('../src/meri/objective-canonical-terminal.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-generation.types.js'", objectiveTypesUrl],
]);
const { applicationHash, CanonicalApplicationError } = await import(applicationUrl);
const generation = await import(generationUrl);
const { SAFE_FAILURES, validObjectiveOutcome, publicObjectiveReceipt } = await import(objectiveTypesUrl);
const { prepareCanonicalTerminal: prepare, checkCanonicalTerminal: check } = await import(terminalUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = c => c.repeat(64);
const copy = value => structuredClone(value);
const json = value => JSON.parse(JSON.stringify(value));
const refuses = run => assert.throws(run, e => e instanceof CanonicalApplicationError);

function fixture(outcome = 'needs-information') {
  const canonical = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 4, snapshotHash: hex('a') };
  const admission = { schemaVersion: 1, namespace: generation.GENERATION_ADMISSION_NAMESPACE, canonical,
    actorUserId: id(9), clerkUserId: 'original_clerk_fixture', consentId: id(12), controlVersion: 3,
    generationJobId: id(10), generationRequestId: id(11), admittedAtMs: 1000, effectExpiresAtMs: 2000,
    expectedStrategyVersionId: null };
  const binding = { tenantId: id(2), actorId: admission.clerkUserId, conversationId: id(20), runId: id(21),
    attemptId: id(22), workerId: id(23), writerFence: 2 };
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: generation.canonicalGenerationAdmissionSha256(admission),
    sourceBinding: binding, sourceRequestSha256: hex('b'), acceptedAtMs: 1100,
    issuance: { issuanceKey: applicationHash(binding), binding, requestSha256: hex('b'), expiresAtMs: 1900,
      grantId: id(24), capabilitySha256: hex('c'), factsSha256: hex('d') } };
  const request = { requestId: admission.generationRequestId, clientId: canonical.clientId,
    objective: { objectiveId: canonical.objectiveId, objectiveVersion: canonical.requestedObjectiveVersion }, type: 'authorization' };
  const job = { id: admission.generationJobId, tenantId: canonical.tenantId, clientId: canonical.clientId,
    ownerUserId: admission.clerkUserId, status: 'running', stage: 'drafting', errorMessage: null, strategyId: null,
    claimedBy: `canonical:${acceptance.issuance.issuanceKey}`, attempt: 2,
    // Expired ORM metadata must not be serialized/renewed by terminal accounting.
    deadlineAt: new Date(2000), createdAt: new Date(900),
    input: { dto: { clientId: canonical.clientId, type: request.type, goal: ' Original goal\n',
      meriContext: ' Private context ', ownerUserId: null, targetDate: null, attachmentIds: [] }, bearer: null,
    canonicalGeneration: { admissionId: generation.generationLedgerId(generation.GENERATION_ADMISSION,
      canonical.tenantId, admission.clerkUserId, admission.generationJobId) },
    objectiveGeneration: { request, fingerprint: applicationHash(request),
      receipt: { schemaVersion: 1, requestId: admission.generationRequestId,
        source: { clientId: canonical.clientId, objectiveId: canonical.objectiveId,
          objectiveVersion: canonical.requestedObjectiveVersion, objectiveRevisionId: canonical.requestedObjectiveRevisionId },
        context: { state: 'complete', packetId: id(30), compiledAt: new Date(1050).toISOString(),
          sourceDigest: hex('1'), coverageDigest: hex('2'), inputDigest: hex('3'), issues: [], reobservedAt: null },
        result: null, failure: null }, localDigest: hex('4'), externalDigest: hex('5'), historyDigest: hex('6'),
      historyObservedAt: new Date(1020).toISOString(), coverage: [{ group: 'original-private', state: 'available' }], contactIds: [id(31)] } } };
  const options = { admission, acceptance, publicationSha256: hex('e'), outcome,
    // An opaque controlled OWNER value; not an invented external terminal DTO.
    evidence: { controlledOwnerObservation: outcome, originalReference: 'opaque-original-reference', confidence: 0.75 }, recordedAtMs: 5000 };
  return { job, options };
}
const historical = f => ({ admission: f.options.admission, acceptance: f.options.acceptance, publicationSha256: f.options.publicationSha256 });
function replay(f, prepared = prepare(f.job, f.options)) {
  return { ...f.job, status: 'failed', stage: 'failed', errorMessage: prepared.errorMessage, input: json(prepared.input) };
}

test('source custody binds four actual modules; only framework/enum labels are stubbed', t => {
  assert.equal(sourceCustody.length, 4); assert.deepEqual(sourceCustody.map(x => x.replacementSpecifiers.length), [0, 1, 2, 3]);
  t.diagnostic(JSON.stringify({ sourceCustody }));
});
for (const outcome of ['needs-information', 'refused', 'failed', 'cancelled']) {
  test(`private ${outcome} keeps its original distinction under the unchanged safe failed projection`, () => {
    const f = fixture(outcome), before = copy(f.job), p = prepare(f.job, f.options);
    assert.deepEqual(f.job, before); assert.equal(p.record.outcome, outcome);
    assert.equal(p.errorMessage, SAFE_FAILURES.OBJECTIVE_GENERATION_FAILED);
    assert.deepEqual(json(p.input.objectiveGeneration.receipt.failure), {
      code: 'OBJECTIVE_GENERATION_FAILED', message: SAFE_FAILURES.OBJECTIVE_GENERATION_FAILED });
    assert.equal(validObjectiveOutcome(p.input.objectiveGeneration.receipt, 'failed', null, p.errorMessage), true);
    const visible = publicObjectiveReceipt(p.input.objectiveGeneration.receipt);
    assert.equal(Object.hasOwn(visible, 'canonicalTerminal'), false);
    assert.equal(JSON.stringify(visible).includes('opaque-original-reference'), false);
    assert.deepEqual(check(replay(f, p), historical(f)), p.record);
  });
}
test('only the private record and failure projection change; every original source/context/DTO literal remains', () => {
  const f = fixture(), p = prepare(f.job, f.options), expected = copy(f.job.input);
  expected.objectiveGeneration.receipt.failure = json(p.input.objectiveGeneration.receipt.failure);
  const actual = json(p.input); delete actual.canonicalTerminal;
  assert.deepEqual(actual, expected); assert.equal(p.input.objectiveGeneration.receipt.result, null);
  assert.equal(p.input.objectiveGeneration.receipt.context.reobservedAt, null);
  assert.equal(Object.isFrozen(p.record), true); assert.equal(Object.isFrozen(p.record.evidence), true);
});
test('late recorded time after original issuance/effect/job deadlines is retained, never renewed', () => {
  const f = fixture(), p = prepare(f.job, f.options);
  assert.ok(p.record.recordedAtMs > f.options.admission.effectExpiresAtMs);
  assert.ok(p.record.recordedAtMs > f.options.acceptance.issuance.expiresAtMs);
  assert.equal(f.job.deadlineAt.getTime(), 2000); assert.equal(p.record.recordedAtMs, 5000);
  assert.equal(check(replay(f, p), historical(f)).recordedAtMs, 5000);
});
test('record hashes exact evidence and whole body excluding only recordSha256', () => {
  const f = fixture(), p = prepare(f.job, f.options), { recordSha256, ...body } = p.record;
  assert.equal(p.record.evidenceSha256, applicationHash(f.options.evidence));
  assert.equal(recordSha256, applicationHash(body)); assert.notEqual(recordSha256, applicationHash(p.record));
  assert.notEqual(p.record.sourceAdmissionSha256, p.record.sourceAcceptanceSha256);
});
test('same original operation cannot remint a new accounting ID by changing outcome/evidence/time', () => {
  const a = fixture('failed'), b = fixture('cancelled'); b.options.evidence.other = true; b.options.recordedAtMs++;
  const first = prepare(a.job, a.options), second = prepare(b.job, b.options);
  assert.equal(first.record.id, second.record.id); assert.notEqual(first.record.recordSha256, second.record.recordSha256);
  // The production CAS, not this pure preparation function, picks the single
  // genuine owner-proved outcome and rejects any conflicting subsequent one.
});
for (const field of ['id', 'tenantId', 'clientId', 'ownerUserId', 'claimedBy', 'attempt']) {
  test(`original owner ${field} cannot be substituted`, () => {
    const f = fixture(); f.job[field] = field === 'attempt' ? 3 : field === 'ownerUserId' ? 'other-clerk' : id(99);
    refuses(() => prepare(f.job, f.options));
  });
}
for (const mutate of [
  f => { f.job.status = 'queued'; }, f => { f.job.status = 'completed'; }, f => { f.job.status = 'failed'; },
  f => { f.job.strategyId = id(80); }, f => { f.job.input.objectiveGeneration.receipt.result = { strategyId: id(80) }; },
  f => { f.job.input.canonicalCompletion = null; }, f => { f.job.input.canonicalTerminal = null; },
  f => { f.job.input.objectiveGeneration.receipt.failure = { code: 'OBJECTIVE_GENERATION_FAILED', message: SAFE_FAILURES.OBJECTIVE_GENERATION_FAILED }; },
  f => { f.job.errorMessage = SAFE_FAILURES.OBJECTIVE_GENERATION_FAILED; },
]) {
  test('success/other terminal state cannot be overwritten or reclassified through preparation', () => {
    const f = fixture(); mutate(f); const before = copy(f.job);
    refuses(() => prepare(f.job, f.options)); assert.deepEqual(f.job, before);
  });
}
for (const mutate of [
  f => { f.job.input.canonicalGeneration.admissionId = id(99); },
  f => { f.job.input.objectiveGeneration.fingerprint = hex('9'); },
  f => { const e = f.job.input.objectiveGeneration; e.request.requestId = id(99); e.fingerprint = applicationHash(e.request); },
  f => { f.job.input.objectiveGeneration.receipt.source.objectiveRevisionId = id(99); },
  f => { f.job.input.objectiveGeneration.receipt.source.objectiveVersion++; },
  f => { f.job.input.dto.type = 'coalition'; }, f => { f.job.input.bearer = 'not-a-permitted-source'; },
  f => { f.job.input.objectiveGeneration.receipt.context.reobservedAt = new Date(1200).toISOString(); },
]) {
  test('marker/request/fingerprint/source/context must remain the exact original owner inputs', () => {
    const f = fixture(); mutate(f); refuses(() => prepare(f.job, f.options));
  });
}
test('opaque unrelated ORM columns are never read, evaluated, hashed or changed', () => {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.job, 'unrelated', { get() { calls++; throw Error('never read'); } });
  prepare(f.job, f.options); assert.equal(calls, 0);
});
test('recorded time must be a safe finite nonnegative millisecond at/after original acceptance', () => {
  for (const value of [0, 1099, -1, NaN, Infinity, 1100.5, Number.MAX_SAFE_INTEGER + 1, '5000']) {
    const f = fixture(); f.options.recordedAtMs = value; refuses(() => prepare(f.job, f.options));
  }
  const f = fixture(); f.options.recordedAtMs = 1100; assert.equal(prepare(f.job, f.options).record.recordedAtMs, 1100);
});
test('unknown private outcome and malformed publication digest refuse without inventing a public code', () => {
  for (const value of ['succeeded', 'unknown', 'expired', null, ['failed']]) {
    const f = fixture(); f.options.outcome = value; refuses(() => prepare(f.job, f.options));
  }
  const f = fixture(); f.options.publicationSha256 = 'invalid'; refuses(() => prepare(f.job, f.options));
});
test('stored replay detects evidence/body/identity/time drift while retaining the original recorded timestamp', () => {
  const f = fixture(), p = prepare(f.job, f.options);
  for (const mutate of [
    r => { r.id = id(99); }, r => { r.generationJobId = id(99); }, r => { r.generationRequestId = id(99); },
    r => { r.tenantId = id(99); }, r => { r.claimToken = 'new-claim'; }, r => { r.attempt = 3; },
    r => { r.evidence.originalReference = 'changed'; }, r => { r.evidenceSha256 = hex('9'); },
    r => { r.recordSha256 = hex('9'); }, r => { r.recordedAtMs++; }, r => { r.publicationSha256 = hex('9'); },
  ]) {
    const j = replay(f, p); mutate(j.input.canonicalTerminal); refuses(() => check(j, historical(f)));
  }
  const later = historical(f); later.publicationSha256 = hex('8'); refuses(() => check(replay(f, p), later));
});
for (const mutate of [
  j => { j.status = 'running'; }, j => { j.stage = 'drafting'; }, j => { j.errorMessage = 'raw provider error'; },
  j => { j.claimedBy = 'reclaimed-worker'; }, j => { j.strategyId = id(99); },
  j => { j.input.canonicalCompletion = {}; }, j => { delete j.input.canonicalTerminal; },
  j => { j.input.objectiveGeneration.receipt.failure.message = 'changed safe copy'; },
  j => { j.input.objectiveGeneration.receipt.failure.code = 'OBJECTIVE_GENERATION_OUTCOME_UNCONFIRMED'; },
]) {
  test('a failed row alone is not a verified replay or proof of no Strategy output', () => {
    const f = fixture(), j = replay(f); mutate(j); refuses(() => check(j, historical(f)));
  });
}
test('unknown closed record/options fields refuse rather than silently changing private accounting', () => {
  const f = fixture(), j = replay(f); j.input.canonicalTerminal.extra = true; refuses(() => check(j, historical(f)));
  const g = fixture(); g.options.extra = true; refuses(() => prepare(g.job, g.options));
});
test('getters/proxies/cycles/custom prototypes/sparse arrays/nonfinite evidence never execute or serialize', () => {
  let calls = 0;
  const f = fixture(); Object.defineProperty(f.job, 'input', { enumerable: true, get() { calls++; throw Error(); } });
  refuses(() => prepare(f.job, f.options));
  const g = fixture(); g.options.evidence = new Proxy({}, { ownKeys() { calls++; throw Error(); } });
  refuses(() => prepare(g.job, g.options));
  for (const value of [new Array(1), new Date(0), { toJSON() { calls++; throw Error(); } }, { n: Infinity }, { n: NaN }]) {
    const h = fixture(); h.options.evidence = value; refuses(() => prepare(h.job, h.options));
  }
  const h = fixture(); h.options.evidence.self = h.options.evidence; refuses(() => prepare(h.job, h.options));
  assert.equal(calls, 0);
});
test('evidence 2 MiB byte cap refuses excess without slicing and permits exact-limit replay', () => {
  const f = fixture(); f.options.evidence = { data: 'x'.repeat(2_097_152) }; refuses(() => prepare(f.job, f.options));
  const g = fixture(); g.options.evidence = { data: 'x'.repeat(2_097_152 - 11) };
  const p = prepare(g.job, g.options); assert.equal(Buffer.byteLength(JSON.stringify(p.record.evidence)), 2_097_152);
  assert.equal(check(replay(g, p), historical(g)).evidenceSha256, p.record.evidenceSha256);
});
