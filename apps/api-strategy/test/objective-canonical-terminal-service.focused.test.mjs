// Actual terminal service/controller methods, actual kernel/generation pures
// and actual public Objective projection. Custody codec/owner, database,
// absence/current authority and saved-Strategy reader are SYNTHETIC ports.
// No genuine SDK custody, SQL atomicity, HTTP/Nest or authorization proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const custody = [];
const copy = value => structuredClone(value);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const apiSlot = Symbol.for('capiro.terminal-service.focused.actual-pures');
async function sourceModule(relative, replacements = [], removals = [], mode = 'strip') {
  const path = new URL(relative, import.meta.url), raw = await readFile(path, 'utf8');
  let source = raw;
  for (const [from, count] of removals) {
    assert.equal(source.split(from).length, count + 1, `declared decorator erasure: ${from}`);
    source = source.split(from).join('');
  }
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, `one declared import rewrite: ${from}`);
    source = source.replace(from, JSON.stringify(to));
  }
  const transformed = stripTypeScriptTypes(source, { mode, sourceUrl: path.href });
  custody.push({ path: relative, sha256: createHash('sha256').update(raw).digest('hex'),
    transformedSha256: createHash('sha256').update(transformed).digest('hex'), mode,
    replacementSpecifiers: replacements.map(([from]) => from), removedDecorators: removals });
  return data(transformed);
}
const appUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const generationUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
]);
const nestUrl = data(`export const Injectable=()=>value=>value;
  export const Body=Injectable,Controller=Injectable,Get=Injectable,Header=Injectable,HttpCode=Injectable,Param=Injectable,Post=Injectable,Req=Injectable;
  export class BadRequestException extends Error{};export class ConflictException extends Error{};
  export class HttpException extends Error {
    constructor(response,status){super(response.code);this.response=response;this.status=status;}
    getResponse(){return this.response;}getStatus(){return this.status;}
  }`);
const enumUrl = data("export const STRATEGY_TYPES=['appropriations','authorization','regulatory','coalition','procurement','earmark','amendment'];");
const typesUrl = await sourceModule('../src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", nestUrl], ["'../strategy/dto/create-strategy.dto.js'", enumUrl],
]);
const kernelUrl = await sourceModule('../src/meri/objective-canonical-terminal.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-generation.types.js'", typesUrl],
]);
const app = await import(appUrl), generation = await import(generationUrl), types = await import(typesUrl), kernel = await import(kernelUrl);
globalThis[apiSlot] = { app, generation, types };
const portsUrl = data(`
  import assert from 'node:assert/strict';
  const {app,generation}=globalThis[Symbol.for('capiro.terminal-service.focused.actual-pures')];
  const clone=value=>structuredClone(value);
  const fail=(code='OUTCOME_UNCONFIRMED')=>{throw new app.CanonicalApplicationError(code);};
  export class PrismaService{};export class ObjectiveCanonicalWorkloadAuthority{};
  export class ObjectiveCanonicalResultOwner{};
  export const GENERATION_NORMALIZATION=generation.GENERATION_NORMALIZATION,GENERATION_PRODUCER=generation.GENERATION_PRODUCER;
  export async function generationAssociation(tx,tenant,clerk,job){
    const s=tx.fixture;s.calls.association++;
    assert.equal(tenant,s.a.canonical.tenantId);assert.equal(clerk,s.a.clerkUserId);assert.equal(job,s.job.id);
    if(s.associationError)fail('REQUEST_CONFLICT');return clone(s.association);
  }
  export async function readCanonicalRequestPublication(tx,a){
    const s=tx.fixture;s.calls.publication++;assert.deepEqual(a,s.a);
    return s.publicationMissing?null:clone(s.publication);
  }
  export async function requireCanonicalGenerationReadWithinTx(tx,a,clerk){
    const s=tx.fixture;s.calls.readFence++;assert.equal(s.depth,1);assert.deepEqual(a,s.a);
    assert.equal(clerk,s.a.clerkUserId);
    if(s.readUnavailable)fail('NOT_AVAILABLE');
  }
  export async function readGenerationLedger(tx,kind,tenant,clerk,job){
    const s=tx.fixture;assert.equal(tenant,s.a.canonical.tenantId);assert.equal(clerk,s.a.clerkUserId);assert.equal(job,s.job.id);
    if(kind===GENERATION_NORMALIZATION){s.calls.normalization++;return clone(s.normalization);}
    if(kind===GENERATION_PRODUCER){s.calls.producer++;return clone(s.producer);}
    throw Error('Unexpected synthetic ledger');
  }
  export async function readCanonicalSavedGeneration(tx,scope){
    const s=tx.fixture;s.calls.saved++;assert.deepEqual(scope,{tenantId:s.a.canonical.tenantId,clerkUserId:s.a.clerkUserId,generationJobId:s.job.id});
    if(!s.savedEvidence.normalization||!s.savedEvidence.producer||!s.savedEvidence.strategy||!s.job.input.canonicalCompletion)fail();
    return {receipt:clone(s.savedReceipt)};
  }
  export function verifyRetainedCanonicalNonSuccess(raw,expected){
    const s=globalThis[Symbol.for('capiro.terminal-service.focused.current-fixture')];s.calls.decode++;
    assert.deepEqual(expected.admission,s.a);assert.deepEqual(expected.acceptance,s.association.acceptance);
    assert.deepEqual(expected.publication,s.publication.publication);assert.equal(expected.nowMs,s.now);
    if(raw.kind!=='synthetic-typed-result'||!['needs-information','refused'].includes(raw.state))fail();
    if(raw.sourceRunId!==s.association.acceptance.sourceBinding.runId)fail('REQUEST_CONFLICT');
    return {outcome:raw.state,evidence:clone(raw.evidence),checkedAtMs:raw.checkedAtMs,expiresAtMs:raw.expiresAtMs};
  }
  export function checkStoredCanonicalNonSuccess(evidence,expected){
    const s=globalThis[Symbol.for('capiro.terminal-service.focused.current-fixture')];s.calls.decodeStored++;
    assert.deepEqual(expected.admission,s.a);assert.deepEqual(expected.acceptance,s.association.acceptance);
    if(!evidence||evidence.kind!=='typed-result'||!['needs-information','refused'].includes(evidence.outcome)||s.storedEvidenceCorrupt)fail();
    return clone(evidence);
  }
`);
const serviceUrl = await sourceModule('../src/meri/objective-canonical-terminal.service.ts', [
  ["'@nestjs/common'", nestUrl], ["'../prisma/prisma.service.js'", portsUrl],
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'../planner/objective-canonical-authority.js'", portsUrl],
  ["'./objective-canonical-result-owner.js'", portsUrl],
  ["'./objective-canonical-completion-receipt.js'", portsUrl],
  ["'./objective-canonical-producer-ledger.js'", portsUrl],
  ["'./objective-canonical-generation.js'", portsUrl],
  ["'./objective-canonical-request-ledger.js'", portsUrl],
  ["'./objective-canonical-generation-fence.js'", portsUrl],
  ["'./objective-canonical-saved-generation.js'", portsUrl],
  ["'./objective-canonical-terminal.js'", kernelUrl],
  ["'./objective-generation.types.js'", typesUrl],
], [['@Injectable()', 1]], 'transform');
const controllerUrl = await sourceModule('../src/meri/objective-canonical-terminal.controller.ts', [
  ["'@nestjs/common'", nestUrl], ["'./objective-canonical-terminal.service.js'", serviceUrl],
], [["@Controller('internal/objective-canonical/generation-terminals')", 1], ['@Post()', 1],
  ['@HttpCode(201)', 1], ['@HttpCode(200)', 1], ["@Header('Cache-Control', 'private, no-store')", 2],
  ["@Get(':generationJobId')", 1], ['@Req()', 2], ['@Body()', 1], ["@Param('generationJobId')", 1]], 'transform');
const { ObjectiveCanonicalTerminalService } = await import(serviceUrl);
const { ObjectiveCanonicalTerminalController } = await import(controllerUrl);

function fixture(outcome = 'needs-information') {
  const s = { now: 5000, depth: 0, reads: 0, cas: [], casWrites: 0, casCount: 1,
    calls: Object.fromEntries(['verify', 'current', 'association', 'publication', 'readFence', 'normalization',
      'producer', 'strategy', 'saved', 'decode', 'decodeStored', 'forbidden'].map(key => [key, 0])) };
  const canonical = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4), canonicalStrategyId: id(5),
    canonicalProjectId: id(6), bindingVersion: 2, epoch: 1, requestedIntentId: id(7), requestedObjectiveRevisionId: id(8),
    requestedObjectiveVersion: 1, snapshotHash: 'a'.repeat(64) };
  s.a = { schemaVersion: 1, namespace: generation.GENERATION_ADMISSION_NAMESPACE, canonical, actorUserId: id(9),
    clerkUserId: 'user_original', consentId: id(12), controlVersion: 3, generationJobId: id(10), generationRequestId: id(11),
    admittedAtMs: 1000, effectExpiresAtMs: 2000, expectedStrategyVersionId: null };
  const binding = { tenantId: id(2), actorId: 'user_original', conversationId: id(40), runId: id(41),
    attemptId: id(42), workerId: id(43), writerFence: 1 };
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: generation.canonicalGenerationAdmissionSha256(s.a),
    sourceBinding: binding, sourceRequestSha256: 'b'.repeat(64), acceptedAtMs: 1100,
    issuance: { issuanceKey: app.applicationHash(binding), binding: copy(binding), requestSha256: 'b'.repeat(64),
      expiresAtMs: 1900, grantId: id(44), capabilitySha256: 'c'.repeat(64), factsSha256: 'd'.repeat(64) } };
  s.association = { admission: s.a, acceptance };
  const request = { requestId: id(11), clientId: id(3), objective: { objectiveId: id(4), objectiveVersion: 1 }, type: 'authorization' };
  const source = { clientId: id(3), objectiveId: id(4), objectiveVersion: 1, objectiveRevisionId: id(8) };
  s.job = { id: id(10), tenantId: id(2), clientId: id(3), ownerUserId: 'user_original', status: 'running', stage: 'drafting',
    strategyId: null, errorMessage: null, attempt: 2, claimedBy: `canonical:${acceptance.issuance.issuanceKey}`,
    deadlineAt: new Date(0), input: { dto: { clientId: id(3), type: 'authorization', goal: 'Original unchanged goal' }, bearer: null,
      canonicalGeneration: { admissionId: generation.generationLedgerId(generation.GENERATION_ADMISSION, id(2), 'user_original', id(10)) },
      objectiveGeneration: { request, fingerprint: app.applicationHash(request), receipt: { schemaVersion: 1, requestId: id(11), source,
        context: { state: 'complete', packetId: id(20), compiledAt: new Date(1050).toISOString(), reobservedAt: null,
          sourceDigest: 'e'.repeat(64), coverageDigest: 'f'.repeat(64), inputDigest: '1'.repeat(64), issues: [] },
        result: null, failure: null } } } };
  s.publication = { publicationSha256: '2'.repeat(64), publication: { sourceAdmissionSha256: acceptance.sourceAdmissionSha256,
    request: { basis: null, principal: { ownerActorId: 'user_original' } } } };
  s.rawOutcome = { kind: 'synthetic-typed-result', state: outcome, sourceRunId: binding.runId, checkedAtMs: s.now,
    expiresAtMs: 6000, evidence: { kind: 'typed-result', outcome,
      retained: { syntheticOriginalObservation: true, privateIssues: [{ code: 'synthetic-code', message: 'PRIVATE_PROVIDER_MARKER' }] },
      witness: { syntheticOriginalBindingHash: app.applicationHash(binding) } } };
  s.grant = { tenantId: id(2), actorUserId: id(9), clerkUserId: 'user_original', consentId: id(12), controlVersion: 3,
    checkedAtMs: 4999, expiresAtMs: 20_000, delegationExpiresAtMs: 21_000, claimExpiresAtMs: 22_000,
    terminalAccounting: { phase: 'terminal-account', checkedAtMs: 4999, expiresAtMs: 23_000,
      absoluteExpiresAtMs: 24_000 } };
  s.normalization = null;s.producer = null;s.strategyExists = false;
  s.savedEvidence = { normalization: true, producer: true, strategy: true };
  s.savedReceipt = { schemaVersion: 1, generationJobId: id(10), sourceAdmissionSha256: acceptance.sourceAdmissionSha256,
    objectiveReceipt: { ...copy(s.job.input.objectiveGeneration.receipt),
      result: { strategyId: id(5), strategyVersionId: id(60), savedAt: new Date(1500).toISOString() } }, snapshotDigest: '3'.repeat(64) };
  s.originalInput = copy(s.job.input);
  const forbidden = reason => { s.calls.forbidden++;throw Error(`Forbidden application side effect: ${reason}`); };
  s.tx = { fixture: s,
    $queryRaw: async (strings, ...values) => {
      assert.equal(s.depth, 1);const sql = strings.join('?').replace(/\s+/g, ' ');
      if (sql.includes('FROM sp_draft_job') && sql.includes('FOR UPDATE')) {
        assert.deepEqual(values, [id(2), 'user_original', id(10)]);return [{ id: id(10) }];
      }
      if (sql.includes('clock_timestamp()') && sql.includes('AS ms')) return [{ ms: String(s.now) }];
      return forbidden('unexpected SQL/old-ready/deadline query');
    },
    $executeRaw: async (strings, ...values) => {
      assert.equal(s.depth, 1);const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      if (!sql.startsWith("UPDATE sp_draft_job SET status='failed'")) return forbidden('Strategy/Planner/legacy write');
      assert.equal(values.length, 7);assert.equal(values[0], types.SAFE_FAILURES.OBJECTIVE_GENERATION_FAILED);
      assert.deepEqual(values.slice(2, 6), [id(2), id(10), 'user_original', `canonical:${acceptance.issuance.issuanceKey}`]);
      assert.deepEqual(JSON.parse(values[6]), s.job.input);
      assert.ok(sql.includes('attempt=2 AND strategy_id IS NULL'));
      assert.ok(sql.includes("NOT(input ? 'canonicalCompletion') AND NOT(input ? 'canonicalTerminal')"));
      assert.equal(sql.includes('deadline_at'), false, 'terminal accounting does not renew or require old effect deadline');
      const input = JSON.parse(values[1]);s.cas.push({ sql, input: copy(input) });
      if (s.casError) throw s.casError;
      if (s.casCount === 1) {
        s.job.input = copy(input);s.job.status = 'failed';s.job.stage = 'failed';s.job.errorMessage = values[0];s.casWrites++;
      }
      return s.casCount;
    },
    spDraftJob: {
      findFirst: async ({ where }) => { assert.deepEqual(where, { tenantId: id(2), ownerUserId: 'user_original', id: id(10) });return s.missingJob ? null : copy(s.job); },
      create: () => forbidden('fresh generation job'), update: () => forbidden('legacy completion update'), updateMany: () => forbidden('legacy completion sweep'),
    },
    spStrategy: { findFirst: async ({ where }) => { s.calls.strategy++;assert.deepEqual(where, { tenantId: id(2), id: id(5) });return s.strategyExists ? { id: id(5) } : null; },
      create: () => forbidden('Strategy writer'), update: () => forbidden('Strategy writer') },
    spPlannerResource: { create: () => forbidden('Planner writer') },
  };
  s.db = { withTenant: async (tenant, run, options) => {
    assert.equal(tenant, id(2));assert.equal(options.timeoutMs, 15_000);assert.equal(s.depth, 0);
    const before = copy({ job: s.job, casWrites: s.casWrites });let result;s.depth++;
    try { result = await run(s.tx); }
    catch (error) { s.job = before.job;s.casWrites = before.casWrites;throw error; }
    finally { s.depth--; }
    if (s.loseCommittedReplyOnce && s.casWrites > before.casWrites) { s.loseCommittedReplyOnce = false;throw Error('Synthetic committed reply lost'); }
    return result;
  } };
  s.authority = {
    verifyGeneration: async (http, subject) => {
      s.calls.verify++;assert.equal(http.syntheticTrustedRequest, true);s.subject = copy(subject);
      assert.ok(['terminal-account', 'terminal-read'].includes(subject.phase));
      return { ...s.grant, terminalAccounting: s.grant.terminalAccounting &&
        { ...s.grant.terminalAccounting, phase: subject.phase }, requestSha256: subject.requestSha256 };
    },
    assertGenerationCurrent: async (tx, grant, subject) => {
      s.calls.current++;assert.equal(tx, s.tx);assert.equal(subject.phase, s.subject.phase);
      assert.equal(grant.consentId, id(12));
      if (s.revoked || s.revokeAfterCas && s.cas.length > 0) throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
    },
  };
  s.reader = { read: async (selection, { signal }) => {
    s.reads++;assert.equal(s.depth, 0);assert.equal(signal.aborted, false);s.readerSignal = signal;
    assert.deepEqual(selection, { generationJobId: id(10), binding, sourceAdmissionSha256: acceptance.sourceAdmissionSha256 });
    if (s.readerError) throw Error('Synthetic custody reader unavailable');
    if (s.afterRead) s.afterRead(s);
    return copy(s.rawOutcome);
  } };
  s.service = new ObjectiveCanonicalTerminalService(s.db, s.authority, s.reader);
  s.controller = new ObjectiveCanonicalTerminalController(s.service);
  s.body = { schemaVersion: 1, generationJobId: id(10) };s.http = { syntheticTrustedRequest: true };
  globalThis[Symbol.for('capiro.terminal-service.focused.current-fixture')] = s;
  return s;
}
const account = s => s.controller.account(s.http, s.body);
const lookup = s => s.controller.read(s.http, s.body.generationJobId);
function failure(status, code) {
  return error => { assert.equal(error.getStatus(), status);assert.equal(error.getResponse().code, code);
    assert.equal(error.getResponse().outcome, 'unconfirmed');return true; };
}
function noAccounting(s) {
  assert.equal(s.casWrites, 0);assert.equal(s.job.input.canonicalTerminal, undefined);
  assert.equal(s.calls.forbidden, 0);assert.equal(s.depth, 0);
}
function applied(s) {
  s.job.status = 'completed';s.job.strategyId = id(5);s.job.input.canonicalCompletion = { originalSyntheticWitness: true };
}

test('both typed outcomes account after original expiry with actual kernel and safe unchanged public failed projection', async () => {
  for (const outcome of ['needs-information', 'refused']) {
    const s = fixture(outcome), result = await account(s);
    assert.equal(result.status, 'not-applied');assert.equal(result.outcome, outcome);assert.equal(s.casWrites, 1);
    assert.equal(result.terminalReceiptId, s.job.input.canonicalTerminal.id);
    assert.equal(result.terminalReceiptSha256, s.job.input.canonicalTerminal.recordSha256);
    assert.equal(result.recordedAtMs, 5000);assert.ok(s.a.effectExpiresAtMs < s.now);
    assert.equal(result.objectiveReceipt.failure.code, 'OBJECTIVE_GENERATION_FAILED');
    assert.equal(result.objectiveReceipt.failure.message, types.SAFE_FAILURES.OBJECTIVE_GENERATION_FAILED);
    assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER_MARKER'), false);
    assert.equal(JSON.stringify(result.objectiveReceipt).includes('needs-information'), false);
    assert.equal(s.job.status, 'failed');assert.equal(s.job.stage, 'failed');assert.equal(s.job.strategyId, null);
    assert.equal(types.validObjectiveOutcome(s.job.input.objectiveGeneration.receipt, 'failed', null, s.job.errorMessage), true);
    assert.deepEqual(s.job.input.dto, s.originalInput.dto);assert.deepEqual(s.job.input.objectiveGeneration.request, s.originalInput.objectiveGeneration.request);
    assert.equal(s.readerSignal.aborted, true);assert.equal(s.calls.forbidden, 0);
  }
});

test('actual account and read methods use distinct terminal authority purposes', async () => {
  const s = fixture();await account(s);assert.equal(s.subject.phase, 'terminal-account');
  const result = await lookup(s);assert.equal(s.subject.phase, 'terminal-read');
  assert.equal(result.status, 'not-applied');assert.equal(s.calls.forbidden, 0);
});

test('exact terminal replay and GET keep original record without another custody read or CAS', async () => {
  const s = fixture(), first = await account(s), before = copy(s.job);s.readerError = true;
  const replay = await account(s), read = await lookup(s);
  assert.deepEqual(replay, first);assert.deepEqual(read, first);assert.deepEqual(s.job, before);
  assert.equal(s.reads, 1);assert.equal(s.cas.length, 1);assert.equal(s.casWrites, 1);assert.ok(s.calls.decodeStored > 0);
});

test('lost committed reply recovers original terminal ID/hash/time through GET with no new owner IO', async () => {
  const s = fixture();s.loseCommittedReplyOnce = true;
  await assert.rejects(() => account(s), failure(503, 'OUTCOME_UNCONFIRMED'));
  assert.equal(s.casWrites, 1);const record = copy(s.job.input.canonicalTerminal);s.readerError = true;
  const read = await lookup(s);
  assert.equal(read.terminalReceiptId, record.id);assert.equal(read.terminalReceiptSha256, record.recordSha256);
  assert.equal(read.recordedAtMs, record.recordedAtMs);assert.equal(s.reads, 1);assert.equal(s.cas.length, 1);
});

test('completed Strategy winning during retained IO returns its stored applied evidence without terminal CAS', async () => {
  const s = fixture();s.afterRead = applied;
  const result = await account(s);
  assert.equal(result.status, 'applied');assert.deepEqual(result.saved, s.savedReceipt);
  assert.equal(s.reads, 1);assert.equal(s.cas.length, 0);assert.equal(s.calls.saved, 1);noAccounting(s);
});

test('completed Strategy with missing normalization/producer/Strategy evidence remains unknown rather than failed', async () => {
  for (const missing of ['normalization', 'producer', 'strategy']) {
    const s = fixture();applied(s);s.savedEvidence[missing] = false;
    await assert.rejects(() => account(s), failure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.job.status, 'completed');assert.equal(s.reads, 0);assert.equal(s.cas.length, 0);noAccounting(s);
  }
});

test('any existing partial normalization/producer/Strategy signal prevents a no-write terminal claim', async () => {
  for (const present of ['normalization', 'producer', 'strategy']) {
    const s = fixture();
    if (present === 'strategy') s.strategyExists = true;else s[present] = { existingSyntheticEvidence: true };
    await assert.rejects(() => account(s), failure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.reads, 0);assert.equal(s.cas.length, 0);noAccounting(s);
  }
});

test('association, original input, or source run changed during IO cannot be adopted into terminal evidence', async () => {
  for (const mutate of [s => { s.association.acceptance.sourceBinding.runId = id(99); },
    s => { s.job.input.dto.goal = 'Changed during IO'; },
    s => { s.publication.publicationSha256 = '9'.repeat(64); }]) {
    const s = fixture();s.afterRead = mutate;
    await assert.rejects(() => account(s), failure(409, 'REQUEST_CONFLICT'));
    assert.equal(s.cas.length, 0);noAccounting(s);
  }
  const s = fixture();s.rawOutcome.sourceRunId = id(99);
  await assert.rejects(() => account(s), failure(503, 'OUTCOME_UNCONFIRMED'));noAccounting(s);
});

test('CAS zero or exception propagates out of transaction with no durable terminal record', async () => {
  for (const mode of ['zero', 'throw']) {
    const s = fixture();if (mode === 'zero') s.casCount = 0;else s.casError = new Error('Synthetic CAS refused');
    await assert.rejects(() => account(s), failure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.cas.length, 1);assert.equal(s.job.status, 'running');assert.deepEqual(s.job.input, s.originalInput);noAccounting(s);
  }
});

test('fresh release authority revoked after CAS rolls back the private record and public failure together', async () => {
  const s = fixture();s.revokeAfterCas = true;
  await assert.rejects(() => account(s), failure(503, 'AUTHORITY_UNAVAILABLE'));
  assert.equal(s.cas.length, 1);assert.equal(s.job.status, 'running');assert.equal(s.job.errorMessage, null);
  assert.deepEqual(s.job.input, s.originalInput);noAccounting(s);
});

test('failed job without private terminal proof stays unknown and never queries a model/custody owner', async () => {
  const s = fixture();s.job.status = 'failed';s.job.stage = 'failed';s.job.errorMessage = types.SAFE_FAILURES.OBJECTIVE_GENERATION_FAILED;
  await assert.rejects(() => account(s), failure(503, 'OUTCOME_UNCONFIRMED'));
  await assert.rejects(() => lookup(s), failure(503, 'OUTCOME_UNCONFIRMED'));
  assert.equal(s.reads, 0);assert.equal(s.cas.length, 0);noAccounting(s);
});

test('generic failed/cancelled/success run labels cannot fabricate a typed terminal file or adopt an outcome', async () => {
  for (const state of ['failed', 'cancelled', 'succeeded']) {
    const s = fixture();s.rawOutcome.kind = 'generic-run-label';s.rawOutcome.state = state;
    await assert.rejects(() => account(s), failure(503, 'OUTCOME_UNCONFIRMED'));
    assert.equal(s.reads, 1);assert.equal(s.calls.decode, 1);assert.equal(s.cas.length, 0);noAccounting(s);
  }
});

test('current Objective advance and original expired deadline do not trigger an old ready/effect check', async () => {
  const s = fixture();s.currentObjectiveAdvanced = true;s.job.deadlineAt = new Date(0);
  const result = await account(s);
  assert.equal(result.status, 'not-applied');assert.ok(s.association.acceptance.issuance.expiresAtMs < s.now);
  assert.equal(s.casWrites, 1);assert.equal(s.calls.forbidden, 0);
});

test('fresh account grant or observed reader expiry prevents terminal CAS', async () => {
  for (const mutate of [s => { s.grant.expiresAtMs = s.now; },
    s => { s.grant.terminalAccounting.expiresAtMs = s.now; },
    s => { s.grant.terminalAccounting.absoluteExpiresAtMs = s.now; },
    s => { s.grant.terminalAccounting = null; },
    s => { s.rawOutcome.expiresAtMs = s.now; }]) {
    const s = fixture();mutate(s);
    await assert.rejects(() => account(s), failure(503, 'AUTHORITY_UNAVAILABLE'));
    assert.equal(s.cas.length, 0);noAccounting(s);
  }
});

test('fresh terminal bookkeeping permits expired historical effect deadlines', async () => {
  const s = fixture();s.grant.delegationExpiresAtMs = s.now;s.grant.claimExpiresAtMs = s.now;
  const result = await account(s);
  assert.equal(result.status, 'not-applied');assert.equal(s.casWrites, 1);
});

test('current read revocation withholds committed terminal record without changing it', async () => {
  const s = fixture();await account(s);const before = copy(s.job);s.revoked = true;
  await assert.rejects(() => lookup(s), failure(503, 'AUTHORITY_UNAVAILABLE'));
  assert.deepEqual(s.job, before);assert.equal(s.reads, 1);assert.equal(s.casWrites, 1);
});

test('closed request body refuses posted outcome, result ref, actor or arbitrary terminal proof', async () => {
  for (const extra of [{ outcome: 'cancelled' }, { resultRef: id(99) }, { actorUserId: id(99) }, { canonicalTerminal: {} }]) {
    const s = fixture();
    await assert.rejects(() => s.controller.account(s.http, { ...s.body, ...extra }), failure(400, 'INPUT_INVALID'));
    assert.equal(s.calls.verify, 0);assert.equal(s.reads, 0);noAccounting(s);
  }
});

test('original record corruption or unrecognized generic private terminal evidence stays unknown on read', async () => {
  const s = fixture();await account(s);s.job.input.canonicalTerminal.recordSha256 = '9'.repeat(64);
  await assert.rejects(() => lookup(s), failure(503, 'OUTCOME_UNCONFIRMED'));
  assert.equal(s.reads, 1);assert.equal(s.casWrites, 1);
  const other = fixture();await account(other);other.storedEvidenceCorrupt = true;
  await assert.rejects(() => lookup(other), failure(503, 'OUTCOME_UNCONFIRMED'));
  assert.equal(other.reads, 1);assert.equal(other.casWrites, 1);
});

test('retained owner IO is aborted at the actual service 3000ms bound', { timeout: 5000 }, async () => {
  const s = fixture();let signal;
  const reader = { read: async (_selection, options) => { signal = options.signal;return new Promise(() => {}); } };
  const service = new ObjectiveCanonicalTerminalService(s.db, s.authority, reader);
  await assert.rejects(() => service.account(s.http, s.body), failure(503, 'AUTHORITY_UNAVAILABLE'));
  assert.equal(signal.aborted, true);assert.equal(s.cas.length, 0);noAccounting(s);
});

test('prints exact service/controller/kernel custody with explicit synthetic authority and rollback limits', () => {
  assert.equal(custody.length, 6);
  console.log(JSON.stringify({ qualification: 'actual-terminal-methods-and-kernel-source-orchestration-only', sourceCustody: custody,
    actual: ['ObjectiveCanonicalTerminalService', 'ObjectiveCanonicalTerminalController methods', 'prepareCanonicalTerminal',
      'checkCanonicalTerminal', 'generation identity pures', 'publicObjectiveReceipt', 'validObjectiveOutcome'],
    synthetic: ['retained custody codec/owner', 'database absence and rollback model', 'current read/account authority', 'saved Strategy proof'],
    httpDecoratorsErased: true, nativeDatabaseGenuineCustodyAndAuthorization: 'UNQUALIFIED',
    subprocesses: 0, network: false, fileWrites: false }));
});
