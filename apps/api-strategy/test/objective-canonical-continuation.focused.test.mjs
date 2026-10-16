// Actual continuation + saved-generation + producer codecs. Retained ledger,
// completion witness, SQL/authority, and Planner operation owner ports below are
// synthetic. This suite qualifies source orchestration, not live scheduling,
// native SQL/HTTP, authority/custody or semantic TypeScript compilation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const copy = value => structuredClone(value);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-16T04:00:00.000Z', now = Date.parse(at);
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const custody = [];
async function sourceModule(relative, replacements = []) {
  const path = new URL(relative, import.meta.url), raw = await readFile(path, 'utf8');
  let source = raw;
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, `one declared import rewrite: ${from}`);
    source = source.replace(from, JSON.stringify(to));
  }
  const transformed = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: path.href });
  custody.push({ path: relative, sha256: createHash('sha256').update(raw).digest('hex'),
    transformedSha256: createHash('sha256').update(transformed).digest('hex'),
    replacementSpecifiers: replacements.map(([from]) => from) });
  return data(transformed);
}
const appUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const app = await import(appUrl);
const generationUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
]);
const generation = await import(generationUrl);
const frameworkUrl = data(`export class BadRequestException extends Error{};
  export class ConflictException extends Error{}; export const STRATEGY_TYPES=[];`);
const typesUrl = await sourceModule('../src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", frameworkUrl], ["'../strategy/dto/create-strategy.dto.js'", frameworkUrl],
]);
const producerUrl = await sourceModule('../src/meri/objective-canonical-producer.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-generation.types.js'", typesUrl],
]);
const producer = await import(producerUrl);
const ownerPortsUrl = data(`
  import {CanonicalApplicationError} from ${JSON.stringify(appUrl)};
  export const CORE_CANONICAL_REGENERATION_REQUEST_VERSION='capiro.objective-strategy.regeneration-request/20261016.1';
  export async function generationAssociation(tx){tx.fixture.reads++;return structuredClone(tx.fixture.association);}
  export async function readCanonicalGenerationProducer(tx){return structuredClone(tx.fixture.producer);}
  export async function readGenerationLedger(tx){return structuredClone(tx.fixture.normalization);}
  export async function readCanonicalRequestPublication(tx){return structuredClone(tx.fixture.publication);}
  export function checkCanonicalCompletionWitness(raw){
    if(!raw||!raw.corePayloadSha256)throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
    return structuredClone(raw);
  }
  export const checkCanonicalRegenerationCompletionWitness=()=>{throw Error('Not exercised: regeneration witness owner');};
  export const checkCanonicalRegenerationNormalization=()=>{throw Error('Not exercised: regeneration normalization owner');};
`);
const savedUrl = await sourceModule('../src/meri/objective-canonical-saved-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-completion-receipt.js'", ownerPortsUrl],
  ["'./objective-canonical-regeneration-completion-receipt.js'", ownerPortsUrl],
  ["'./objective-canonical-regeneration-request.js'", ownerPortsUrl],
  ["'./objective-canonical-regeneration-ledger.js'", ownerPortsUrl],
  ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-canonical-producer-ledger.js'", ownerPortsUrl],
  ["'./objective-canonical-request-ledger.js'", ownerPortsUrl],
]);
const savedModule = await import(savedUrl);
const continuationUrl = await sourceModule('../src/planner/objective-canonical-continuation.ts', [
  ["'../meri/objective-canonical-producer.js'", producerUrl],
  ["'../meri/objective-canonical-saved-generation.js'", savedUrl],
  ["'./objective-canonical-application.js'", appUrl],
]);
const continuation = await import(continuationUrl);
const reject = code => error => error instanceof app.CanonicalApplicationError && error.code === code;

function fixture() {
  const canonical = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 4,
    snapshotHash: 'a'.repeat(64) };
  const admission = { schemaVersion: 1, namespace: generation.GENERATION_ADMISSION_NAMESPACE, canonical,
    actorUserId: id(9), clerkUserId: 'user_original', consentId: id(13), controlVersion: 2,
    generationJobId: id(10), generationRequestId: id(11), admittedAtMs: now - 2_000,
    effectExpiresAtMs: now + 60_000, expectedStrategyVersionId: null };
  const binding = { tenantId: id(2), actorId: 'user_original', conversationId: id(20), runId: id(21),
    attemptId: id(22), workerId: id(23), writerFence: 1 };
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: generation.canonicalGenerationAdmissionSha256(admission),
    sourceBinding: binding, sourceRequestSha256: 'e'.repeat(64), acceptedAtMs: now - 1_000,
    issuance: { issuanceKey: generation.generationBindingKey(binding), binding, requestSha256: 'e'.repeat(64),
      expiresAtMs: now + 30_000, grantId: id(24), capabilitySha256: 'f'.repeat(64), factsSha256: 'd'.repeat(64) } };
  const source = { clientId: id(3), objectiveId: id(4), objectiveVersion: 4, objectiveRevisionId: id(8) };
  const receipt = { schemaVersion: 1, requestId: id(11), source,
    context: { reobservedAt: at, state: 'complete', packetId: id(25), compiledAt: at,
      sourceDigest: 'b'.repeat(64), coverageDigest: 'c'.repeat(64), inputDigest: 'd'.repeat(64), issues: [] },
    result: { strategyId: id(5), strategyVersionId: id(12), savedAt: at, sourceDigest: 'b'.repeat(64),
      contextPacketId: id(25), coverageDigest: 'c'.repeat(64), inputDigest: 'd'.repeat(64) }, failure: null };
  const produced = producer.canonicalGenerationProducer({ admission, acceptance, jobId: id(10), requestId: id(11),
    attempt: 2, coreFingerprint: 'e'.repeat(64), receipt, strategyId: id(5), strategyVersionId: id(12), snapshotDigest: 'c'.repeat(64) });
  const s = { association: { admission, acceptance }, producer: produced, reads: 0,
    normalization: { schemaVersion: 1, generationJobId: id(10), generationRequestId: id(11),
      sourceAdmissionSha256: generation.canonicalGenerationAdmissionSha256(admission), sourceAcceptanceSha256: app.applicationHash(acceptance),
      strategyId: id(5), strategyVersionId: id(12), snapshotDigest: produced.snapshotDigest,
      normalizationWitness: { proposedPayloadSha256: 'b'.repeat(64) } },
    publication: { publication: { request: { basis: null } } },
    job: { id: id(10), status: 'completed', input: { canonicalCompletion: { corePayloadSha256: 'b'.repeat(64) } } },
    consent: { workAction: 'objective.plan.prepare', tenantId: id(2), actorUserId: id(9), clerkUserId: 'user_original',
      canonical: copy(canonical), consentId: id(50), controlVersion: 5 },
    scope: { tenantId: id(2), clerkUserId: 'user_original', generationJobId: id(10) },
  };
  s.tx = { fixture: s, spDraftJob: { findFirst: async () => copy(s.job) } };
  return s;
}
async function workFixture() {
  const s = fixture();
  s.saved = await savedModule.readCanonicalSavedGeneration(s.tx, s.scope);
  s.work = continuation.savedGenerationPlannerContinuation(s.saved, s.consent);
  s.request = producer.producerApplication(s.work);
  s.original = { operationId: id(60), attemptId: id(61), runId: id(62), requestFingerprint: 'f'.repeat(64),
    originalDeadlineAt: new Date(now + 15_000).toISOString(), workSha256: app.applicationHash(s.work) };
  const source = { generationJobId: s.request.generationJobId, generationRequestId: s.request.generationRequestId,
    ...s.producer.objectiveReceipt.source, strategyId: s.request.strategyId,
    strategyVersionId: s.request.strategyVersionId, snapshotDigest: s.request.snapshotDigest };
  const ack = { schemaVersion: 1, operation: 'objective.plan.prepare', applicationRequestId: s.work.applicationRequestId,
    requestSha256: app.applicationHash(s.request), canonical: copy(s.work.canonical), actorUserId: s.work.actorUserId,
    consentId: s.work.consentId, controlVersion: s.work.controlVersion, source, objectiveReceiptSha256: s.work.objectiveReceiptSha256,
    ownerReceiptId: id(64), ownerReceiptSha256: 'd'.repeat(64), recordedAt: at, outcome: 'applied',
    projects: [{ groupKey: 'default', projectId: id(6), createdVersion: 1, originalNodeIds: [] }], tasks: [] };
  s.observation = { schemaVersion: 1, applicationRequestId: s.request.applicationRequestId,
    creation: { availability: 'available', ack, sha256: app.applicationHash(ack) },
    current: { requestId: s.request.applicationRequestId, source, status: 'prepared', replayed: true,
      recordedAt: at, observedAt: at, projects: [{ groupKey: 'default', name: 'Human edited project', originalNodeIds: [],
        output: { id: id(6), availability: 'available', createdVersion: 1, currentVersion: 7 } }],
      tasks: [], context: [], edges: [], exclusions: [], issues: [],
      counts: { savedNodes: 0, actionableNodes: 0, contextNodes: 0, archivedNodes: 0, createdProjects: 1, createdTasks: 0 } } };
  s.calls = { reconcile: 0, lookup: 0, prepare: 0 };
  s.known = { state: 'not_started', original: copy(s.original), terminalReceiptId: null, outcome: null };
  s.account = outcome => { s.known = { state: 'accounted', original: copy(s.original), terminalReceiptId: id(63), outcome }; };
  s.owner = {
    reconcile: async (work, original) => {
      s.calls.reconcile++; assert.deepEqual(work, s.work); assert.deepEqual(original, s.original); return copy(s.known);
    },
    lookup: async (request, original) => {
      s.calls.lookup++; assert.deepEqual(request, s.request); assert.deepEqual(original, s.original); return copy(s.observation);
    },
    prepare: async (work, original) => {
      s.calls.prepare++; assert.deepEqual(work, s.work); assert.deepEqual(original, s.original); return copy(s.observation);
    },
  };
  s.run = () => continuation.continueCanonicalPlanner(s.work, s.original, s.owner);
  return s;
}

test('actual saved reader/producer derive the nine-field original application and separate Planner work without browser IDs', async () => {
  const s = fixture(), before = copy({ job: s.job, association: s.association, producer: s.producer });
  const work = await continuation.readCanonicalPlannerContinuation(s.tx, s.scope, s.consent);
  const request = producer.producerApplication(work);
  assert.equal(Object.keys(request).length, 9);
  assert.equal(work.applicationRequestId, app.canonicalApplicationRequestId(s.association.admission.canonical, id(9)));
  assert.equal(work.strategyVersionId, s.producer.objectiveReceipt.result.strategyVersionId);
  assert.equal(work.objectiveReceiptSha256, app.applicationHash(s.producer.objectiveReceipt));
  assert.equal(work.consentId, s.consent.consentId); assert.equal(work.controlVersion, 5);
  assert.notEqual(work.consentId, s.association.admission.consentId);
  assert.deepEqual({ job: s.job, association: s.association, producer: s.producer }, before);
  assert.equal(s.reads, 1);
});

test('corrupt or unfinished saved generation never produces a Planner command', async () => {
  for (const mutate of [s => { s.job.status = 'running'; }, s => { s.publication = null; },
    s => { s.normalization.snapshotDigest = '9'.repeat(64); }, s => { delete s.job.input.canonicalCompletion; },
    s => { s.producer.objectiveReceipt.result = null; }]) {
    const s = fixture(); mutate(s);
    await assert.rejects(() => continuation.readCanonicalPlannerContinuation(s.tx, s.scope, s.consent), reject('OUTCOME_UNCONFIRMED'));
  }
});

test('owner consent must bind the original canonical reservation and native/Clerk actor', async () => {
  for (const field of ['tenantId', 'actorUserId', 'clerkUserId', 'workAction', 'canonical']) {
    const s = fixture(), saved = await savedModule.readCanonicalSavedGeneration(s.tx, s.scope);
    const consent = copy(s.consent); consent[field] = field === 'canonical' ? { ...consent.canonical, bindingVersion: 3 } : id(99);
    assert.throws(() => continuation.savedGenerationPlannerContinuation(saved, consent), reject('REQUEST_CONFLICT'));
  }
});

test('saved receipt/producer substitutions and caller-added output identities are refused', async () => {
  for (const mutate of [s => { s.saved.receipt.objectiveReceiptSha256 = '9'.repeat(64); },
    s => { s.saved.producer.generation.runId = id(99); },
    s => { s.saved.receipt.objectiveReceipt.result.strategyVersionId = id(99); },
    s => { s.consent.strategyVersionId = id(99); }, s => { s.consent.applicationRequestId = id(99); }]) {
    const s = await workFixture(); mutate(s);
    assert.throws(() => continuation.savedGenerationPlannerContinuation(s.saved, s.consent), reject('OUTCOME_UNCONFIRMED'));
  }
});

test('consent accessor is never invoked and invalid Planner consent is not inferred from generation consent', async () => {
  const s = await workFixture(); let reads = 0;
  Object.defineProperty(s.consent, 'consentId', { enumerable: true, get() { reads++; return id(50); } });
  assert.throws(() => continuation.savedGenerationPlannerContinuation(s.saved, s.consent), reject('INPUT_INVALID'));
  assert.equal(reads, 0);
  for (const change of [{ consentId: null }, { controlVersion: 0 }, { consentId: id(50) + '\n' }]) {
    const fresh = await workFixture(); Object.assign(fresh.consent, change);
    assert.throws(() => continuation.savedGenerationPlannerContinuation(fresh.saved, fresh.consent), reject('INPUT_INVALID'));
  }
});

test('positive original-operation not_started causes exactly one existing owner prepare', async () => {
  const s = await workFixture(), before = copy(s.original), result = await s.run();
  assert.equal(result.outcome, 'applied'); assert.equal(result.recovered, false);
  assert.deepEqual(s.calls, { reconcile: 1, lookup: 0, prepare: 1 }); assert.deepEqual(s.original, before);
  assert.notEqual(s.original.runId, s.producer.acceptance.sourceBinding.runId);
});

test('accounted applied recovers original lookup and preserves current human edits without prepare', async () => {
  const s = await workFixture(); s.account('applied'); const result = await s.run();
  assert.equal(result.recovered, true); assert.equal(result.observation.current.projects[0].name, 'Human edited project');
  assert.equal(result.observation.current.projects[0].output.currentVersion, 7);
  assert.deepEqual(s.calls, { reconcile: 1, lookup: 1, prepare: 0 });
});

test('accounted failed/cancelled remains terminal without retry, new run, lookup or prepare', async () => {
  for (const outcome of ['failed', 'cancelled']) {
    const s = await workFixture(); s.account(outcome);
    assert.deepEqual(await s.run(), { outcome, terminalReceiptId: id(63) });
    assert.deepEqual(s.calls, { reconcile: 1, lookup: 0, prepare: 0 });
  }
});

test('uncertain/unavailable/missing or mismatched reconciliation never establishes not_started', async () => {
  for (const mutate of [s => { s.known.state = 'outcome_unconfirmed'; }, s => { s.known = null; },
    s => { s.known.original.runId = id(99); }, s => { s.known.original.attemptId = id(99); },
    s => { s.known.original.operationId = id(99); }, s => { s.known.original.requestFingerprint = '9'.repeat(64); },
    s => { s.known.original.originalDeadlineAt = new Date(now + 90_000).toISOString(); },
    s => { s.known.original.workSha256 = '9'.repeat(64); }, s => { s.known.terminalReceiptId = id(63); },
    s => { s.known.state = 'accounted'; s.known.outcome = 'applied'; }]) {
    const s = await workFixture(); mutate(s);
    await assert.rejects(s.run, error => error instanceof app.CanonicalApplicationError);
    assert.equal(s.calls.prepare, 0); assert.equal(s.calls.lookup, 0);
  }
  const s = await workFixture(); s.known.state = 'unavailable';
  await assert.rejects(s.run, reject('AUTHORITY_UNAVAILABLE')); assert.equal(s.calls.prepare, 0);
});

test('malformed original operation is refused before any owner call or effect', async () => {
  for (const change of [{ runId: id(99) + '\n' }, { workSha256: '9'.repeat(64) },
    { requestFingerprint: 'x'.repeat(64) }, { requestFingerprint: 'f'.repeat(64) + '\n' },
    { originalDeadlineAt: '2026-10-16' }, { operationId: null }]) {
    const s = await workFixture(); Object.assign(s.original, change);
    await assert.rejects(s.run, error => error instanceof app.CanonicalApplicationError);
    assert.deepEqual(s.calls, { reconcile: 0, lookup: 0, prepare: 0 });
  }
});

test('lost committed reply reconciles and recovers the SAME application/original operation without resubmit', async () => {
  const s = await workFixture(), before = copy(s.original);
  s.owner.prepare = async (work, original) => {
    s.calls.prepare++; assert.deepEqual(work, s.work); assert.deepEqual(original, before);
    s.account('applied'); throw Error('Synthetic transport lost committed owner reply');
  };
  const result = await s.run(); assert.equal(result.recovered, true);
  assert.deepEqual(s.calls, { reconcile: 2, lookup: 1, prepare: 1 }); assert.deepEqual(s.original, before);
});

test('ambiguous prepare followed by not_started/uncertain/unavailable never prepares again or guesses success', async () => {
  for (const next of ['not_started', 'outcome_unconfirmed', 'unavailable']) {
    const s = await workFixture();
    s.owner.prepare = async () => { s.calls.prepare++; s.known.state = next; throw Error('Lost reply'); };
    await assert.rejects(s.run, reject(next === 'unavailable' ? 'AUTHORITY_UNAVAILABLE' : 'OUTCOME_UNCONFIRMED'));
    assert.deepEqual(s.calls, { reconcile: 2, lookup: 0, prepare: 1 });
  }
});

test('a lost reply accounted as failed returns the original terminal receipt and stops', async () => {
  const s = await workFixture();
  s.owner.prepare = async () => { s.calls.prepare++; s.account('failed'); throw Error('Lost reply'); };
  assert.deepEqual(await s.run(), { outcome: 'failed', terminalReceiptId: id(63) });
  assert.deepEqual(s.calls, { reconcile: 2, lookup: 0, prepare: 1 });
});

test('wrong or malformed prepare reply is reconciled once by original identity, never adopted or resubmitted', async () => {
  for (const mutate of [o => { o.applicationRequestId = id(99); }, o => { o.current.source.strategyVersionId = id(99); },
    o => { o.creation.ack.consentId = id(99); }, o => { o.creation.ack.controlVersion++; },
    o => { o.creation.sha256 = '9'.repeat(64); }]) {
    const s = await workFixture(), wrong = copy(s.observation); mutate(wrong);
    s.owner.prepare = async () => { s.calls.prepare++; s.account('applied'); return wrong; };
    const result = await s.run(); assert.equal(result.recovered, true); assert.deepEqual(result.observation, s.observation);
    assert.deepEqual(s.calls, { reconcile: 2, lookup: 1, prepare: 1 });
  }
});

test('original lookup must retain exact application/source/consent identity and fresh-read failure remains closed', async () => {
  for (const mutate of [o => { o.current.requestId = id(99); }, o => { o.current.source.objectiveRevisionId = id(99); },
    o => { o.creation.ack.requestSha256 = '9'.repeat(64); }, o => { o.creation.ack.actorUserId = id(99); }]) {
    const s = await workFixture(); s.account('applied'); mutate(s.observation);
    await assert.rejects(s.run, reject('OUTCOME_UNCONFIRMED'));
    assert.deepEqual(s.calls, { reconcile: 1, lookup: 1, prepare: 0 });
  }
  const s = await workFixture(); s.account('applied');
  s.owner.lookup = async () => { s.calls.lookup++; throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); };
  await assert.rejects(s.run, reject('AUTHORITY_UNAVAILABLE')); assert.equal(s.calls.prepare, 0);
});

test('accounted original output redaction remains an owner read and never grants another prepare', async () => {
  const s = await workFixture(); s.account('applied');
  s.observation.creation = { availability: 'unavailable', ack: null, sha256: null };
  s.observation.current.status = 'partial';
  s.observation.current.projects[0].output = { availability: 'unavailable', id: null, createdVersion: 1, currentVersion: null };
  const result = await s.run(); assert.deepEqual(result.observation.creation, s.observation.creation);
  assert.deepEqual(s.calls, { reconcile: 1, lookup: 1, prepare: 0 });
});

test('truncated current result with redacted creation never acknowledges success from prepare or lookup', async () => {
  for (const field of ['status', 'replayed', 'recordedAt', 'observedAt', 'projects', 'tasks', 'context',
    'edges', 'exclusions', 'issues', 'counts']) {
    const s = await workFixture(), wrong = copy(s.observation);
    wrong.creation = { availability: 'unavailable', ack: null, sha256: null }; delete wrong.current[field];
    s.owner.prepare = async () => { s.calls.prepare++; s.account('applied'); return copy(wrong); };
    assert.equal((await s.run()).recovered, true);
    assert.deepEqual(s.calls, { reconcile: 2, lookup: 1, prepare: 1 });
    const read = await workFixture(); read.account('applied'); read.observation = wrong;
    await assert.rejects(read.run, reject('OUTCOME_UNCONFIRMED'));
    assert.deepEqual(read.calls, { reconcile: 1, lookup: 1, prepare: 0 });
  }
});

test('malformed complete current fields and creation records refuse recovery without preparing', async () => {
  for (const mutate of [o => { o.current.status = 'unknown'; }, o => { o.current.observedAt = 'yesterday'; },
    o => { o.current.projects[0].output.currentVersion = 0; }, o => { o.current.counts.createdTasks = -1; },
    o => { o.current.projects[0].output = { availability: 'unavailable', id: null, createdVersion: 1, currentVersion: null }; },
    o => { o.creation = { availability: 'unavailable', ack: null, sha256: null }; },
    o => { o.current.context = [{}]; }, o => { o.current.edges = [{}]; }, o => { o.current.exclusions = [{}]; },
    o => { o.current.issues = [{}]; }, o => { o.current.tasks = [{}]; },
    o => { o.creation.ack.projects[0].createdVersion = 0; o.creation.sha256 = app.applicationHash(o.creation.ack); }]) {
    const s = await workFixture(); s.account('applied'); mutate(s.observation);
    await assert.rejects(s.run, reject('OUTCOME_UNCONFIRMED')); assert.equal(s.calls.prepare, 0);
  }
});

test('caller/port mutation during an await cannot replace pinned work, original run or original deadline', async () => {
  const s = await workFixture(), work = copy(s.work), original = copy(s.original);
  let release; const gate = new Promise(resolve => { release = resolve; });
  s.owner.reconcile = async (seenWork, seenOriginal) => {
    s.calls.reconcile++; seenWork.strategyVersionId = id(99); seenOriginal.originalDeadlineAt = new Date(now + 90_000).toISOString();
    await gate; return { state: 'not_started', original, terminalReceiptId: null, outcome: null };
  };
  s.owner.prepare = async (seenWork, seenOriginal) => {
    s.calls.prepare++; assert.deepEqual(seenWork, work); assert.deepEqual(seenOriginal, original); return copy(s.observation);
  };
  const pending = s.run(); s.work.strategyVersionId = id(99); s.original.runId = id(99); release();
  assert.equal((await pending).outcome, 'applied'); assert.equal(s.calls.prepare, 1);
});

test('expired historical identities are never renewed by reconstruction or accounted retained reads', async () => {
  const s = await workFixture(); s.original.originalDeadlineAt = new Date(now - 1_000).toISOString();
  s.known.original = copy(s.original); s.account('applied');
  const result = await s.run(); assert.equal(result.recovered, true);
  assert.equal(s.original.originalDeadlineAt, new Date(now - 1_000).toISOString()); assert.equal(s.calls.prepare, 0);
});

test('prints exact source custody and explicit synthetic/unmounted limits', () => {
  assert.equal(custody.length, 6);
  console.log(JSON.stringify({ qualification: 'unmounted-server-owned-planner-continuation-source-only', sourceCustody: custody,
    actual: ['readCanonicalSavedGeneration', 'requireSavedGenerationApplication', 'canonicalGenerationProducer',
      'parseCanonicalGenerationAdmission', 'requireGenerationAcceptanceForAdmission', 'validObjectiveOutcome',
      'readCanonicalPlannerContinuation', 'savedGenerationPlannerContinuation', 'continueCanonicalPlanner'],
    synthetic: ['retained ledger/publication and completion witness owner ports', 'SQL and authority',
      'Planner original-operation reconciliation/serialization and application prepare/lookup'],
    liveServerSchedulingNativeDatabaseHttpAuthorityCustodySemanticTypescript: 'UNQUALIFIED', installs: 0, network: false }));
});
