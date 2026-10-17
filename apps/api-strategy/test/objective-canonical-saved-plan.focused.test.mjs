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
    if(s.planConsentRevoked)fail('AUTHORITY_UNAVAILABLE');
    if(s.effectUnavailable)fail('AUTHORITY_UNAVAILABLE');
    if(Number.isSafeInteger(s.databaseNowMs)&&[grant.tokenExpiresAtMs,grant.delegationExpiresAtMs,grant.claimExpiresAtMs]
      .some(deadline=>!Number.isSafeInteger(deadline)||deadline<=s.databaseNowMs)){
      s.expiryFenceRefusals=(s.expiryFenceRefusals??0)+1;fail('AUTHORITY_UNAVAILABLE');
    }
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

// Actual mounted-runtime composition. Framework, completed-source ledger,
// database serialization/rollback and existing native/fence/materializer owner
// ports remain synthetic; the runtime, operation store, local authority adapter,
// worker, continuation helper, application service and kernel are actual source.
const runtimeFrameworkUrl = data(`export const Injectable=()=>value=>value;
  export class ConfigService{};export class BadRequestException extends Error{};
  export class ConflictException extends Error{};export const STRATEGY_TYPES=[];
  export class Logger{warn(){}};`);
const runtimeGenerationUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
]);
const runtimeGeneration = await import(runtimeGenerationUrl);
const runtimeTypesUrl = await sourceModule('../src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", runtimeFrameworkUrl], ["'../strategy/dto/create-strategy.dto.js'", runtimeFrameworkUrl],
]);
const runtimeProducerUrl = await sourceModule('../src/meri/objective-canonical-producer.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-generation.js'", runtimeGenerationUrl], ["'./objective-generation.types.js'", runtimeTypesUrl],
]);
const runtimeProducer = await import(runtimeProducerUrl);
const continuationUrl = await sourceModule('../src/planner/objective-canonical-continuation.ts', [
  ["'../meri/objective-canonical-producer.js'", runtimeProducerUrl],
  ["'../meri/objective-canonical-saved-generation.js'", savedUrl], ["'./objective-canonical-application.js'", appUrl],
]);
const storeUrl = await sourceModule('../src/planner/objective-planner-continuation.store.ts', [
  ["'../meri/objective-canonical-producer.js'", runtimeProducerUrl], ["'./objective-canonical-application.js'", appUrl],
]);
const runtimeStore = await import(storeUrl);
const runtimeAuthorityUrl = await sourceModule('../src/planner/objective-planner-continuation.authority.ts', [
  ["'../meri/objective-canonical-saved-generation.js'", savedUrl],
  ["'./objective-canonical-application.js'", appUrl], ["'../meri/objective-canonical-producer.js'", runtimeProducerUrl],
  ["'./objective-canonical-continuation.js'", continuationUrl], ["'./objective-canonical-fence.js'", portsUrl],
  ["'./objective-planner-continuation.store.js'", storeUrl],
]);
const runtimeAuthority = await import(runtimeAuthorityUrl);
const runtimeUrl = await sourceModule('../src/planner/objective-planner-continuation.runtime.ts', [
  ["'@nestjs/common'", runtimeFrameworkUrl], ["'@nestjs/config'", runtimeFrameworkUrl],
  ["'../prisma/prisma.service.js'", portsUrl], ["'../meri/objective-canonical-generation.js'", runtimeGenerationUrl],
  ["'../meri/objective-canonical-saved-generation.js'", savedUrl], ["'../meri/objective-canonical-producer.js'", runtimeProducerUrl],
  ["'./objective-canonical-application.service.js'", serviceUrl], ["'./objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-continuation.js'", continuationUrl], ["'./objective-planner-continuation.store.js'", storeUrl],
  ["'./objective-planner-continuation.authority.js'", runtimeAuthorityUrl],
  ["'./objective-canonical-fence.js'", portsUrl],
  ["'./strategy-materialization.js'", portsUrl],
], true, 'transform');
const { ObjectivePlannerContinuationRuntime } = await import(runtimeUrl);
const workerUrl = await sourceModule('../src/planner/objective-planner-continuation.worker.ts', [
  ["'@nestjs/common'", runtimeFrameworkUrl], ["'../prisma/prisma.service.js'", portsUrl],
  ["'./objective-planner-continuation.runtime.js'", runtimeUrl],
], true, 'transform');
const { ObjectivePlannerContinuationWorker } = await import(workerUrl);

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

function runtimeFixture(enabled = true, sourceCaps = {}) {
  const s = fixture(), ms = Date.parse(at), c = s.a.canonical;
  Object.assign(s.a, { namespace: runtimeGeneration.GENERATION_ADMISSION_NAMESPACE,
    admittedAtMs: ms - 2_000, effectExpiresAtMs: ms + (sourceCaps.admissionMs ?? 50_000) });
  const binding = s.association.acceptance.sourceBinding;
  s.association = { admission: s.a, acceptance: { schemaVersion: 1,
    sourceAdmissionSha256: runtimeGeneration.canonicalGenerationAdmissionSha256(s.a), sourceBinding: binding,
    sourceRequestSha256: 'b'.repeat(64), acceptedAtMs: ms - 1_000,
    issuance: { issuanceKey: runtimeGeneration.generationBindingKey(binding), binding,
      requestSha256: 'b'.repeat(64), expiresAtMs: ms + (sourceCaps.issuanceMs ?? 45_000), grantId: id(55),
      capabilitySha256: 'c'.repeat(64), factsSha256: 'd'.repeat(64) } } };
  s.producer = runtimeProducer.canonicalGenerationProducer({ admission: s.a, acceptance: s.association.acceptance,
    jobId: id(10), requestId: id(11), attempt: 2, coreFingerprint: 'b'.repeat(64),
    receipt: s.producer.objectiveReceipt, strategyId: id(5), strategyVersionId: id(12), snapshotDigest: s.producer.snapshotDigest });
  s.normalization.sourceAdmissionSha256 = app.applicationHash(s.a);
  s.normalization.sourceAcceptanceSha256 = app.applicationHash(s.association.acceptance);
  s.runtimeEnabled = enabled;s.databaseNowMs = ms;s.membershipId = id(56);s.runtimeTxRequested = 0;
  s.consentDeadlineMs = ms + (sourceCaps.consentMs ?? 20_000);
  s.runtimeMetrics = { operationInserts: 0, claims: 0, finalizations: 0, nativeChecks: 0, systemReads: 0 };
  s.scope = { tenantId: id(2), clerkUserId: 'user_original', generationJobId: id(10) };
  s.durable.resources.set(id(57), { id: id(57), tenantId: id(2), ownerId: 'user_original', projectId: null,
    kind: runtimeGeneration.GENERATION_PRODUCER, name: 'Synthetic completed source owner row', data: copy(s.producer),
    version: 1, archived: false, shareTokenHash: null });
  const executeRaw = s.tx.$executeRaw, queryRaw = s.tx.$queryRaw, create = s.tx.spPlannerResource.create;
  s.tx.$executeRaw = async (strings, ...values) => {
    if (strings.join('?').includes('pg_advisory_xact_lock')) {
      assert.equal(s.depth, 1);assert.deepEqual(values, ['planner:' + s.currentTenant]);s.trace.push('planner-lock');return 1;
    }
    return executeRaw(strings, ...values);
  };
  s.tx.$queryRaw = async (strings, ...values) => {
    const sql = strings.join('?').replace(/\s+/g, ' ');assert.equal(s.depth, 1);
    if (sql.includes('FROM sp_draft_job') && sql.includes("status='completed'")) {
      s.trace.push('runtime-job-share-lock');
      return values[0] === id(2) && values[1] === id(10) && values[2] === 'user_original' && !s.jobMissing && s.job.status === 'completed'
        ? [{ id: id(10) }] : [];
    }
    if (sql.includes('FROM sp_strategy') && sql.includes('FOR SHARE')) {
      assert.deepEqual(values, [c.tenantId, c.clientId, s.request.strategyId]);
      s.trace.push('strategy-share-lock');return s.strategyMissing ? [] : [{ id: s.request.strategyId }];
    }
    if (sql.includes('FROM sp_version') && sql.includes('FOR SHARE')) {
      assert.deepEqual(values.slice(0, 2), [c.tenantId, s.request.strategyId]);
      s.trace.push('saved-version-share-lock');
      return !s.versionMissing && (values[2] === s.request.strategyVersionId || s.extraStrategyVersionIds?.includes(values[2]))
        ? [{ id: values[2] }] : [];
    }
    if (sql.includes('EXISTS') && sql.includes('FROM sp_planner_projects') && sql.includes('FROM sp_planner_tasks')) {
      assert.deepEqual(values, [c.tenantId, c.canonicalProjectId, c.tenantId, c.canonicalProjectId]);
      assert.equal(sql.includes('archived'), false, 'orphan proof includes archived outputs');
      return [{ present: !!s.orphanProject || !!s.orphanTask || s.durable.projects.length > 0 || s.durable.tasks.length > 0 }];
    }
    if (sql.includes('FROM client_objective_work_controls') && sql.includes('JOIN client_objective_work_consents')) {
      assert.deepEqual(values, [c.tenantId, c.clientId, c.objectiveId, s.a.actorUserId, c.canonicalPlanId,
        c.epoch, c.canonicalStrategyId, c.canonicalProjectId, c.bindingVersion, c.requestedIntentId,
        c.requestedObjectiveRevisionId, c.requestedObjectiveVersion, c.snapshotHash]);
      return s.planConsentRevoked ? [] : [{ consentId: s.grant.consentId, controlVersion: s.grant.controlVersion,
        membershipId: s.membershipId, expiresAtMs: String(s.consentDeadlineMs ?? ms + 20_000) }];
    }
    if (sql.includes('FROM client_objective_work_controls')) {
      assert.deepEqual(values, [c.tenantId, c.clientId, c.objectiveId]);
      return [{ version: s.grant.controlVersion, consentId: s.planConsentRevoked ? null : s.grant.consentId,
        cancelled: !!s.planConsentRevoked }];
    }
    if (sql.includes('FROM client_objectives')) {
      assert.deepEqual(values, [c.tenantId, c.clientId, c.objectiveId]);
      return [{ version: c.requestedObjectiveVersion + (s.staleObjective ? 1 : 0), status: 'ready' }];
    }
    if (sql.includes('FROM tenant_memberships')) {
      s.runtimeMetrics.nativeChecks++;
      assert.deepEqual(values, [c.tenantId, s.membershipId, s.a.actorUserId, s.a.clerkUserId]);
      assert.deepEqual(s.trace.slice(-2), ['strategy-share-lock', 'saved-version-share-lock']);
      s.trace.push('native-core-share-lock');
      return s.nativeRevoked || s.nativeRevokedAfterOwner && s.durable.owner ? [] : [{ id: s.membershipId }];
    }
    if (sql.includes('AS ms')) return [{ ms: String(s.databaseNowMs) }];
    if (sql.includes('clock_timestamp()')) return [{ now: new Date(s.databaseNowMs) }];
    return queryRaw(strings, ...values);
  };
  const matches = (row, where) => {
    if (row.tenantId !== s.currentTenant) return false;
    for (const [key, expected] of Object.entries(where)) {
      if (key === 'data') {
        const actual = expected.path?.reduce((v, part) => v?.[part], row.data) ?? row.data;
        if (app.applicationHash(actual) !== app.applicationHash(expected.equals)) return false;
      } else if (key === 'id' && typeof expected === 'object') {
        if (expected.gt !== undefined && row.id <= expected.gt) return false;
      } else if (row[key] !== expected) return false;
    }
    return true;
  };
  s.tx.spPlannerResource.findFirst = async ({ where }) => {
    assert.equal(s.depth, 1);const row = s.durable.resources.get(where.id);
    return row && matches(row, where) ? copy(row) : null;
  };
  s.tx.spPlannerResource.findMany = async ({ where, take }) => {
    assert.equal(s.depth, 1);
    return [...s.durable.resources.values()].filter(row => matches(row, where))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map(copy);
  };
  s.tx.spPlannerResource.create = async ({ data: raw }) => {
    assert.equal(raw.tenantId, s.currentTenant);
    const row = { projectId: null, shareTokenHash: null, archived: false, version: 1, ...copy(raw) };
    if (row.kind !== runtimeStore.PLANNER_CONTINUATION_OPERATION) return create({ data: row });
    assert.equal(s.depth, 1);assert.equal(s.durable.resources.has(row.id), false);
    s.runtimeMetrics.operationInserts++;s.durable.resources.set(row.id, row);return copy(row);
  };
  s.tx.spPlannerResource.updateMany = async ({ where, data: next }) => {
    assert.equal(s.depth, 1);const row = s.durable.resources.get(where.id);
    if (!row || !matches(row, where)) return { count: 0 };
    assert.equal(row.kind, runtimeStore.PLANNER_CONTINUATION_OPERATION);
    if (next.data.state === 'applied') {
      s.runtimeMetrics.finalizations++;s.finalizationSawOutputs = !!s.durable.owner && s.durable.receiptWrites === 1 && s.durable.headWrites === 1;
      if (s.failFinalization) return { count: 0 };
    } else if (next.data.state === 'leased') s.runtimeMetrics.claims++;
    const changed = { ...row, data: copy(next.data), version: row.version + next.version.increment };
    s.durable.resources.set(row.id, changed);
    if (s.expireDuringAccounting && next.data.state === 'applied') {
      // Only the synthetic database clock moves. The saved admission,
      // acceptance/publication, receipt and original operation stay unchanged.
      s.databaseNowMs = Date.parse(changed.data.original.originalDeadlineAt);
      s.accountingCASAdvancedClock = true;
    }
    if (s.loseAppliedReply && next.data.state === 'applied') s.pendingLostReply = true;
    return { count: 1 };
  };
  // Explicit synthetic serialization/rollback: this is not PostgreSQL or an
  // advisory-lock/RLS qualification. Each runtime invocation uses actual store
  // read/insert/CAS logic over these transaction-local resource rows.
  let tail = Promise.resolve();
  s.db.withTenant = async (tenant, run, options = { timeoutMs: 15_000 }) => {
    const call = ++s.runtimeTxRequested;await s.beforeRuntimeTransaction?.(call);
    let release;const previous = tail;tail = new Promise(resolve => { release = resolve; });await previous;
    assert.equal(s.depth, 0);assert.equal(options.timeoutMs, 15_000);
    const before = copy(s.durable);s.currentTenant = tenant;s.depth = 1;
    try {
      let result;
      try { result = await run(s.tx); } catch (error) { s.durable = before;throw error; }
      if (s.pendingLostReply) { s.pendingLostReply = false;s.loseAppliedReply = false;throw Error('Synthetic committed runtime reply lost'); }
      return result;
    } finally { s.depth = 0;s.currentTenant = null;release(); }
  };
  s.db.withSystem = async run => {
    s.runtimeMetrics.systemReads++;
    return run({ $queryRaw: async () => [{ tenantId: id(2) }] });
  };
  s.config = { get: key => key === 'OBJECTIVE_PLANNER_CONTINUATION_ENABLED' && s.runtimeEnabled ? 'true' : undefined };
  s.runtime = new ObjectivePlannerContinuationRuntime(s.db, nativeService(s), s.config);
  s.newRuntime = () => new ObjectivePlannerContinuationRuntime(s.db, nativeService(s), s.config);
  s.operations = () => [...s.durable.resources.values()].filter(row => row.kind === runtimeStore.PLANNER_CONTINUATION_OPERATION);
  return s;
}
const sourceEvidence = s => copy({ admission: s.a, association: s.association, producer: s.producer,
  normalization: s.normalization, publication: s.publication, job: s.job });
function orphanEvidence(s, kind) {
  if (kind === 'owner') {
    const receiptId = canonicalMaterializationReceiptId(id(2), 'user_original', s.request.applicationRequestId);
    s.durable.resources.set(receiptId, { id: receiptId, tenantId: id(2), ownerId: 'user_original',
      kind: 'objective_canonical_materialization_receipt', projectId: null, name: 'Deliberate synthetic orphan owner evidence',
      archived: true, shareTokenHash: null, version: 1, data: { orphan: true } });
  } else if (kind === 'project') s.orphanProject = 'archived';
  else if (kind === 'task') s.orphanTask = 'archived';
  else assert.fail('unknown deliberate orphan scenario');
}
async function runtimeTerminalFixture(outcome) {
  const s = runtimeFixture();s.failFinalization = true;
  await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError);
  s.failFinalization = false;const [row] = s.operations();
  await s.db.withTenant(id(2), async tx => {
    const stored = await runtimeStore.readPlannerContinuationOperationWithinTx(tx,
      { tenantId: id(2), clerkUserId: 'user_original', operationId: row.id });
    return runtimeStore.finalizePlannerContinuationOperationWithinTx(tx, stored, { state: outcome,
      terminalReceiptId: row.id, leaseToken: stored.data.lease.token, nowMs: s.databaseNowMs });
  });
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
function nativeService(s) {
  const forbidden = () => { throw Error('Internal composition must not verify/fabricate HTTP or open a nested transaction'); };
  return new ObjectiveCanonicalApplicationService({ withTenant: forbidden }, s.planner,
    { verify: forbidden, assertCurrent: forbidden });
}
const ownerTransaction = (s, run) => s.db.withTenant(id(2), run, { timeoutMs: 15_000 });

test('public prepare and lookup retain exact HTTP verifier before entering the shared owner transaction', async () => {
  for (const action of ['prepare', 'lookup']) {
    const s = fixture();if (action === 'lookup') await prepare(s);
    const trace = [], verify = s.authority.verify, withTenant = s.db.withTenant;
    s.authority.verify = async (http, subject) => {
      assert.equal(http, s.http);assert.equal(s.depth, 0);trace.push('verify');
      assert.equal(subject.purpose, action === 'prepare' ? 'effect' : 'retained-result-read');
      assert.equal(subject.applicationRequestId, s.request.applicationRequestId);
      assert.equal(subject.requestSha256, action === 'prepare' ? app.applicationHash(s.request) : null);
      return verify(http, subject);
    };
    s.db.withTenant = async (...args) => { trace.push('transaction');return withTenant(...args); };
    await (action === 'prepare' ? prepare(s) : lookup(s));
    assert.deepEqual(trace, ['verify', 'transaction']);
  }
});

test('public verifier refusal prevents a transaction for either HTTP endpoint', async () => {
  for (const action of ['prepare', 'lookup']) {
    const s = fixture();let transactions = 0;
    s.authority.verify = async http => {
      assert.equal(http, s.http);assert.equal(s.depth, 0);throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
    };
    s.db.withTenant = async () => { transactions++;throw Error('Denied verifier must not enter transaction'); };
    await assert.rejects(() => action === 'prepare' ? prepare(s) : lookup(s), failure(503, 'AUTHORITY_UNAVAILABLE'));
    assert.equal(transactions, 0);noPlannerEffects(s);
  }
});

test('internal prepare reuses actual saved source/kernel/owner in caller transaction with all four native release gates', async () => {
  const s = fixture(), internal = nativeService(s), subjects = [];
  const result = await ownerTransaction(s, async tx => {
    assert.equal(tx, s.tx);
    const observation = await internal.prepareWithinOwnerTransaction(tx, s.request, s.grant, async subject => {
      assert.equal(s.depth, 1);subjects.push(copy(subject));
      if (subjects.length === 4) {
        assert.equal(s.durable.receiptWrites, 1);assert.equal(s.durable.headWrites, 1);
        assert.deepEqual(s.durable.projects, [id(6)]);assert.deepEqual(s.durable.tasks, [id(30), id(31)]);
      }
    });
    // The durable runtime owner can account for its operation before this SAME
    // outer transaction commits; this test does not install a private ledger.
    s.durable.runtimeAccounted = true;
    return observation;
  });
  assert.equal(result.creation.ack.applicationRequestId, s.request.applicationRequestId);
  assert.equal(s.durable.runtimeAccounted, true);assert.equal(subjects.length, 4);
  assert.ok(subjects.every(subject => subject.purpose === 'effect' && subject.applicationRequestId === s.request.applicationRequestId &&
    subject.requestSha256 === app.applicationHash(s.request)));
  assert.equal(s.calls.verify, 0);assert.equal(s.calls.current, 0);assert.equal(s.calls.ownerPrepare, 1);
  assert.equal(s.calls.effectFence, 3);assert.ok(s.calls.job > 0);assert.deepEqual(s.job, s.originalJob);
});

test('internal prepare native release refusal escapes and rolls back owner outputs plus application receipt/head', async () => {
  const s = fixture(), internal = nativeService(s);let gates = 0;
  await assert.rejects(() => ownerTransaction(s, tx => internal.prepareWithinOwnerTransaction(tx, s.request, s.grant, async () => {
    gates++;
    if (gates === 4) {
      assert.equal(s.durable.receiptWrites, 1);assert.equal(s.durable.headWrites, 1);
      throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
    }
  })), error => error instanceof app.CanonicalApplicationError && error.code === 'AUTHORITY_UNAVAILABLE');
  assert.equal(gates, 4);assert.equal(s.calls.ownerPrepare, 1);assert.equal(s.calls.current, 0);noPlannerEffects(s);
});

test('internal prepare replay uses the injected retained-read callback and preserves expired/stale-source human work', async () => {
  const s = fixture(), original = await prepare(s), internal = nativeService(s), subjects = [];
  const reads = s.calls.job, effects = s.calls.effectFence, before = copy(s.durable);
  s.forbidSavedReads = true;s.staleObjective = true;s.effectUnavailable = true;
  s.grant.tokenExpiresAtMs = 0;s.grant.delegationExpiresAtMs = 0;s.grant.claimExpiresAtMs = 0;
  s.current = copy(s.durable.owner.result);s.current.projects[0].name = 'Preserved native human edit';
  s.current.projects[0].output.currentVersion = 9;
  const result = await ownerTransaction(s, tx => internal.prepareWithinOwnerTransaction(tx, s.request, s.grant,
    async subject => { subjects.push(copy(subject)); }));
  assert.deepEqual(result.creation, original.creation);assert.equal(result.current.projects[0].output.currentVersion, 9);
  assert.equal(result.current.projects[0].name, 'Preserved native human edit');assert.equal(subjects.length, 2);
  assert.ok(subjects.every(subject => subject.purpose === 'retained-result-read' && subject.requestSha256 === app.applicationHash(s.request)));
  assert.equal(s.calls.job, reads);assert.equal(s.calls.effectFence, effects);assert.deepEqual(s.durable, before);
  assert.equal(s.calls.ownerPrepare, 1);
});

test('internal lookup checks full original command and native retained-read admission/observation/release in the same transaction', async () => {
  const s = fixture(), original = await prepare(s), internal = nativeService(s), subjects = [];
  const reads = s.calls.job, effects = s.calls.effectFence, before = copy(s.durable);
  s.forbidSavedReads = true;s.staleObjective = true;s.current = copy(s.durable.owner.result);
  s.current.tasks[0].output.currentVersion = 8;
  const result = await ownerTransaction(s, tx => internal.lookupWithinOwnerTransaction(tx, s.request, s.grant, async subject => {
    assert.equal(s.depth, 1);subjects.push(copy(subject));
    if (subjects.length === 3) assert.ok(s.calls.ownerObserve > 0);
  }));
  assert.deepEqual(result.creation, original.creation);assert.equal(result.current.tasks[0].output.currentVersion, 8);
  assert.equal(subjects.length, 3);
  assert.ok(subjects.every(subject => subject.purpose === 'retained-result-read' && subject.applicationRequestId === s.request.applicationRequestId &&
    subject.requestSha256 === app.applicationHash(s.request)));
  assert.equal(s.calls.job, reads);assert.equal(s.calls.effectFence, effects);assert.deepEqual(s.durable, before);
  assert.equal(s.calls.ownerPrepare, 1);
});

test('internal lookup current-read revocation at release escapes without prepare or source reads', async () => {
  const s = fixture();await prepare(s);const internal = nativeService(s), before = copy(s.durable), reads = s.calls.job;let gates = 0;
  s.forbidSavedReads = true;
  await assert.rejects(() => ownerTransaction(s, tx => internal.lookupWithinOwnerTransaction(tx, s.request, s.grant, async () => {
    gates++;if (gates === 3) throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  })), error => error instanceof app.CanonicalApplicationError && error.code === 'AUTHORITY_UNAVAILABLE');
  assert.equal(gates, 3);assert.deepEqual(s.durable, before);assert.equal(s.calls.job, reads);assert.equal(s.calls.ownerPrepare, 1);
});

test('both internal methods refuse a substituted original command before owner locking or native authority callback', async () => {
  for (const method of ['prepareWithinOwnerTransaction', 'lookupWithinOwnerTransaction']) {
    const s = fixture(), internal = nativeService(s), substituted = { ...s.request, strategyVersionId: id(99) };let gates = 0;
    await assert.rejects(() => ownerTransaction(s, tx => internal[method](tx, substituted, s.grant, async () => { gates++; })),
      error => error instanceof app.CanonicalApplicationError && error.code === 'REQUEST_CONFLICT');
    assert.equal(gates, 0);assert.deepEqual(s.trace, []);noPlannerEffects(s);
  }
});

test('both internal methods require a native authority callback before owner locking or any default verifier path', async () => {
  for (const method of ['prepareWithinOwnerTransaction', 'lookupWithinOwnerTransaction']) {
    const s = fixture(), internal = nativeService(s);
    await assert.rejects(() => ownerTransaction(s, tx => internal[method](tx, s.request, s.grant, undefined)),
      error => error instanceof app.CanonicalApplicationError && error.code === 'AUTHORITY_UNAVAILABLE');
    assert.deepEqual(s.trace, []);assert.equal(s.calls.current, 0);noPlannerEffects(s);
  }
});

test('internal Planner owner failure remains the exact escaping error and rolls back the outer owner transaction', async () => {
  const s = fixture(), internal = nativeService(s), error = new Error('Synthetic owner failure after its outputs');s.ownerError = error;
  await assert.rejects(() => ownerTransaction(s, tx => internal.prepareWithinOwnerTransaction(tx, s.request, s.grant, async () => {})),
    observed => observed === error);
  assert.equal(s.calls.ownerPrepare, 1);noPlannerEffects(s);
});

test('internal missing original application is uncertainty and never permission for an effect', async () => {
  const s = fixture(), internal = nativeService(s);let gates = 0;
  await assert.rejects(() => ownerTransaction(s, tx => internal.lookupWithinOwnerTransaction(tx, s.request, s.grant, async () => { gates++; })),
    error => error instanceof app.CanonicalApplicationError && error.code === 'OUTCOME_UNCONFIRMED');
  assert.equal(gates, 1);assert.equal(s.calls.ownerPrepare, 0);assert.equal(s.calls.job, 0);noPlannerEffects(s);
});

test('actual runtime consumes saved source through the actual internal application/kernel and accounts outputs in one transaction', async () => {
  const s = runtimeFixture(), result = await s.runtime.consumeJob(s.scope), [row] = s.operations();
  assert.equal(result.outcome, 'applied');assert.equal(result.recovered, false);
  assert.equal(s.calls.ownerPrepare, 1);assert.equal(s.calls.verify, 0);assert.equal(s.calls.current, 0);
  assert.ok(s.calls.job >= 2);assert.ok(s.calls.effectFence >= 3);assert.ok(s.runtimeMetrics.nativeChecks >= 4);
  assert.equal(s.runtimeMetrics.operationInserts, 1);assert.equal(s.runtimeMetrics.claims, 1);assert.equal(s.runtimeMetrics.finalizations, 1);
  assert.deepEqual(s.trace.slice(0, 5), ['planner-lock', 'runtime-job-share-lock', 'strategy-share-lock',
    'saved-version-share-lock', 'native-core-share-lock']);
  assert.equal(s.finalizationSawOutputs, true);assert.equal(row.version, 3);assert.equal(row.data.state, 'applied');
  assert.equal(row.data.lease, null);assert.equal(row.data.work.consentId, s.grant.consentId);
  assert.notEqual(row.data.work.consentId, s.a.consentId);
  assert.equal(row.data.terminal.receiptId, app.applicationReceiptId(id(2), 'user_original', s.request.applicationRequestId));
  assert.deepEqual(s.durable.projects, [id(6)]);assert.deepEqual(s.durable.tasks, [id(30), id(31)]);
  assert.equal(s.durable.receiptWrites, 1);assert.equal(s.durable.headWrites, 1);assert.deepEqual(s.job, s.originalJob);
});

test('exact Strategy and saved-version row locks are required before native/Core grant checks', async () => {
  for (const missing of ['strategyMissing', 'versionMissing']) {
    const s = runtimeFixture();s[missing] = true;
    await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError && error.code === 'AUTHORITY_UNAVAILABLE');
    assert.equal(s.runtimeMetrics.nativeChecks, 0);assert.equal(s.calls.ownerPrepare, 0);assert.equal(s.operations().length, 0);
    assert.deepEqual(s.trace.slice(0, 4), ['planner-lock', 'runtime-job-share-lock', 'strategy-share-lock', 'saved-version-share-lock']);
  }
});

test('orphan canonical owner receipt or archived project/task output prevents new runtime admission and writer', async () => {
  for (const kind of ['owner', 'project', 'task']) {
    const s = runtimeFixture(), evidence = sourceEvidence(s);orphanEvidence(s, kind);const before = copy(s.durable);
    await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError && error.code === 'OUTCOME_UNCONFIRMED');
    assert.equal(s.runtimeMetrics.operationInserts, 0);assert.equal(s.runtimeMetrics.claims, 0);assert.equal(s.calls.ownerPrepare, 0);
    assert.equal(s.operations().length, 0);assert.deepEqual(s.durable, before);assert.deepEqual(sourceEvidence(s), evidence);
  }
});

test('orphan owner/output evidence prevents lease reclaim and false failed/cancelled terminal accounting', async () => {
  for (const phase of ['reclaim', 'cancel', 'stale']) for (const kind of ['owner', 'project', 'task']) {
    const s = runtimeFixture(true, { consentMs: 90_000 });s.failFinalization = true;
    await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError);
    s.failFinalization = false;orphanEvidence(s, kind);
    if (phase === 'reclaim') s.databaseNowMs += 31_000;
    else if (phase === 'cancel') s.planConsentRevoked = true;
    else s.staleObjective = true;
    const before = copy(s.durable), original = copy(s.operations()[0].data.original), claims = s.runtimeMetrics.claims;
    await assert.rejects(() => s.newRuntime().consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError && error.code === 'OUTCOME_UNCONFIRMED');
    assert.deepEqual(s.durable, before);assert.deepEqual(s.operations()[0].data.original, original);
    assert.equal(s.operations()[0].data.state, 'leased');assert.equal(s.operations()[0].data.terminal, null);
    assert.equal(s.runtimeMetrics.operationInserts, 1);assert.equal(s.runtimeMetrics.claims, claims);assert.equal(s.calls.ownerPrepare, 1);
  }
});

test('actual operation finalization CAS failure rolls back application outputs, receipts and head together', async () => {
  const s = runtimeFixture();s.failFinalization = true;
  await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError);
  const [row] = s.operations();assert.equal(row.data.state, 'leased');assert.equal(row.version, 2);assert.equal(row.data.terminal, null);
  assert.equal(s.finalizationSawOutputs, true);assert.equal(s.runtimeMetrics.finalizations, 1);assert.equal(s.calls.ownerPrepare, 1);
  assert.deepEqual(s.durable.projects, []);assert.deepEqual(s.durable.tasks, []);assert.equal(s.durable.owner, null);
  assert.equal(s.durable.receiptWrites, 0);assert.equal(s.durable.headWrites, 0);
  assert.equal(s.durable.resources.size, 2, 'only completed source and original leased operation survive');
});

test('committed lost runtime reply reconciles actual applied row and original application without a second writer', async () => {
  const s = runtimeFixture();s.loseAppliedReply = true;
  const recovered = await s.runtime.consumeJob(s.scope), before = copy(s.durable), original = copy(s.operations()[0].data.original);
  assert.equal(recovered.outcome, 'applied');assert.equal(recovered.recovered, true);
  assert.equal(s.calls.ownerPrepare, 1);assert.equal(s.runtimeMetrics.finalizations, 1);
  const again = await s.newRuntime().consumeJob(s.scope);
  assert.equal(again.recovered, true);assert.deepEqual(s.durable, before);assert.deepEqual(s.operations()[0].data.original, original);
  assert.equal(s.runtimeMetrics.operationInserts, 1);assert.equal(s.runtimeMetrics.claims, 1);assert.equal(s.calls.ownerPrepare, 1);
});

test('two actual runtime consumers cannot adopt one another active committed lease', async () => {
  const s = runtimeFixture();let release, paused;
  const hold = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { paused = resolve; });
  s.beforeRuntimeTransaction = async call => { if (call === 2) { paused();await hold; } };
  const first = s.runtime.consumeJob(s.scope);await observed;
  const [leased] = s.operations(), token = leased.data.lease.token, original = copy(leased.data.original);
  try {
    await assert.rejects(() => s.newRuntime().consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError);
    assert.equal(s.calls.ownerPrepare, 0);assert.equal(s.operations()[0].data.lease.token, token);
    assert.equal(s.runtimeMetrics.claims, 1);assert.deepEqual(s.operations()[0].data.original, original);
  } finally { release(); }
  assert.equal((await first).outcome, 'applied');assert.equal(s.calls.ownerPrepare, 1);
  assert.equal(s.runtimeMetrics.operationInserts, 1);assert.equal(s.runtimeMetrics.finalizations, 1);
});

test('two actual worker instances retain active lease ownership while the first pass is paused', async () => {
  const s = runtimeFixture(), firstWorker = new ObjectivePlannerContinuationWorker(s.db, s.runtime),
    secondWorker = new ObjectivePlannerContinuationWorker(s.db, s.newRuntime());let release, paused;
  const hold = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { paused = resolve; });
  // Worker discovery is the first tx, source admission/first lease the second.
  s.beforeRuntimeTransaction = async call => { if (call === 3) { paused();await hold; } };
  const first = firstWorker.tick();await observed;const token = s.operations()[0].data.lease.token;
  try {
    await secondWorker.tick();
    assert.equal(s.calls.ownerPrepare, 0);assert.equal(s.operations()[0].data.lease.token, token);
    assert.equal(s.runtimeMetrics.claims, 1);assert.equal(s.runtimeMetrics.operationInserts, 1);
  } finally { release(); }
  await first;assert.equal(s.calls.ownerPrepare, 1);assert.equal(s.operations()[0].data.state, 'applied');
  assert.equal(s.runtimeMetrics.systemReads, 2);assert.equal(s.runtimeMetrics.finalizations, 1);
});

test('expired local lease recovery keeps original operation attempt/run/fingerprint/deadline and writes only once after rollback', async () => {
  const s = runtimeFixture();s.consentDeadlineMs = Date.parse(at) + 90_000;s.failFinalization = true;
  await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError);
  const original = copy(s.operations()[0].data.original), token = s.operations()[0].data.lease.token;
  s.failFinalization = false;s.databaseNowMs += 31_000;
  const result = await s.newRuntime().consumeJob(s.scope), [applied] = s.operations();
  assert.equal(result.outcome, 'applied');assert.deepEqual(applied.data.original, original);
  assert.equal(applied.data.original.originalDeadlineAt,
    new Date(Math.min(s.consentDeadlineMs, s.a.effectExpiresAtMs, s.association.acceptance.issuance.expiresAtMs)).toISOString());
  assert.equal(applied.data.state, 'applied');assert.equal(applied.version, 4);assert.equal(applied.data.lease, null);
  assert.equal(s.runtimeMetrics.operationInserts, 1);assert.equal(s.runtimeMetrics.claims, 2);
  assert.equal(s.calls.ownerPrepare, 2, 'first writer attempt rolled back completely');
  assert.equal(s.durable.receiptWrites, 1);assert.equal(s.durable.headWrites, 1);assert.deepEqual(s.durable.projects, [id(6)]);
  assert.notEqual(token, null);
});

test('actual runtime fixes the original deadline to the minimum of Planner consent and both immutable saved caps', async () => {
  for (const caps of [{ consentMs: 20_000, admissionMs: 50_000, issuanceMs: 45_000 },
    { consentMs: 90_000, admissionMs: 45_000, issuanceMs: 45_000 },
    { consentMs: 90_000, admissionMs: 50_000, issuanceMs: 40_000 }]) {
    const s = runtimeFixture(true, caps), evidence = sourceEvidence(s);
    assert.equal((await s.runtime.consumeJob(s.scope)).outcome, 'applied');
    assert.equal(s.operations()[0].data.original.originalDeadlineAt,
      new Date(Date.parse(at) + Math.min(caps.consentMs, caps.admissionMs, caps.issuanceMs)).toISOString());
    assert.deepEqual(sourceEvidence(s), evidence, 'captured admission/acceptance and saved result were never rewritten');
  }
});

test('fresh Planner consent cannot renew an expired immutable saved issuance cap', async () => {
  const s = runtimeFixture(true, { consentMs: 90_000 }), evidence = sourceEvidence(s);
  s.grant.consentId = id(58);s.grant.controlVersion++;
  s.databaseNowMs = s.association.acceptance.issuance.expiresAtMs;
  await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError);
  assert.equal(s.calls.ownerPrepare, 0);assert.equal(s.operations().length, 0);
  assert.deepEqual(s.durable.projects, []);assert.deepEqual(sourceEvidence(s), evidence);
});

test('actual effect grants re-read immutable saved custody on each grant and cannot proceed from a cached admission', async () => {
  const s = runtimeFixture();s.failFinalization = true;
  await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError);
  const evidence = sourceEvidence(s), [row] = s.operations(), before = copy(s.durable);
  for (let i = 0; i < 2; i++) {
    const reads = s.calls.job;
    await s.db.withTenant(id(2), async tx => {
      const stored = await runtimeStore.readPlannerContinuationOperationWithinTx(tx,
        { tenantId: id(2), clerkUserId: 'user_original', operationId: row.id });
      await runtimeAuthority.plannerContinuationGrantWithinTx(tx, stored, 'effect', stored.data.lease.token);
    });
    assert.ok(s.calls.job > reads, 'fresh actual saved-generation reconstruction for this effect grant');
  }
  s.forbidSavedReads = true;
  await assert.rejects(() => s.db.withTenant(id(2), async tx => {
    const stored = await runtimeStore.readPlannerContinuationOperationWithinTx(tx,
      { tenantId: id(2), clerkUserId: 'user_original', operationId: row.id });
    await runtimeAuthority.plannerContinuationGrantWithinTx(tx, stored, 'effect', stored.data.lease.token);
  }));
  assert.deepEqual(s.durable, before);assert.deepEqual(sourceEvidence(s), evidence);assert.equal(s.calls.ownerPrepare, 1);
});

test('actual effect grant refuses a syntactically valid operation that substitutes the saved Strategy version', async () => {
  const s = runtimeFixture(), evidence = sourceEvidence(s);
  s.extraStrategyVersionIds = [id(99)]; // Another real version can exist; it is still not THIS immutable saved result.
  await assert.rejects(() => s.db.withTenant(id(2), async tx => {
    const actualSaved = await saved.readCanonicalSavedGeneration(tx, s.scope);
    const consent = await runtimeAuthority.readPlannerContinuationConsentWithinTx(tx, actualSaved);
    // Deliberately corrupt OPERATION evidence, leaving the complete original
    // saved-generation ledgers unchanged. The store parser is not authority.
    const operation = runtimeStore.newPlannerContinuationOperation({ ...consent, clerkUserId: 'user_original',
      work: { ...consent.work, strategyVersionId: id(99) } });
    const inserted = await runtimeStore.insertPlannerContinuationOperationWithinTx(tx, operation);
    const claimed = await runtimeStore.claimPlannerContinuationOperationWithinTx(tx, inserted,
      { leaseToken: id(59), nowMs: s.databaseNowMs, leaseExpiresAtMs: s.databaseNowMs + 10_000 });
    await runtimeAuthority.plannerContinuationGrantWithinTx(tx, claimed, 'effect', id(59));
  }), error => error instanceof app.CanonicalApplicationError && error.code === 'REQUEST_CONFLICT');
  assert.equal(s.operations().length, 0);assert.equal(s.calls.ownerPrepare, 0);assert.deepEqual(sourceEvidence(s), evidence);
});

test('failed/cancelled original accounting needs fresh retained-read authority and its own operation receipt', async () => {
  for (const outcome of ['failed', 'cancelled']) {
    const s = await runtimeTerminalFixture(outcome), before = copy(s.durable), checks = s.runtimeMetrics.nativeChecks;
    const result = await s.newRuntime().consumeJob(s.scope);
    assert.deepEqual(result, { outcome, terminalReceiptId: s.operations()[0].id });
    assert.ok(s.runtimeMetrics.nativeChecks > checks);assert.deepEqual(s.durable, before);assert.equal(s.calls.ownerPrepare, 1);
  }
});

test('revoked native or retained-read authority cannot expose failed/cancelled original terminal accounting', async () => {
  for (const outcome of ['failed', 'cancelled']) for (const revoked of ['nativeRevoked', 'readUnavailable']) {
    const s = await runtimeTerminalFixture(outcome), before = copy(s.durable), checks = s.runtimeMetrics.nativeChecks;
    s[revoked] = true;
    await assert.rejects(() => s.newRuntime().consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError &&
      error.code === (revoked === 'nativeRevoked' ? 'AUTHORITY_UNAVAILABLE' : 'NOT_AVAILABLE'));
    assert.ok(s.runtimeMetrics.nativeChecks > checks);assert.deepEqual(s.durable, before);assert.equal(s.calls.ownerPrepare, 1);
  }
});

test('a corrupt failed/cancelled terminal receipt cannot be adopted even under fresh retained-read authority', async () => {
  for (const outcome of ['failed', 'cancelled']) {
    const s = await runtimeTerminalFixture(outcome), [row] = s.operations(), checks = s.runtimeMetrics.nativeChecks;
    s.durable.resources.get(row.id).data.terminal.receiptId = id(99);
    const corrupt = copy(s.durable), evidence = sourceEvidence(s);
    await assert.rejects(() => s.newRuntime().consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError && error.code === 'OUTCOME_UNCONFIRMED');
    assert.ok(s.runtimeMetrics.nativeChecks > checks);assert.deepEqual(s.durable, corrupt);
    assert.deepEqual(sourceEvidence(s), evidence);assert.equal(s.calls.ownerPrepare, 1);
  }
});

test('expiry during operation accounting CAS fails the final original-grant fence and rolls back both owners', async () => {
  const s = runtimeFixture(), evidence = sourceEvidence(s);s.expireDuringAccounting = true;
  await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError);
  const [row] = s.operations();
  assert.equal(s.accountingCASAdvancedClock, true);assert.equal(s.finalizationSawOutputs, true);
  assert.equal(s.expiryFenceRefusals, 1, 'the post-accounting fence checked the original captured grant against the advanced DB clock');
  assert.equal(s.runtimeMetrics.finalizations, 1);assert.equal(s.calls.ownerPrepare, 1);
  assert.equal(row.data.state, 'leased');assert.equal(row.version, 2);assert.equal(row.data.terminal, null);
  assert.equal(s.databaseNowMs, Date.parse(row.data.original.originalDeadlineAt));
  assert.equal(s.durable.owner, null);assert.deepEqual(s.durable.projects, []);assert.deepEqual(s.durable.tasks, []);
  assert.equal(s.durable.receiptWrites, 0);assert.equal(s.durable.headWrites, 0);assert.equal(s.durable.resources.size, 2);
  assert.deepEqual(sourceEvidence(s), evidence);
});

test('actual runtime and worker default off perform no database/system/source/claim work', async () => {
  const s = runtimeFixture(false), worker = new ObjectivePlannerContinuationWorker(s.db, s.runtime);
  worker.onModuleInit();await worker.tick();worker.onModuleDestroy();
  assert.deepEqual(await s.runtime.consumeJob(s.scope), { outcome: 'disabled' });await s.runtime.consumeTenant(id(2));
  assert.equal(s.runtimeTxRequested, 0);assert.equal(s.runtimeMetrics.systemReads, 0);
  assert.equal(s.calls.job, 0);assert.equal(s.calls.ownerPrepare, 0);assert.equal(s.operations().length, 0);
});

test('current Planner consent revocation after admission denies effects and is terminal-accounted without a successor writer', async () => {
  const s = runtimeFixture();s.beforeRuntimeTransaction = call => { if (call === 2) s.planConsentRevoked = true; };
  await assert.rejects(() => s.runtime.consumeJob(s.scope), error => error instanceof app.CanonicalApplicationError);
  const original = copy(s.operations()[0].data.original);assert.equal(s.calls.ownerPrepare, 0);
  s.beforeRuntimeTransaction = undefined;
  const result = await s.newRuntime().consumeJob(s.scope);
  assert.equal(result.outcome, 'cancelled');assert.deepEqual(s.operations()[0].data.original, original);
  assert.equal(s.operations()[0].data.state, 'cancelled');assert.equal(s.runtimeMetrics.operationInserts, 1);
  assert.equal(s.calls.ownerPrepare, 0);assert.deepEqual(s.durable.projects, []);
});

test('explicit native revocation denies admission and native release revocation rolls back actual application effects', async () => {
  const denied = runtimeFixture();denied.nativeRevoked = true;
  await assert.rejects(() => denied.runtime.consumeJob(denied.scope), error => error instanceof app.CanonicalApplicationError && error.code === 'AUTHORITY_UNAVAILABLE');
  assert.equal(denied.operations().length, 0);assert.equal(denied.calls.ownerPrepare, 0);
  const release = runtimeFixture();release.nativeRevokedAfterOwner = true;
  await assert.rejects(() => release.runtime.consumeJob(release.scope), error => error instanceof app.CanonicalApplicationError);
  assert.equal(release.calls.ownerPrepare, 1);assert.equal(release.operations()[0].data.state, 'leased');
  assert.deepEqual(release.durable.projects, []);assert.deepEqual(release.durable.tasks, []);
  assert.equal(release.durable.owner, null);assert.equal(release.durable.receiptWrites, 0);assert.equal(release.durable.headWrites, 0);
});

test('source changes block new runtime effects while applied original receipts remain fresh retained reads', async () => {
  const stale = runtimeFixture();stale.staleObjective = true;
  await assert.rejects(() => stale.runtime.consumeJob(stale.scope), error => error instanceof app.CanonicalApplicationError && error.code === 'SOURCE_STALE');
  assert.equal(stale.calls.ownerPrepare, 0);assert.equal(stale.operations().length, 0);
  const applied = runtimeFixture();const original = await applied.runtime.consumeJob(applied.scope), before = copy(applied.durable);
  applied.staleObjective = true;applied.effectUnavailable = true;applied.current = copy(applied.durable.owner.result);
  applied.current.projects[0].name = 'Human edit after Objective advance';applied.current.projects[0].output.currentVersion = 12;
  const observed = await applied.newRuntime().consumeJob(applied.scope);
  assert.equal(observed.recovered, true);assert.deepEqual(observed.observation.creation, original.observation.creation);
  assert.equal(observed.observation.current.projects[0].output.currentVersion, 12);
  assert.deepEqual(applied.durable, before);assert.equal(applied.calls.ownerPrepare, 1);
});

test('actual runtime scope and operation store never cross tenant/job/native-owner boundaries', async () => {
  for (const scope of [{ tenantId: id(99), clerkUserId: 'user_original', generationJobId: id(10) },
    { tenantId: id(2), clerkUserId: 'user_foreign', generationJobId: id(10) },
    { tenantId: id(2), clerkUserId: 'user_original', generationJobId: id(99) }]) {
    const s = runtimeFixture();await assert.rejects(() => s.runtime.consumeJob(scope), error => error instanceof app.CanonicalApplicationError);
    assert.equal(s.operations().length, 0);assert.equal(s.calls.ownerPrepare, 0);assert.equal(s.calls.job, 0);
  }
  const s = runtimeFixture();await s.runtime.consumeJob(s.scope);const [row] = s.operations(), before = copy(s.durable);
  const foreign = await s.db.withTenant(id(99), tx => runtimeStore.readPlannerContinuationOperationWithinTx(tx,
    { tenantId: id(99), clerkUserId: 'user_original', operationId: row.id }));
  assert.equal(foreign, null);assert.deepEqual(s.durable, before);assert.equal(s.calls.ownerPrepare, 1);
});

test('actual worker discovers completed producer rows and invokes actual runtime; a later pass only reads the applied operation', async () => {
  const s = runtimeFixture(), worker = new ObjectivePlannerContinuationWorker(s.db, s.runtime);
  await worker.tick();assert.equal(s.calls.ownerPrepare, 1);assert.equal(s.operations()[0].data.state, 'applied');
  const before = copy(s.durable);await worker.tick();
  assert.equal(s.runtimeMetrics.systemReads, 2);assert.equal(s.calls.ownerPrepare, 1);assert.deepEqual(s.durable, before);
  assert.equal(s.calls.verify, 0);assert.equal(s.calls.current, 0);
});

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
  assert.equal(custody.length, 13);
  console.log(JSON.stringify({ qualification: 'saved-Strategy-to-existing-Planner-source-orchestration-only', sourceCustody: custody,
    actual: ['readCanonicalSavedGeneration', 'requireSavedGenerationApplication', 'ObjectiveCanonicalApplicationService',
      'prepareWithinOwnerTransaction', 'lookupWithinOwnerTransaction', 'executeCanonicalApplicationTransaction',
      'creationAck', 'checkStoredApplication', 'applicationObservation', 'ObjectivePlannerContinuationRuntime',
      'ObjectivePlannerContinuationWorker', 'plannerContinuationGrantWithinTx',
      'readPlannerContinuationOperationWithinTx', 'claimPlannerContinuationOperationWithinTx', 'finalizePlannerContinuationOperationWithinTx'],
    synthetic: ['database SQL and transaction rollback model', 'current authority and source fences',
      'retained ledger/codec owner ports', 'Planner materializer/creation/observation ports', 'owner receipt ID dependency'],
    nativeDatabaseFrameworkHttpGenuineCustodyAuthority: 'UNQUALIFIED', subprocesses: 0, network: false, fileWrites: false }));
});
