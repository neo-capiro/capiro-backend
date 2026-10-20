// SOURCE-ORCHESTRATION FIXTURE ONLY. The actual completion service executes;
// custody, SQL/transactions, authority, codecs, normalization, context and the
// existing Strategy writer are explicitly synthetic ports. This does not
// qualify Nest/HTTP, semantic TypeScript, genuine custody or DB atomicity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const custody = [];
const slot = Symbol.for('capiro.completion-service.focused.synthetic-state');
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
async function sourceModule(relative, replacements = [], injectable = false, mode = 'strip') {
  const path = new URL(relative, import.meta.url);
  const raw = await readFile(path, 'utf8');
  let source = raw;
  if (injectable) {
    assert.equal(source.split('@Injectable()').length, 2, 'only the declared Nest decorator is removed');
    source = source.replace('@Injectable()', '');
  }
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, `one exact import rewrite: ${from}`);
    source = source.replace(from, JSON.stringify(to));
  }
  const transformed = stripTypeScriptTypes(source, { mode, sourceUrl: path.href });
  custody.push({ path: relative, sha256: sha(raw), transformedSha256: sha(transformed), mode,
    removedDecorator: injectable ? '@Injectable()' : null,
    replacementSpecifiers: replacements.map(([from]) => from) });
  return data(transformed);
}

const appUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const app = await import(appUrl);
const nestUrl = data(`export const Injectable=()=>value=>value;
  export class HttpException extends Error {
    constructor(response,status){super(response.code);this.response=response;this.status=status;}
    getResponse(){return this.response;} getStatus(){return this.status;}
  }`);
const ownerUrl = await sourceModule('../src/meri/objective-canonical-result-owner.ts', [
  ["'@nestjs/common'", nestUrl],
  ["'../planner/objective-canonical-application.js'", appUrl],
], true);
const { ObjectiveCanonicalResultOwner } = await import(ownerUrl);

// One declared synthetic dependency module, with the actual service left
// intact. Each port records its use or fails closed. Pure result/request codec
// conformance and the actual writer have separate owner tests.
const portsUrl = data(`
  import assert from 'node:assert/strict';
  import {applicationHash,CanonicalApplicationError} from ${JSON.stringify(appUrl)};
  const state=()=>globalThis[Symbol.for('capiro.completion-service.focused.synthetic-state')];
  const clone=value=>structuredClone(value);
  const fail=(code='OUTCOME_UNCONFIRMED')=>{throw new CanonicalApplicationError(code);};
  export class PrismaService{};
  export class ObjectiveCanonicalWorkloadAuthority{};
  export class MeriService{};
  export class ObjectiveCanonicalOwnerDirectory{};
  export class StrategyContextPlaneClient{};
  export const CORE_CANONICAL_REGENERATION_REQUEST_VERSION='capiro.objective-strategy.regeneration-request/20261016.1';
  export const GENERATION_ADMISSION='synthetic-admission',GENERATION_ACCEPTANCE='synthetic-acceptance',GENERATION_PRODUCER='synthetic-producer';
  export const GENERATION_NORMALIZATION='synthetic-normalization';
  export const generationLedgerId=()=>{throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');};
  export const checkCanonicalRegenerationCompletionWitness=()=>{throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');};
  export const checkCanonicalRegenerationNormalization=()=>{throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');};
  export const verifyRetainedCanonicalRegenerationCompletion=()=>{throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');};
  export const normalizeCanonicalRegenerationDraft=()=>{throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');};
  export const canonicalGenerationAdmissionSha256=applicationHash;
  export async function generationAssociation(tx,tenant,clerk,job){
    assert.equal(tx.fixture,state());assert.equal(tenant,state().a.canonical.tenantId);
    assert.equal(clerk,state().a.clerkUserId);assert.equal(job,state().job.id);
    state().calls.association++;return clone(state().association);
  }
  export async function readCanonicalRequestPublication(tx,a){
    assert.equal(tx.fixture,state());assert.deepEqual(a,state().a);
    state().calls.publication++;
    if(state().publicationError)fail();
    return state().stored===null?null:clone(state().stored);
  }
  export async function readCanonicalGenerationProducer(tx,tenant,clerk,job){
    assert.equal(tx.fixture,state());assert.equal(job,state().job.id);
    state().calls.producer++;
    if(!state().producer)fail();return clone(state().producer);
  }
  export async function readGenerationLedger(tx,kind,tenant,clerk,job){
    assert.equal(tx.fixture,state());assert.equal(kind,GENERATION_NORMALIZATION);
    assert.equal(job,state().job.id);state().calls.ledger++;
    return clone(state().normalization);
  }
  export async function requireCanonicalGenerationReadWithinTx(tx,a,clerk){
    assert.equal(tx.fixture,state());assert.equal(clerk,a.clerkUserId);
    state().calls.readFence++;
    if(state().readFenceError)fail('SOURCE_STALE');
  }
  export async function requireCanonicalGenerationEffectWithinTx(tx,a,source){
    assert.equal(tx.fixture,state());assert.equal(source.generationJobId,a.generationJobId);
    assert.equal(source.generationRequestId,a.generationRequestId);
    state().calls.effectFence++;
    if(state().effectFenceError)fail('SOURCE_STALE');
  }
  export function deriveCanonicalJobInput(job,a,envelope,claim){
    const s=state();s.calls.derive++;
    assert.equal(job.id,s.a.generationJobId);assert.deepEqual(job.input.dto,s.originalDto);
    assert.deepEqual(a,s.a);assert.deepEqual(envelope,job.input.objectiveGeneration);
    assert.equal(job.attempt,2);assert.equal(claim,'canonical:'+s.association.acceptance.issuance.issuanceKey);
    assert.equal(job.claimedBy,claim);return {dto:clone(job.input.dto),envelope:clone(envelope)};
  }
  export function verifyRetainedCanonicalCompletion(raw,expected){
    const s=state();s.calls.verifyResult++;
    assert.deepEqual(expected.admission,s.a);assert.deepEqual(expected.acceptance,s.association.acceptance);
    assert.deepEqual(expected.publication,s.stored.publication);assert.equal(expected.nowMs,s.now);
    if(s.codecError)fail();
    return {payload:clone(raw.payload),witness:clone(raw.witness),expiresAtMs:raw.expiresAtMs};
  }
  export function checkCanonicalCompletionWitness(value,expected){
    const s=state();s.calls.checkWitness++;
    assert.deepEqual(expected.admission,s.a);
    if(!value||applicationHash(value)!==applicationHash(s.witness))fail();
    return clone(value);
  }
  export function normalizeCanonicalDraft(payload,options){
    const s=state();s.calls.normalize++;
    assert.deepEqual(payload,s.rawResult.payload);assert.deepEqual(options.admission,s.a);
    assert.equal(options.queuedType,s.originalDto.type);
    assert.deepEqual([...options.ownerMap],[['actor_ref','user_original'],['owner_ref','user_owner']]);
    return clone(s.normalized);
  }
  export function objectivePersistence(claim,contextPlane,compiled){
    const s=state();s.calls.persistence++;
    assert.equal(claim.id,s.job.id);assert.equal(claim.tenantId,s.a.canonical.tenantId);
    assert.equal(claim.ownerUserId,s.a.clerkUserId);assert.equal(claim.attempt,2);
    assert.equal(claim.claimToken,'canonical:'+s.association.acceptance.issuance.issuanceKey);
    assert.deepEqual(claim.input.dto,s.originalDto);assert.deepEqual(claim.completion,s.witness);
    assert.deepEqual(compiled(),s.stored.compiled);s.claim=claim;
    return {
      beforeTransaction:async()=>{
        assert.equal(s.depth,0,'context re-observation is outside all DB transactions');
        s.trace.push('context-before-transaction');
        claim.input.objectiveGeneration.historyCheckedAt=await contextPlane.recheckObjective(claim,compiled());
      },
      beforeWrite:async tx=>{
        assert.equal(tx.fixture,s);assert.equal(s.depth,1);s.trace.push('original-before-write');
        if(s.beforeWriteError)fail('SOURCE_STALE');
        if(s.job.attempt!==2||s.job.claimedBy!==claim.claimToken)fail('REQUEST_CONFLICT');
        s.calls.beforeWrite++;
      },
      afterWrite:async(tx,saved)=>{
        assert.equal(tx.fixture,s);assert.equal(s.depth,1);s.trace.push('original-after-write');
        if(s.afterWriteError)fail('SOURCE_STALE');
        s.calls.afterWrite++;
        s.job.status='completed';s.job.strategyId=saved.strategyId;
        s.job.input.canonicalCompletion=clone(claim.completion);
        s.job.input.objectiveGeneration=clone(claim.input.objectiveGeneration);
        s.job.input.objectiveGeneration.receipt.result={...saved,savedAt:'2026-10-16T00:00:00.000Z'};
        s.producer={objectiveReceipt:clone(s.job.input.objectiveGeneration.receipt),snapshotDigest:s.snapshotDigest};
        s.normalization={schemaVersion:1,generationJobId:s.job.id,generationRequestId:s.a.generationRequestId,
          sourceAdmissionSha256:applicationHash(s.a),sourceAcceptanceSha256:applicationHash(s.association.acceptance),
          strategyId:saved.strategyId,strategyVersionId:saved.strategyVersionId,snapshotDigest:s.snapshotDigest,
          normalizationWitness:{proposedPayloadSha256:claim.completion.corePayloadSha256}};
      }
    };
  }
`);
const savedGenerationUrl = await sourceModule('../src/meri/objective-canonical-saved-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-completion-receipt.js'", portsUrl],
  ["'./objective-canonical-regeneration-completion-receipt.js'", portsUrl],
  ["'./objective-canonical-regeneration-request.js'", portsUrl],
  ["'./objective-canonical-regeneration-ledger.js'", portsUrl],
  ["'./objective-canonical-generation.js'", portsUrl],
  ["'./objective-canonical-producer-ledger.js'", portsUrl],
  ["'./objective-canonical-request-ledger.js'", portsUrl],
]);
const serviceUrl = await sourceModule('../src/meri/objective-canonical-completion.service.ts', [
  ["'@nestjs/common'", nestUrl],
  ["'../prisma/prisma.service.js'", portsUrl],
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'../planner/objective-canonical-authority.js'", portsUrl],
  ["'./meri.service.js'", portsUrl],
  ["'./objective-canonical-result-owner.js'", ownerUrl],
  ["'./objective-canonical-owner-directory.js'", portsUrl],
  ["'./strategy-context-plane.client.js'", portsUrl],
  ["'./objective-generation-completion.js'", portsUrl],
  ["'./objective-canonical-draft.js'", portsUrl],
  ["'./objective-canonical-completion-receipt.js'", portsUrl],
  ["'./objective-canonical-regeneration-completion-receipt.js'", portsUrl],
  ["'./objective-canonical-producer-ledger.js'", portsUrl],
  ["'./objective-canonical-generation.js'", portsUrl],
  ["'./objective-canonical-saved-generation.js'", savedGenerationUrl],
  ["'./objective-canonical-request-ledger.js'", portsUrl],
  ["'./objective-canonical-regeneration-request.js'", portsUrl],
  ["'./objective-canonical-job-input.js'", portsUrl],
  ["'./objective-canonical-generation-fence.js'", portsUrl],
], true, 'transform');
const { ObjectiveCanonicalCompletionService } = await import(serviceUrl);

function fixture() {
  const s = { now: 10_000, depth: 0, trace: [], writes: 0, reads: 0, writerCalls: 0,
    calls: Object.fromEntries(['verifyAuthority', 'current', 'association', 'publication', 'producer', 'ledger',
      'readFence', 'effectFence', 'derive', 'verifyResult', 'checkWitness', 'normalize', 'persistence',
      'beforeWrite', 'afterWrite', 'context', 'owner', 'forbidden'].map(key => [key, 0])) };
  s.a = { schemaVersion: 1, canonical: { tenantId: id(1), clientId: id(2), objectiveId: id(3),
    canonicalStrategyId: id(4), requestedObjectiveRevisionId: id(5) }, actorUserId: id(6), clerkUserId: 'user_original',
    consentId: id(7), controlVersion: 2, generationJobId: id(8), generationRequestId: id(9),
    admittedAtMs: 1000, effectExpiresAtMs: 50_000, expectedStrategyVersionId: null };
  const binding = { tenantId: id(1), actorId: 'user_original', conversationId: id(10), runId: id(11),
    attemptId: id(12), workerId: id(13), writerFence: 7 };
  s.association = { admission: s.a, acceptance: { sourceBinding: binding, sourceRequestSha256: 'b'.repeat(64),
    issuance: { issuanceKey: 'original-issuance', expiresAtMs: 45_000 } } };
  const context = { state: 'complete', packetId: id(14), sourceDigest: 'c'.repeat(64), coverageDigest: 'd'.repeat(64),
    inputDigest: 'e'.repeat(64), compiledAt: '2026-10-16T00:00:00.000Z', reobservedAt: null, issues: [] };
  const source = { clientId: id(2), objectiveId: id(3), objectiveVersion: 1, objectiveRevisionId: id(5) };
  s.originalDto = { clientId: id(2), type: 'authorization', goal: 'Original raw goal', meriContext: null,
    ownerUserId: 'user_owner', targetDate: '2026-10-30', attachmentIds: [] };
  s.job = { id: id(8), tenantId: id(1), clientId: id(2), ownerUserId: 'user_original', status: 'running',
    attempt: 2, claimedBy: 'canonical:original-issuance', strategyId: null,
    input: { dto: copy(s.originalDto), bearer: null, canonicalGeneration: { source: 'synthetic-original-marker' },
      objectiveGeneration: { request: { requestId: id(9), clientId: id(2), type: 'authorization',
        objective: { objectiveId: id(3), objectiveVersion: 1 } }, fingerprint: 'f'.repeat(64),
      receipt: { schemaVersion: 1, requestId: id(9), source, context, result: null, failure: null } } } };
  s.stored = { publicationSha256: '1'.repeat(64), publication: { request: { basis: null,
    principal: { ownerActorId: 'user_owner' } },
    executionContext: { schemaVersion: 1, prompt: 'Actual stored synthetic prompt', contextPacketId: id(14) } },
    compiled: { requestId: id(9), type: 'authorization', source, context: copy(context), synthetic: 'original-compiled' } };
  s.witness = { schemaVersion: 1, namespace: 'synthetic-custody-witness-not-authentic', generationJobId: id(8),
    generationRequestId: id(9), corePayloadSha256: '2'.repeat(64), resultRef: 'original-retained-object' };
  s.rawResult = { payload: { synthetic: 'original-sdk-payload' }, witness: copy(s.witness), expiresAtMs: 35_000 };
  s.normalized = { response: { summary: 'Synthetic normalized payload', nodes: [] }, nodeIds: [id(15)],
    sourceKeyToNodeId: { original: id(15) }, synthetic: 'normalizer-port' };
  s.snapshotDigest = '3'.repeat(64);
  s.saved = { strategyId: id(4), strategyVersionId: id(16) };
  s.normalization = null;
  s.producer = null;
  s.ownerRows = [{ ownerRef: 'actor_ref', clerkUserId: 'user_original' },
    { ownerRef: 'owner_ref', clerkUserId: 'user_owner' }];
  s.grant = { tenantId: id(1), actorUserId: id(6), clerkUserId: 'user_original', consentId: id(7), controlVersion: 2,
    checkedAtMs: 9999, expiresAtMs: 40_000, delegationExpiresAtMs: 41_000, claimExpiresAtMs: 42_000 };
  const forbidden = label => { s.calls.forbidden++; throw Error(`Forbidden synthetic port: ${label}`); };
  const tx = { fixture: s,
    $queryRaw: async (strings, ...values) => {
      assert.equal(s.depth, 1);
      const sql = strings.join('?').replace(/\s+/g, ' ');
      if (sql.includes('clock_timestamp()')) return [{ ms: String(s.now) }];
      if (sql.includes('FROM sp_draft_job') && sql.includes('FOR UPDATE')) {
        assert.deepEqual(values, [s.a.canonical.tenantId, s.job.id]);
        return [{ id: s.job.id }];
      }
      return forbidden('unexpected SQL');
    },
    $executeRaw: () => forbidden('post-completion update'),
    spDraftJob: {
      findFirst: async ({ where }) => {
        assert.equal(s.depth, 1);
        if (s.failNextCompletedRead && s.job.status === 'completed') {
          s.failNextCompletedRead = false;
          throw Error('Synthetic lost post-commit response');
        }
        assert.deepEqual(where, { tenantId: id(1), id: id(8), ownerUserId: 'user_original' });
        return s.missingJob ? null : copy(s.job);
      },
      create: () => forbidden('new generation job'),
      update: () => forbidden('standalone job update'),
      updateMany: () => forbidden('legacy completion sweep'),
    },
  };
  const db = { withTenant: async (tenant, run, options) => {
    assert.equal(tenant, id(1));
    assert.equal(options.timeoutMs, 15_000);
    assert.equal(s.depth, 0, 'service does not nest its database transactions');
    const before = copy({ job: s.job, writes: s.writes, normalization: s.normalization, producer: s.producer });
    s.depth++;
    try { return await run(tx); }
    catch (error) { Object.assign(s, before); throw error; }
    finally { s.depth--; }
  } };
  s.db = db;
  s.authority = {
    verifyGeneration: async (http, subject) => {
      s.calls.verifyAuthority++;
      assert.equal(http.syntheticOriginalRequest, true);
      s.subject = copy(subject);
      if (s.verifyAuthorityError) throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
      return { ...s.grant, requestSha256: s.wrongRequestHash ? '0'.repeat(64) : subject.requestSha256 };
    },
    assertGenerationCurrent: async (currentTx, grant, subject) => {
      assert.equal(currentTx, tx);assert.equal(s.depth, 1);
      s.calls.current++;
      assert.equal(subject.generationJobId, id(8));
      if (s.currentError || s.revokeOnTrace && s.revokeOnTrace === s.trace.at(-1))
        throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
    },
  };
  s.reader = { read: async (selection, { signal }) => {
    s.reads++;s.trace.push('retained-read');assert.equal(s.depth, 0);
    assert.deepEqual(selection, { generationJobId: id(8), binding: s.association.acceptance.sourceBinding,
      sourceAdmissionSha256: app.applicationHash(s.a) });
    assert.equal(signal.aborted, false);s.readerSignal = signal;
    if (s.readerError) throw Error('Synthetic retained owner unavailable');
    if (s.readerOnRead) s.readerOnRead(s);
    return copy(s.rawResult);
  } };
  s.context = { recheckObjective: async (claim, compiled) => {
    s.calls.context++;
    assert.equal(s.depth, 0);assert.equal(claim.id, id(8));assert.deepEqual(compiled, s.stored.compiled);
    if (s.contextError) throw Error('Synthetic as-of history recheck failed');
    return '2026-10-16T00:00:01.000Z';
  } };
  s.owners = { read: async (ownerTx, tenant) => {
    s.calls.owner++;assert.equal(ownerTx, tx);assert.equal(tenant, id(1));
    if (s.ownerOnRead) s.ownerOnRead(s);
    return copy(s.ownerRows);
  } };
  s.writer = {
    applyCanonicalDraft: async (tenant, clerk, admission, normalized, runtime) => {
      s.writerCalls++;assert.equal(s.depth, 0);s.trace.push('canonical-writer');
      assert.equal(tenant, id(1));assert.equal(clerk, 'user_original');assert.deepEqual(admission, s.a);
      assert.deepEqual(normalized, s.normalized);assert.equal(runtime.timeoutMs, 30_000);
      assert.deepEqual(runtime.objective.envelope, s.job.input.objectiveGeneration);
      s.runtime = runtime;
      await runtime.persistence.beforeTransaction();
      await db.withTenant(tenant, async writerTx => {
        await runtime.persistence.beforeWrite(writerTx);
        s.trace.push('synthetic-strategy-write');s.writes++;
        await runtime.persistence.afterWrite(writerTx, s.saved);
      }, { timeoutMs: 15_000 });
      if (s.loseReplyAfterCommit) s.failNextCompletedRead = true;
      return copy(s.saved);
    },
    draft: () => forbidden('legacy model draft'),
    generate: () => forbidden('new model query'),
  };
  s.makeService = (reader = s.reader) => new ObjectiveCanonicalCompletionService(db, s.authority, reader, s.writer, s.context, s.owners);
  s.http = { syntheticOriginalRequest: true };
  s.body = { schemaVersion: 1, generationJobId: id(8) };
  globalThis[slot] = s;
  return s;
}

function httpFailure(status, code) {
  return error => {
    assert.equal(error.getStatus(), status);
    assert.deepEqual(error.getResponse(), { schemaVersion: 1, code,
      message: 'Objective Strategy application is unavailable.', outcome: 'unconfirmed' });
    return true;
  };
}
function noEffects(s) {
  assert.equal(s.writes, 0);assert.equal(s.job.status, 'running');
  assert.equal(s.job.input.canonicalCompletion, undefined);
  assert.equal(s.job.input.objectiveGeneration.receipt.result, null);
  assert.equal(s.producer, null);assert.equal(s.normalization, null);
  assert.equal(s.calls.forbidden, 0);assert.equal(s.depth, 0);
}
async function complete(s) { return s.makeService().complete(s.http, s.body); }

test('default genuine retained-owner port is unavailable and writes nothing', async () => {
  const s = fixture();
  await assert.rejects(() => s.makeService(new ObjectiveCanonicalResultOwner()).complete(s.http, s.body),
    httpFailure(503, 'AUTHORITY_UNAVAILABLE'));
  assert.equal(s.writerCalls, 0);noEffects(s);
});

test('closed POST body refuses posted payload, locator, binding, or replacement identity before authority', async () => {
  const body = { schemaVersion: 1, generationJobId: id(8) };
  for (const raw of [null, [], { ...body, payload: {} }, { ...body, resultRef: 'caller-ref' },
    { ...body, binding: {} }, { ...body, canonicalCompletion: {} },
    { schemaVersion: 1, generationJobId: 'invalid' }]) {
    const s = fixture();
    await assert.rejects(() => s.makeService().complete(s.http, raw), httpFailure(400, 'INPUT_INVALID'));
    assert.equal(s.calls.verifyAuthority, 0);assert.equal(s.reads, 0);assert.equal(s.writerCalls, 0);noEffects(s);
  }
});

test('fresh verifier, current authority, request binding and database-clock grant expiry fence application', async () => {
  for (const mutate of [s => { s.verifyAuthorityError = true; }, s => { s.currentError = true; },
    s => { s.wrongRequestHash = true; }, s => { s.grant.checkedAtMs = s.now + 1; },
    s => { s.grant.expiresAtMs = s.now; }, s => { s.grant.delegationExpiresAtMs = s.now; },
    s => { s.grant.claimExpiresAtMs = s.now; }]) {
    const s = fixture();mutate(s);
    await assert.rejects(() => complete(s), httpFailure(503, 'AUTHORITY_UNAVAILABLE'));
    assert.equal(s.reads, 0);assert.equal(s.writerCalls, 0);noEffects(s);
  }
});

test('initial application calls existing writer once with original DTO, claim2, compiled hooks and private witness', async () => {
  const s = fixture(), result = await complete(s);
  assert.equal(s.reads, 1);assert.equal(s.writerCalls, 1);assert.equal(s.writes, 1);
  assert.equal(s.calls.derive, 2);assert.equal(s.calls.normalize, 1);assert.equal(s.calls.owner, 2);
  assert.equal(s.calls.beforeWrite, 1);assert.equal(s.calls.afterWrite, 1);assert.equal(s.calls.context, 1);
  assert.deepEqual(s.job.input.dto, s.originalDto);
  assert.deepEqual(s.job.input.canonicalCompletion, s.witness);
  assert.deepEqual(s.claim.completion, s.witness);assert.equal(Object.isFrozen(s.claim.completion), true);
  assert.deepEqual(result.completion, s.witness);assert.equal(result.generationJobId, s.a.generationJobId);
  assert.deepEqual(result.objectiveReceipt.result, { ...s.saved, savedAt: '2026-10-16T00:00:00.000Z' });
  assert.equal(result.objectiveReceiptSha256, app.applicationHash(result.objectiveReceipt));
  assert.equal(result.snapshotDigest, s.snapshotDigest);
  assert.deepEqual(s.trace, ['retained-read', 'canonical-writer', 'context-before-transaction',
    'original-before-write', 'synthetic-strategy-write', 'original-after-write']);
  assert.equal(s.readerSignal.aborted, true, 'reader cancellation scope closes after read');
  assert.equal(s.calls.forbidden, 0);assert.equal(s.depth, 0);
  await assert.rejects(() => s.runtime.objective.onCompiled({}), e => e.code === 'REQUEST_CONFLICT');
});

test('completed POST replay and GET return same original receipt without reader, writer, context, job or model effects', async () => {
  const s = fixture(), original = await complete(s);
  const before = { reader: s.reads, writer: s.writerCalls, context: s.calls.context, writes: s.writes };
  s.readerError = true;s.contextError = true;
  const replay = await complete(s), lookup = await s.makeService().lookup(s.http, s.body.generationJobId);
  assert.deepEqual(replay, original);assert.deepEqual(lookup, original);
  assert.deepEqual({ reader: s.reads, writer: s.writerCalls, context: s.calls.context, writes: s.writes }, before);
  assert.equal(s.subject.phase, 'completion-read');assert.equal(s.calls.forbidden, 0);
});

test('historical completed receipt recovery does not renew or reuse expired original issuance for effects', async () => {
  const s = fixture(), original = await complete(s);
  s.now = 46_000;
  s.grant = { ...s.grant, checkedAtMs: 45_999, expiresAtMs: 49_000,
    delegationExpiresAtMs: 49_000, claimExpiresAtMs: 49_000 };
  assert.deepEqual(await s.makeService().lookup(s.http, s.body.generationJobId), original);
  assert.equal(s.reads, 1);assert.equal(s.writerCalls, 1);assert.equal(s.writes, 1);
});

test('completed receipt is withheld after current authority revocation without touching original effects', async () => {
  const s = fixture();await complete(s);
  const durable = copy({ job: s.job, producer: s.producer, normalization: s.normalization });
  s.currentError = true;
  await assert.rejects(() => s.makeService().lookup(s.http, s.body.generationJobId),
    httpFailure(503, 'AUTHORITY_UNAVAILABLE'));
  assert.deepEqual({ job: s.job, producer: s.producer, normalization: s.normalization }, durable);
  assert.equal(s.reads, 1);assert.equal(s.writerCalls, 1);assert.equal(s.writes, 1);
  assert.equal(s.calls.forbidden, 0);
});

test('retained custody and context re-observation failures leave zero effects; context IO stays outside database', async () => {
  for (const flag of ['readerError', 'contextError', 'codecError']) {
    const s = fixture();s[flag] = true;
    await assert.rejects(() => complete(s), httpFailure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.reads, 1);noEffects(s);
    if (flag === 'contextError') { assert.equal(s.writerCalls, 1);assert.equal(s.calls.beforeWrite, 0); }
    else assert.equal(s.writerCalls, 0);
  }
});

test('publication or original acceptance changing during retained read refuses before writer', async () => {
  for (const mutate of [s => { s.stored.publicationSha256 = '9'.repeat(64); },
    s => { s.association.acceptance.sourceRequestSha256 = '9'.repeat(64); }]) {
    const s = fixture();s.readerOnRead = mutate;
    await assert.rejects(() => complete(s), httpFailure(409, 'REQUEST_CONFLICT'));
    assert.equal(s.writerCalls, 0);noEffects(s);
  }
});

test('current proof is rechecked after retained read and before and after existing atomic hooks', async () => {
  for (const stage of ['after-read', 'before-write', 'after-write']) {
    const s = fixture();
    if (stage === 'after-read') s.readerOnRead = value => { value.currentError = true; };
    if (stage === 'before-write') s.revokeOnTrace = 'original-before-write';
    if (stage === 'after-write') s.revokeOnTrace = 'original-after-write';
    await assert.rejects(() => complete(s), httpFailure(503, 'AUTHORITY_UNAVAILABLE'));
    noEffects(s);
    if (stage === 'after-read') assert.equal(s.writerCalls, 0);
    else assert.equal(s.writerCalls, 1);
  }
});

test('referenced owner revocation or remap between preparation and writer leaves zero effects', async () => {
  for (const change of ['revoke', 'remap']) {
    const s = fixture();
    s.ownerOnRead = value => {
      if (value.calls.owner !== 2) return;
      if (change === 'revoke') value.ownerRows = value.ownerRows.filter(row => row.clerkUserId !== 'user_owner');
      else value.ownerRows = value.ownerRows.map(row => row.ownerRef === 'owner_ref'
        ? { ...row, clerkUserId: 'user_different' } : row);
    };
    await assert.rejects(() => complete(s), httpFailure(409, 'SOURCE_STALE'));
    assert.equal(s.calls.owner, 2);assert.equal(s.writerCalls, 1);noEffects(s);
  }
});

test('unrelated new owner between preparation and writer does not invalidate referenced owner bindings', async () => {
  const s = fixture();
  s.ownerOnRead = value => {
    if (value.calls.owner === 2) value.ownerRows.push({ ownerRef: 'unrelated_ref', clerkUserId: 'user_unrelated' });
  };
  const result = await complete(s);
  assert.equal(s.calls.owner, 2);assert.equal(s.writerCalls, 1);assert.equal(s.writes, 1);
  assert.equal(result.objectiveReceipt.result.strategyVersionId, s.saved.strategyVersionId);
  assert.deepEqual(s.job.input.canonicalCompletion, s.witness);assert.equal(s.calls.forbidden, 0);
});

test('published principal owner handles padded DTO owner and whitespace-only fallback without rewriting original input', async () => {
  for (const ownerUserId of ['  user_owner  ', '\tuser_owner\n', ' \t ']) {
    const s = fixture();
    s.originalDto.ownerUserId = ownerUserId;
    s.job.input.dto = copy(s.originalDto);
    const authoritativeOwner = ownerUserId.trim() || 'user_original';
    s.stored.publication.request.principal.ownerActorId = authoritativeOwner;
    const originalDto = copy(s.originalDto);
    const result = await complete(s);
    assert.equal(s.stored.publication.request.principal.ownerActorId, authoritativeOwner);
    assert.deepEqual(s.job.input.dto, originalDto);assert.deepEqual(s.claim.input.dto, originalDto);
    assert.equal(s.calls.owner, 2);assert.equal(s.writes, 1);
    assert.equal(result.objectiveReceipt.result.strategyId, s.saved.strategyId);
    assert.equal(s.calls.forbidden, 0);
  }
});

test('retained reader expiry or original issuance/effect expiry refuses application', async () => {
  for (const mutate of [s => { s.rawResult.expiresAtMs = s.now; },
    s => { s.association.acceptance.issuance.expiresAtMs = s.now; },
    s => { s.a.effectExpiresAtMs = s.now; }]) {
    const s = fixture();mutate(s);
    await assert.rejects(() => complete(s), httpFailure(503, 'AUTHORITY_UNAVAILABLE'));
    assert.equal(s.writerCalls, 0);noEffects(s);
  }
});

test('committed application with lost post-commit reply recovers same job/witness/receipt through GET', async () => {
  const s = fixture();s.loseReplyAfterCommit = true;
  await assert.rejects(() => complete(s), httpFailure(503, 'OUTCOME_UNCONFIRMED'));
  assert.equal(s.writes, 1);assert.equal(s.job.status, 'completed');
  const durable = copy(s.producer.objectiveReceipt), privateWitness = copy(s.job.input.canonicalCompletion);
  const recovered = await s.makeService().lookup(s.http, s.body.generationJobId);
  assert.deepEqual(recovered.objectiveReceipt, durable);assert.deepEqual(recovered.completion, privateWitness);
  assert.equal(s.reads, 1);assert.equal(s.writerCalls, 1);assert.equal(s.writes, 1);
  assert.equal(s.calls.forbidden, 0);
});

test('missing/corrupt completion witness or normalization is 503 unknown, never a new application', async () => {
  for (const mutate of [s => { delete s.job.input.canonicalCompletion; },
    s => { s.job.input.canonicalCompletion.corePayloadSha256 = '9'.repeat(64); },
    s => { s.normalization = null; }, s => { s.normalization.schemaVersion = 2; },
    s => { s.normalization.sourceAcceptanceSha256 = '9'.repeat(64); },
    s => { s.normalization.strategyVersionId = id(99); },
    s => { s.normalization.normalizationWitness.proposedPayloadSha256 = '9'.repeat(64); }]) {
    const s = fixture();await complete(s);mutate(s);
    await assert.rejects(() => s.makeService().lookup(s.http, s.body.generationJobId),
      httpFailure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.reads, 1);assert.equal(s.writerCalls, 1);assert.equal(s.writes, 1);
    assert.equal(s.calls.forbidden, 0);
  }
});

test('missing publication or preexisting uncommitted witness remains unknown without new reader/writer', async () => {
  for (const mutate of [s => { s.stored = null; }, s => { s.publicationError = true; },
    s => { s.job.input.canonicalCompletion = copy(s.witness); }]) {
    const s = fixture();mutate(s);
    await assert.rejects(() => complete(s), httpFailure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.reads, 0);assert.equal(s.writerCalls, 0);assert.equal(s.writes, 0);
    assert.equal(s.job.status, 'running');assert.equal(s.calls.forbidden, 0);
  }
});

test('initial codec boundary refuses regeneration basis or private request version before retained IO', async () => {
  for (const mutate of [s => { s.a.expectedStrategyVersionId = id(90); },
    s => { s.stored.publication.request.basis = { strategyVersionId: id(90) }; },
    s => { s.stored.publication.request.requestVersion = 'private-regeneration'; }]) {
    const s = fixture();mutate(s);
    await assert.rejects(() => complete(s), httpFailure(503, 'AUTHORITY_UNAVAILABLE'));
    assert.equal(s.reads, 0);assert.equal(s.writerCalls, 0);noEffects(s);
  }
});

test('retained owner request is aborted at actual service 3000ms ceiling without hanging', { timeout: 5000 }, async () => {
  const s = fixture();let observed;
  const reader = { read: async (_source, { signal }) => { observed = signal;return new Promise(() => {}); } };
  await assert.rejects(() => s.makeService(reader).complete(s.http, s.body), httpFailure(503, 'AUTHORITY_UNAVAILABLE'));
  assert.equal(observed.aborted, true);assert.equal(s.writerCalls, 0);noEffects(s);
});

test('prints exact source custody and explicit synthetic boundary', () => {
  assert.equal(custody.length, 4);
  console.log(JSON.stringify({ qualification: 'synthetic-actual-service-orchestration-only', sourceCustody: custody,
    genuineCustodyAuthorityFrameworkSemanticCompilerNativeDatabase: 'UNQUALIFIED',
    syntheticPorts: ['SQL and rollback model', 'current workload authority', 'retained codec',
      'request/association ledger', 'normalizer', 'context owner', 'existing persistence hooks', 'Strategy writer'],
    applicationSubprocesses: 0, network: false, fileWrites: false }));
});
