// Actual saved-generation helper + application service + receiving kernel.
// All DB/current-authority/Planner owner ports remain explicitly synthetic.
// This qualifies source orchestration only, not native SQL, HTTP, custody,
// semantic TypeScript, owner materialization algorithms or live authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const copy = value => structuredClone(value);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-16T04:00:00.000Z';
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const custody = [];
async function sourceModule(relative, replacements = [], injectable = false, mode = 'strip') {
  const path = new URL(relative, import.meta.url), raw = await readFile(path, 'utf8');
  let source = raw;
  if (injectable) {
    assert.equal(source.split('@Injectable()').length, 2);
    source = source.replace('@Injectable()', '');
  }
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, `one declared import rewrite: ${from}`);
    source = source.replace(from, JSON.stringify(to));
  }
  const transformed = stripTypeScriptTypes(source, { mode, sourceUrl: path.href });
  custody.push({ path: relative, sha256: createHash('sha256').update(raw).digest('hex'),
    transformedSha256: createHash('sha256').update(transformed).digest('hex'), mode,
    replacementSpecifiers: replacements.map(([from]) => from), removedDecorator: injectable ? '@Injectable()' : null });
  return data(transformed);
}
const appUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const app = await import(appUrl);
const nestUrl = data(`export const Injectable=()=>value=>value;
  export class HttpException extends Error {
    constructor(response,status){super(response.code);this.response=response;this.status=status;}
    getResponse(){return this.response;} getStatus(){return this.status;}
  }`);
const portsUrl = data(`
  import assert from 'node:assert/strict';
  import {applicationHash,applicationReceiptId,CanonicalApplicationError} from ${JSON.stringify(appUrl)};
  export class PrismaService{};
  export class PlannerService{};
  export class ObjectiveCanonicalWorkloadAuthority{};
  export const GENERATION_ADMISSION='synthetic-admission',GENERATION_ACCEPTANCE='synthetic-acceptance',GENERATION_PRODUCER='synthetic-producer';
  export const GENERATION_NORMALIZATION='synthetic-normalization';
  export const canonicalGenerationAdmissionSha256=applicationHash;
  export const CORE_CANONICAL_REGENERATION_REQUEST_VERSION='capiro.objective-strategy.regeneration-request/20261016.1';
  export const generationLedgerId=()=>{throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');};
  export const checkCanonicalRegenerationCompletionWitness=()=>{throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');};
  export const checkCanonicalRegenerationNormalization=()=>{throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');};
  const unused=()=>{throw Error('Unexercised capture/acceptance port must not run');};
  export const parseCanonicalGenerationAdmission=unused,requireGenerationAcceptanceForAdmission=unused;
  export const admitCanonicalGenerationWithinTx=unused,requireCanonicalGenerationEffectWithinTx=unused;
  export const generationMarker=unused,insertGenerationLedger=unused,candidateJcsSha256=unused,validObjectiveOutcome=unused;
  // Only this owner's ID function is a synthetic dependency; the actual Core
  // receiving kernel independently checks the resulting UUID and whole owner.
  export const canonicalMaterializationReceiptId=(tenant,actor,request)=>applicationReceiptId(tenant,actor,'synthetic-owner:'+request);
  const fail=(code='OUTCOME_UNCONFIRMED')=>{throw new CanonicalApplicationError(code);};
  const clone=value=>structuredClone(value);
  function original(tx,tenant,clerk,job){
    const s=tx.fixture;
    if(s.forbidSavedReads)throw Error('Historical replay must bypass saved-generation reader');
    assert.equal(tenant,s.a.canonical.tenantId);assert.equal(clerk,s.a.clerkUserId);assert.equal(job,s.job.id);
    return s;
  }
  export async function generationAssociation(tx,tenant,clerk,job){
    const s=original(tx,tenant,clerk,job);s.calls.association++;return clone(s.association);
  }
  export async function readCanonicalRequestPublication(tx,a){
    const s=original(tx,a.canonical.tenantId,a.clerkUserId,a.generationJobId);s.calls.publication++;
    return s.publicationMissing?null:clone(s.publication);
  }
  export async function readCanonicalGenerationProducer(tx,tenant,clerk,job){
    const s=original(tx,tenant,clerk,job);s.calls.producer++;return clone(s.producer);
  }
  export async function readGenerationLedger(tx,kind,tenant,clerk,job){
    const s=original(tx,tenant,clerk,job);assert.equal(kind,GENERATION_NORMALIZATION);
    s.calls.normalization++;return clone(s.normalization);
  }
  export function checkCanonicalCompletionWitness(value,expected){
    if(value?.syntheticDecoderCode)fail(value.syntheticDecoderCode);
    if(!value||value.syntheticValid!==true)fail();
    assert.equal(value.generationJobId,expected.admission.generationJobId);
    assert.equal(value.generationRequestId,expected.admission.generationRequestId);
    return clone(value);
  }
  export async function requireCanonicalApplicationFence(tx,grant,request){
    const s=tx.fixture;s.calls.effectFence++;assert.equal(s.depth,1);
    assert.equal(grant.consentId,s.grant.consentId);assert.deepEqual(request,s.allowedRequest);
    if(s.staleObjective)fail('SOURCE_STALE');
    if(s.effectUnavailable)fail('AUTHORITY_UNAVAILABLE');
  }
  export async function requireCanonicalApplicationRead(tx,grant,canonical){
    const s=tx.fixture;s.calls.readFence++;assert.equal(s.depth,1);
    assert.equal(grant.actorUserId,s.a.actorUserId);assert.deepEqual(canonical,s.a.canonical);
    if(s.readUnavailable)fail('NOT_AVAILABLE');
  }
  export async function requireCanonicalGenerationReadWithinTx(tx,a,clerk){
    const s=tx.fixture;s.calls.generationRead++;assert.deepEqual(a,s.a);assert.equal(clerk,s.a.clerkUserId);
    if(s.readUnavailable)fail('NOT_AVAILABLE');
  }
`);
const savedUrl = await sourceModule('../src/meri/objective-canonical-saved-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-completion-receipt.js'", portsUrl],
  ["'./objective-canonical-regeneration-completion-receipt.js'", portsUrl],
  ["'./objective-canonical-regeneration-request.js'", portsUrl],
  ["'./objective-canonical-regeneration-ledger.js'", portsUrl],
  ["'./objective-canonical-generation.js'", portsUrl],
  ["'./objective-canonical-producer-ledger.js'", portsUrl],
  ["'./objective-canonical-request-ledger.js'", portsUrl],
]);
const serviceUrl = await sourceModule('../src/planner/objective-canonical-application.service.ts', [
  ["'@nestjs/common'", nestUrl],
  ["'../prisma/prisma.service.js'", portsUrl],
  ["'./planner.service.js'", portsUrl],
  ["'./strategy-materialization.js'", portsUrl],
  ["'./objective-canonical-authority.js'", portsUrl],
  ["'./objective-canonical-fence.js'", portsUrl],
  ["'../meri/objective-canonical-saved-generation.js'", savedUrl],
  ["'./objective-canonical-application.js'", appUrl],
], true, 'transform');
const saved = await import(savedUrl);
const { ObjectiveCanonicalApplicationService } = await import(serviceUrl);
const { canonicalMaterializationReceiptId } = await import(portsUrl);
const producerCodecUrl = await sourceModule('../src/meri/objective-canonical-producer.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-generation.js'", portsUrl],
  ["'./objective-generation.types.js'", portsUrl],
]);
const producerServiceUrl = await sourceModule('../src/meri/objective-canonical-producer.service.ts', [
  ["'@nestjs/common'", nestUrl],
  ["'../prisma/prisma.service.js'", portsUrl],
  ["'../planner/objective-canonical-authority.js'", portsUrl],
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'../planner/objective-canonical-fence.js'", portsUrl],
  ["'./objective-canonical-generation.js'", portsUrl],
  ["'./objective-canonical-generation-fence.js'", portsUrl],
  ["'./objective-canonical-producer-ledger.js'", portsUrl],
  ["'./objective-canonical-producer.js'", producerCodecUrl],
  ["'./objective-canonical-request-ledger.js'", portsUrl],
  ["'./objective-canonical-request.js'", portsUrl],
  ["'./objective-canonical-saved-generation.js'", savedUrl],
], true, 'transform');
const { ObjectiveCanonicalProducerService } = await import(producerServiceUrl);

function fixture() {
  const s = { depth: 0, trace: [],
    calls: Object.fromEntries(['verify', 'current', 'effectFence', 'readFence', 'job', 'association', 'publication',
      'producer', 'normalization', 'ownerPrepare', 'ownerRead', 'ownerObserve', 'strategyCas', 'generationRead'].map(key => [key, 0])) };
  const canonical = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 4, snapshotHash: 'a'.repeat(64) };
  s.a = { schemaVersion: 1, canonical, actorUserId: id(9), clerkUserId: 'user_original', consentId: id(13),
    controlVersion: 2, generationJobId: id(10), generationRequestId: id(11), expectedStrategyVersionId: null, effectExpiresAtMs: 50_000 };
  s.association = { admission: s.a, acceptance: { sourceBinding: { tenantId: id(2), actorId: 'user_original',
    conversationId: id(50), runId: id(51), attemptId: id(52), workerId: id(53), writerFence: 7 },
    sourceRequestSha256: 'b'.repeat(64), issuance: { issuanceKey: 'original-generation', expiresAtMs: 45_000 } } };
  s.publication = { publication: { request: { basis: null, principal: { ownerActorId: 'user_original' } } } };
  const receipt = { schemaVersion: 1, requestId: id(11), source: { clientId: id(3), objectiveId: id(4),
    objectiveVersion: 4, objectiveRevisionId: id(8) }, context: { state: 'complete', packetId: id(54),
    compiledAt: at, reobservedAt: at, sourceDigest: 'c'.repeat(64), coverageDigest: 'd'.repeat(64),
    inputDigest: 'e'.repeat(64), issues: [] }, result: { strategyId: id(5), strategyVersionId: id(12),
    savedAt: at, sourceDigest: 'c'.repeat(64), contextPacketId: id(54), coverageDigest: 'd'.repeat(64),
    inputDigest: 'e'.repeat(64) }, failure: null };
  s.witness = { syntheticValid: true, generationJobId: id(10), generationRequestId: id(11),
    corePayloadSha256: 'f'.repeat(64), resultRef: 'original-retained-result' };
  s.job = { id: id(10), tenantId: id(2), clientId: id(3), ownerUserId: 'user_original', status: 'completed',
    strategyId: id(5), input: { canonicalCompletion: copy(s.witness),
      canonicalGeneration: { syntheticOriginalMarker: true }, dto: { type: 'authorization', clientId: id(3) },
      objectiveGeneration: { receipt: copy(receipt) } } };
  s.producer = { sourceAdmission: copy(s.a), acceptance: copy(s.association.acceptance),
    objectiveReceipt: copy(receipt), snapshotDigest: '2'.repeat(64) };
  s.normalization = { schemaVersion: 1, generationJobId: id(10), generationRequestId: id(11),
    sourceAdmissionSha256: app.applicationHash(s.a), sourceAcceptanceSha256: app.applicationHash(s.association.acceptance),
    strategyId: id(5), strategyVersionId: id(12), snapshotDigest: s.producer.snapshotDigest,
    normalizationWitness: { proposedPayloadSha256: s.witness.corePayloadSha256 } };
  s.request = { schemaVersion: 1, canonical, applicationRequestId: app.canonicalApplicationRequestId(canonical, id(9)),
    generationJobId: id(10), generationRequestId: id(11), strategyId: id(5), strategyVersionId: id(12),
    objectiveReceiptSha256: app.applicationHash(receipt), snapshotDigest: s.producer.snapshotDigest };
  s.allowedRequest = copy(s.request);
  s.grant = { tenantId: id(2), actorUserId: id(9), clerkUserId: 'user_original', consentId: id(14), controlVersion: 3,
    tokenExpiresAtMs: 9_999_999, delegationExpiresAtMs: 9_999_999, claimExpiresAtMs: 9_999_999,
    requestSha256: app.applicationHash(s.request), canonicalSha256: app.applicationHash(canonical) };
  const source = { generationJobId: id(10), generationRequestId: id(11), clientId: id(3), objectiveId: id(4),
    objectiveVersion: 4, objectiveRevisionId: id(8), strategyId: id(5), strategyVersionId: id(12), snapshotDigest: s.producer.snapshotDigest };
  const nodeIds = [id(20), id(21)], output = value => ({ availability: 'available', id: value, createdVersion: 1, currentVersion: 1 });
  s.ownerTemplate = { receiptVersion: 2, input: { requestId: s.request.applicationRequestId, generationJobId: id(10),
    expected: { strategyId: id(5), strategyVersionId: id(12), objectiveRevisionId: id(8) } },
    binding: { canonical, generationRequestId: id(11), objectiveReceiptSha256: s.request.objectiveReceiptSha256,
      snapshotDigest: s.request.snapshotDigest }, fingerprint: '3'.repeat(64), snapshot: { meta: { id: id(5) }, nodes: [] },
    archivedSourceNodeIds: [], result: { requestId: s.request.applicationRequestId, status: 'prepared', replayed: false,
      recordedAt: at, observedAt: at, source,
      projects: [{ groupKey: 'default', name: 'Exact saved plan', originalNodeIds: nodeIds, output: output(id(6)) }],
      tasks: nodeIds.map((sourceNodeId, index) => ({ sourceNodeId, originalGroupKeys: ['default'],
        currentGroupKeys: ['default'], output: output(id(30 + index)) })), context: [], edges: [], exclusions: [], issues: [],
      counts: { savedNodes: 2, actionableNodes: 2, contextNodes: 0, archivedNodes: 0, createdProjects: 1, createdTasks: 2 } } };
  s.durable = { resources: new Map(), owner: null, projects: [], tasks: [], headWrites: 0, receiptWrites: 0 };
  const forbidStrategy = () => { s.calls.strategyCas++;throw Error('Planner seam must never mutate Strategy/job completion'); };
  s.tx = { fixture: s,
    $executeRaw: async (strings, ...values) => {
      const sql = strings.join('?').replace(/\s+/g, ' ');
      if (!sql.includes('pg_advisory_xact_lock')) return forbidStrategy();
      assert.equal(s.depth, 1);assert.deepEqual(values, ['planner:' + id(2)]);s.trace.push('planner-lock');return 1;
    },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?').replace(/\s+/g, ' ');assert.equal(s.depth, 1);
      if (sql.includes('FROM sp_draft_job') && sql.includes('FOR SHARE')) {
        assert.deepEqual(values, [id(2), 'user_original', s.allowedRequest.generationJobId]);
        s.trace.push('original-job-share-lock');return s.jobMissing ? [] : [{ id: s.job.id }];
      }
      if (sql.includes('FROM sp_draft_job') && sql.includes('FOR UPDATE')) return [{ id: s.job.id }];
      if (sql.includes('FROM sp_strategy') || sql.includes('FROM sp_version')) return [{ id: id(5) }];
      if (sql.includes('FROM client_objective_work_consents')) return [{ expires: '40000' }];
      if (sql.includes('AS ms')) return [{ ms: '10000' }];
      if (sql.includes('clock_timestamp()')) return [{ now: new Date(at) }];
      throw Error(`Unexpected synthetic query: ${sql}`);
    },
    spDraftJob: {
      findFirst: async ({ where }) => {
        s.calls.job++;assert.equal(s.depth, 1);
        if (s.forbidSavedReads) throw Error('Historical ACK cannot reread current source job');
        if (s.jobMissing || where.id !== s.job.id || where.tenantId !== s.job.tenantId || where.ownerUserId !== s.job.ownerUserId) return null;
        return copy(s.job);
      },
      update: forbidStrategy, updateMany: forbidStrategy, create: forbidStrategy,
    },
    spPlannerResource: {
      findFirst: async ({ where }) => {
        assert.equal(s.depth, 1);
        const row = s.durable.resources.get(where.id);
        if (!row) return null;
        for (const key of ['tenantId', 'ownerId', 'kind', 'archived']) if (Object.hasOwn(where, key) && row[key] !== where[key]) return null;
        return copy(row);
      },
      create: async ({ data: row }) => {
        assert.equal(s.depth, 1);assert.equal(s.durable.resources.has(row.id), false);
        s.durable.resources.set(row.id, { ...copy(row), version: 1, archived: false });
        if (row.kind === app.CANONICAL_APPLICATION_HEAD) s.durable.headWrites++;
        else { assert.equal(row.kind, app.CANONICAL_APPLICATION_RECEIPT);s.durable.receiptWrites++; }
        return copy(s.durable.resources.get(row.id));
      },
      updateMany: () => { throw Error('First application has no prior canonical head to update'); },
    },
  };
  s.db = { withTenant: async (tenant, run, options) => {
    assert.equal(tenant, id(2));assert.equal(options.timeoutMs, 15_000);assert.equal(s.depth, 0);
    const before = copy(s.durable);let result;s.depth++;
    try { result = await run(s.tx); }
    catch (error) { s.durable = before;throw error; }
    finally { s.depth--; }
    if (s.loseCommittedReplyOnce) { s.loseCommittedReplyOnce = false;throw Error('Synthetic committed reply was lost'); }
    return result;
  } };
  s.authority = {
    verify: async (http, subject) => {
      s.calls.verify++;assert.equal(http.syntheticOriginalActor, true);s.subject = copy(subject);
      return { ...s.grant, requestSha256: app.applicationHash(subject.producerPhase ? s.producerBody : s.allowedRequest),
        canonicalSha256: app.applicationHash(s.allowedRequest.canonical) };
    },
    assertCurrent: async (tx, grant, subject) => {
      s.calls.current++;assert.equal(tx, s.tx);assert.equal(s.depth, 1);
      assert.equal(grant.actorUserId, s.grant.actorUserId);
      if (s.revoked) throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
      if (subject.purpose === 'effect' && s.effectUnavailable) throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
    },
  };
  s.planner = {
    prepareCanonicalStrategyPlanInTransaction: async (tx, ctx, input, binding, beforeWrite, predecessor) => {
      s.calls.ownerPrepare++;assert.equal(tx, s.tx);assert.equal(s.depth, 1);
      assert.deepEqual(ctx, { tenantId: id(2), clerkUserId: 'user_original', role: 'standard_user' });
      assert.deepEqual(input, s.ownerTemplate.input);assert.deepEqual(binding, s.ownerTemplate.binding);
      assert.equal(Object.hasOwn(input, 'groups'), false, 'default group selection belongs to existing Planner owner');
      assert.equal(binding.canonical.canonicalProjectId, id(6));assert.equal(predecessor, undefined);
      s.trace.push('existing-planner-owner');await beforeWrite();
      s.durable.projects.push(id(6));s.durable.tasks.push(id(30), id(31));s.durable.owner = copy(s.ownerTemplate);
      if (s.ownerError) throw s.ownerError;
      if (s.staleAfterOwner) s.staleObjective = true;
      return { stored: copy(s.durable.owner), replayed: false };
    },
    canonicalStrategyPlanCreationInTransaction: async (tx, ctx, requestId, binding) => {
      s.calls.ownerRead++;assert.equal(tx, s.tx);assert.equal(requestId, s.request.applicationRequestId);
      assert.equal(ctx.clerkUserId, 'user_original');assert.deepEqual(binding, s.ownerTemplate.binding);
      return copy(s.durable.owner);
    },
    canonicalStrategyPlanObservationInTransaction: async (tx, ctx, owner) => {
      s.calls.ownerObserve++;assert.equal(tx, s.tx);assert.deepEqual(owner, s.durable.owner);
      return copy(s.current ?? s.durable.owner.result);
    },
  };
  s.service = new ObjectiveCanonicalApplicationService(s.db, s.planner, s.authority);
  s.producerService = new ObjectiveCanonicalProducerService(s.db, s.authority);
  s.http = { syntheticOriginalActor: true };
  s.originalJob = copy(s.job);
  return s;
}

async function readSaved(s) {
  return s.db.withTenant(id(2), tx => saved.readCanonicalSavedGeneration(tx,
    { tenantId: id(2), clerkUserId: 'user_original', generationJobId: id(10) }), { timeoutMs: 15_000 });
}
const prepare = s => s.service.prepare(s.http, s.allowedRequest);
const lookup = s => s.service.lookup(s.http, s.request.applicationRequestId);
function failure(status, code) {
  return error => {
    assert.equal(error.getStatus(), status);assert.equal(error.getResponse().code, code);
    assert.equal(error.getResponse().outcome, 'unconfirmed');return true;
  };
}
function noPlannerEffects(s) {
  assert.deepEqual(s.durable.projects, []);assert.deepEqual(s.durable.tasks, []);
  assert.equal(s.durable.owner, null);assert.equal(s.durable.resources.size, 0);
  assert.equal(s.durable.receiptWrites, 0);assert.equal(s.durable.headWrites, 0);
  assert.deepEqual(s.job, s.originalJob);assert.equal(s.calls.strategyCas, 0);assert.equal(s.depth, 0);
}

test('actual shared helper reconstructs immutable saved Strategy receipt and derives unchanged nine-field command', async () => {
  const s = fixture(), value = await readSaved(s);
  assert.deepEqual(value.admission, s.a);assert.deepEqual(value.acceptance, s.association.acceptance);
  assert.deepEqual(value.publication, s.publication.publication);assert.deepEqual(value.receipt.completion, s.witness);
  assert.deepEqual(value.receipt.objectiveReceipt, s.producer.objectiveReceipt);
  assert.equal(value.receipt.objectiveReceiptSha256, app.applicationHash(s.producer.objectiveReceipt));
  assert.deepEqual(saved.requireSavedGenerationApplication(value, s.grant.actorUserId, s.request), s.request);
  assert.equal(Object.keys(saved.requireSavedGenerationApplication(value, s.grant.actorUserId, s.request)).length, 9);
  assert.equal(s.calls.ownerPrepare, 0);noPlannerEffects(s);
});

test('actual application service and kernel pass exact saved command to existing default-group owner and retain immutable ACK', async () => {
  const s = fixture(), result = await prepare(s);
  assert.deepEqual(s.trace.slice(0, 3), ['planner-lock', 'original-job-share-lock', 'existing-planner-owner']);
  assert.equal(s.calls.ownerPrepare, 1);assert.equal(s.durable.receiptWrites, 1);assert.equal(s.durable.headWrites, 1);
  assert.deepEqual(s.durable.projects, [id(6)]);assert.deepEqual(s.durable.tasks, [id(30), id(31)]);
  assert.equal(result.creation.availability, 'available');assert.equal(result.creation.ack.projects[0].projectId, id(6));
  assert.equal(result.creation.ack.ownerReceiptId, canonicalMaterializationReceiptId(id(2), 'user_original', s.request.applicationRequestId));
  assert.equal(result.creation.ack.ownerReceiptSha256, app.applicationHash(s.durable.owner));
  assert.equal(result.creation.sha256, app.applicationHash(result.creation.ack));
  assert.deepEqual(result.creation.ack.source, s.ownerTemplate.result.source);
  assert.equal(result.creation.ack.objectiveReceiptSha256, s.request.objectiveReceiptSha256);
  assert.deepEqual(s.job, s.originalJob);assert.equal(s.calls.strategyCas, 0);
});

test('original generation and Planner consents remain distinct; application ACK records only Planner action consent', async () => {
  const s = fixture(), result = await prepare(s);
  assert.notEqual(s.a.consentId, s.grant.consentId);
  assert.equal(result.creation.ack.consentId, s.grant.consentId);assert.equal(result.creation.ack.controlVersion, s.grant.controlVersion);
  assert.equal(s.a.consentId, id(13));assert.equal(s.job.input.objectiveGeneration.receipt.requestId, s.a.generationRequestId);
  assert.deepEqual(s.job, s.originalJob);
});

test('same-request POST replay and GET bypass helper/current-source effects and preserve human edits after Objective advance', async () => {
  const s = fixture(), original = await prepare(s);
  const reads = s.calls.job, before = copy(s.durable);
  s.forbidSavedReads = true;s.staleObjective = true;s.effectUnavailable = true;
  s.current = copy(s.durable.owner.result);s.current.projects[0].name = 'Human edited project';
  s.current.projects[0].output.currentVersion = 7;s.current.tasks[0].output.currentVersion = 4;
  s.current.tasks[0].currentGroupKeys = ['human-regrouped'];
  const replay = await prepare(s), observed = await lookup(s);
  assert.deepEqual(replay.creation, original.creation);assert.deepEqual(observed.creation, original.creation);
  assert.equal(observed.current.projects[0].name, 'Human edited project');
  assert.equal(observed.current.projects[0].output.currentVersion, 7);
  assert.deepEqual(observed.current.tasks[0].currentGroupKeys, ['human-regrouped']);
  assert.deepEqual(s.durable, before);assert.equal(s.calls.job, reads);assert.equal(s.calls.ownerPrepare, 1);
  assert.equal(s.calls.strategyCas, 0);
});

test('lost committed Planner reply recovers same immutable receipt via GET without owner write or generation read', async () => {
  const s = fixture();s.loseCommittedReplyOnce = true;
  await assert.rejects(() => prepare(s), failure(503, 'OUTCOME_UNCONFIRMED'));
  assert.equal(s.calls.ownerPrepare, 1);assert.equal(s.durable.receiptWrites, 1);
  const durable = copy(s.durable), reads = s.calls.job;s.forbidSavedReads = true;
  const recovered = await lookup(s);
  assert.equal(recovered.creation.ack.applicationRequestId, s.request.applicationRequestId);
  assert.equal(recovered.creation.sha256, app.applicationHash(recovered.creation.ack));
  assert.deepEqual(s.durable, durable);assert.equal(s.calls.job, reads);assert.equal(s.calls.ownerPrepare, 1);
  assert.deepEqual(s.job, s.originalJob);assert.equal(s.calls.strategyCas, 0);
});

test('current Objective effect fence refuses before Planner outputs while retaining original Strategy receipt', async () => {
  const s = fixture();s.staleObjective = true;
  await assert.rejects(() => prepare(s), failure(409, 'SOURCE_STALE'));
  assert.equal(s.calls.ownerPrepare, 1);assert.ok(s.calls.job > 0);noPlannerEffects(s);
});

test('caller Strategy/version, receipt hash or snapshot substitution cannot replace authoritative saved command', async () => {
  for (const [field, value] of [['strategyVersionId', id(99)], ['objectiveReceiptSha256', '9'.repeat(64)],
    ['snapshotDigest', '9'.repeat(64)], ['generationRequestId', id(99)]]) {
    const s = fixture();s.allowedRequest[field] = value;
    await assert.rejects(() => prepare(s), failure(409, 'REQUEST_CONFLICT'));
    assert.equal(s.calls.ownerPrepare, 0);noPlannerEffects(s);
  }
});

test('changed Objective revision/token and native actor are not adopted from an authenticated caller body', async () => {
  for (const change of ['objective', 'actor']) {
    const s = fixture();
    if (change === 'objective') s.allowedRequest.canonical.requestedObjectiveRevisionId = id(99);
    else s.grant.actorUserId = id(99);
    s.allowedRequest.applicationRequestId = app.canonicalApplicationRequestId(s.allowedRequest.canonical, s.grant.actorUserId);
    await assert.rejects(() => prepare(s), failure(409, 'REQUEST_CONFLICT'));
    assert.equal(s.calls.ownerPrepare, 0);noPlannerEffects(s);
  }
});

test('running, failed or missing source jobs never materialize a reserved Strategy identity', async () => {
  for (const state of ['running', 'failed', 'missing']) {
    const s = fixture();
    if (state === 'missing') s.jobMissing = true;else s.job.status = state;
    s.originalJob = copy(s.job);
    await assert.rejects(() => prepare(s), failure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.calls.ownerPrepare, 0);noPlannerEffects(s);
  }
});

test('completed legacy job without retained completion witness and missing publication remain unconfirmed', async () => {
  for (const mutate of [s => { delete s.job.input.canonicalCompletion; }, s => { s.publicationMissing = true; }]) {
    const s = fixture();mutate(s);s.originalJob = copy(s.job);
    await assert.rejects(() => prepare(s), failure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.calls.ownerPrepare, 0);noPlannerEffects(s);
  }
});

test('corrupt normalization or original saved receipt cannot feed an otherwise authorized Planner request', async () => {
  for (const mutate of [s => { s.normalization = null; }, s => { s.normalization.schemaVersion = 2; },
    s => { s.normalization.sourceAcceptanceSha256 = '9'.repeat(64); },
    s => { s.normalization.strategyVersionId = id(99); },
    s => { s.normalization.normalizationWitness.proposedPayloadSha256 = '9'.repeat(64); },
    s => { s.producer.objectiveReceipt.result = null; }]) {
    const s = fixture();mutate(s);
    await assert.rejects(() => prepare(s), failure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.calls.ownerPrepare, 0);noPlannerEffects(s);
  }
});

test('stored witness decoder input/conflict errors become 503 unknown rather than caller input or new-effect claims', async () => {
  for (const code of ['INPUT_INVALID', 'REQUEST_CONFLICT']) {
    const s = fixture();s.job.input.canonicalCompletion.syntheticDecoderCode = code;s.originalJob = copy(s.job);
    await assert.rejects(() => prepare(s), failure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.calls.ownerPrepare, 0);noPlannerEffects(s);
  }
});

test('private regeneration request remains outside the initial saved-generation reader', async () => {
  for (const mutate of [s => { s.a.expectedStrategyVersionId = id(99); },
    s => { s.publication.publication.request.requestVersion = 'private-regeneration'; },
    s => { s.publication.publication.request.basis = { strategyVersionId: id(99) }; }]) {
    const s = fixture();mutate(s);
    await assert.rejects(() => prepare(s), failure(503, 'AUTHORITY_UNAVAILABLE'));
    assert.equal(s.calls.ownerPrepare, 0);noPlannerEffects(s);
  }
});

test('existing Planner owner error escapes and rolls back outputs/receipts/head without changing Strategy completion', async () => {
  const s = fixture();s.ownerError = new Error('Synthetic Planner owner failed after outputs');
  await assert.rejects(() => prepare(s), failure(503, 'OUTCOME_UNCONFIRMED'));
  assert.equal(s.calls.ownerPrepare, 1);noPlannerEffects(s);
});

test('release effect fence failure rolls back owner outputs and any pending application state together', async () => {
  const s = fixture();s.staleAfterOwner = true;
  await assert.rejects(() => prepare(s), failure(409, 'SOURCE_STALE'));
  assert.equal(s.calls.ownerPrepare, 1);noPlannerEffects(s);
});

test('historical ACK lookup has fresh current read authority and missing receipt is never an eligibility proof', async () => {
  const empty = fixture();
  await assert.rejects(() => lookup(empty), failure(503, 'OUTCOME_UNCONFIRMED'));
  assert.equal(empty.calls.job, 0);assert.equal(empty.calls.ownerPrepare, 0);noPlannerEffects(empty);
  const s = fixture();await prepare(s);s.forbidSavedReads = true;s.revoked = true;
  const before = copy(s.durable), reads = s.calls.job;
  await assert.rejects(() => lookup(s), failure(503, 'AUTHORITY_UNAVAILABLE'));
  assert.deepEqual(s.durable, before);assert.equal(s.calls.job, reads);assert.equal(s.calls.ownerPrepare, 1);
});

test('partially unavailable current outputs redact immutable creation ACK without rewriting retained receipts', async () => {
  const s = fixture();await prepare(s);s.forbidSavedReads = true;s.current = copy(s.durable.owner.result);
  s.current.status = 'partial';s.current.projects[0].output.availability = 'unavailable';
  s.current.projects[0].output.id = null;s.current.projects[0].output.currentVersion = null;
  const before = copy(s.durable), result = await lookup(s);
  assert.deepEqual(result.creation, { availability: 'unavailable', ack: null, sha256: null });
  assert.deepEqual(s.durable, before);assert.equal(s.calls.ownerPrepare, 1);assert.equal(s.calls.strategyCas, 0);
});

function producerRequest(s, phase) {
  const { schemaVersion: _schema, ...command } = s.request;
  s.producerBody = { schemaVersion: 1, phase, work: { ...command,
    actorUserId: s.grant.actorUserId, consentId: s.grant.consentId, controlVersion: s.grant.controlVersion } };
  return s.producerBody;
}

test('actual Producer start/prepare requires retained completion witness before new Planner dispatch admission', async () => {
  for (const phase of ['start', 'prepare']) {
    const s = fixture();delete s.job.input.canonicalCompletion;s.originalJob = copy(s.job);
    await assert.rejects(() => s.producerService.admit(s.http, producerRequest(s, phase)), failure(503, 'OUTCOME_UNCONFIRMED'));
    assert.ok(s.calls.publication > 0);assert.equal(s.calls.effectFence, 0);noPlannerEffects(s);
  }
});

test('actual Producer start/prepare with saved witness returns source proof clipped to the original Planner consent', async () => {
  for (const phase of ['start', 'prepare']) {
    const s = fixture(), result = await s.producerService.admit(s.http, producerRequest(s, phase));
    assert.equal(s.subject.purpose, 'effect');assert.equal(result.expiresAtMs, 40_000);
    assert.deepEqual(result.sourceBinding, s.association.acceptance.sourceBinding);
    assert.deepEqual(result.objectiveReceipt, s.producer.objectiveReceipt);
    assert.ok(s.calls.publication > 0);assert.equal(s.calls.effectFence, 2);
    assert.equal(s.calls.readFence, 0);noPlannerEffects(s);
  }
});

test('actual Producer read/stop bypasses new witness helper and never authorizes a fresh effect', async () => {
  for (const phase of ['read', 'stop']) {
    const s = fixture();delete s.job.input.canonicalCompletion;s.originalJob = copy(s.job);
    s.producer.sourceAdmission.effectExpiresAtMs = 1;s.producer.acceptance.issuance.expiresAtMs = 1;
    s.a.effectExpiresAtMs = 1;
    const result = await s.producerService.admit(s.http, producerRequest(s, phase));
    assert.equal(s.subject.purpose, 'retained-result-read');assert.equal(result.workSha256, app.applicationHash(s.producerBody.work));
    assert.deepEqual(result.objectiveReceipt, s.producer.objectiveReceipt);
    assert.equal(s.calls.association, 0);assert.equal(s.calls.publication, 0);assert.equal(s.calls.normalization, 0);
    assert.equal(s.calls.effectFence, 0);assert.equal(s.calls.readFence, 2);assert.equal(s.calls.generationRead, 2);
    noPlannerEffects(s);
  }
});

test('actual Producer historical read/stop still refuses fresh read-authority revocation', async () => {
  for (const phase of ['read', 'stop']) {
    const s = fixture();s.revoked = true;
    await assert.rejects(() => s.producerService.admit(s.http, producerRequest(s, phase)), failure(503, 'AUTHORITY_UNAVAILABLE'));
    assert.equal(s.calls.publication, 0);assert.equal(s.calls.effectFence, 0);noPlannerEffects(s);
  }
});

test('prints actual helper/service/kernel custody and explicit synthetic owner/database limits', () => {
  assert.equal(custody.length, 5);
  console.log(JSON.stringify({ qualification: 'saved-Strategy-to-existing-Planner-source-orchestration-only', sourceCustody: custody,
    actual: ['readCanonicalSavedGeneration', 'requireSavedGenerationApplication', 'ObjectiveCanonicalApplicationService',
      'executeCanonicalApplicationTransaction', 'creationAck', 'checkStoredApplication', 'applicationObservation'],
    synthetic: ['database SQL and transaction rollback model', 'current authority and source fences',
      'retained ledger/codec owner ports', 'Planner materializer/creation/observation ports', 'owner receipt ID dependency'],
    nativeDatabaseFrameworkHttpGenuineCustodyAuthority: 'UNQUALIFIED', subprocesses: 0, network: false, fileWrites: false }));
});
