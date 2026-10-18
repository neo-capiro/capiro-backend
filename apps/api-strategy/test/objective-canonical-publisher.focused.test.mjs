import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';

// Actual service/ledger/factory/job/fence source; synthetic owner, SQL-response
// and Context Plane ports. No DB SQL execution, HTTP, model, Nest provider graph,
// native concurrency, authentic workload or live source qualification.
const custody = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function load(path, imports = [], edits = []) {
  const file = new URL(path, import.meta.url), original = await readFile(file, 'utf8');
  let source = original.replace(/\r\n/g, '\n');
  const replace = (from, to) => { assert.equal(source.split(from).length, 2, `one exact source occurrence: ${path}: ${from}`); source = source.replace(from, to); };
  for (const [from, to] of imports) replace(from, JSON.stringify(to));
  for (const [from, to] of edits) replace(from, to);
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file.href });
  custody.push({ path: file.pathname, rawSha256: sha(original), sourceEdits: edits.map(([from]) => from),
    importSpecifiers: imports.map(([from]) => from), strippedSha256: sha(stripped) });
  return moduleUrl(stripped);
}
const nest = moduleUrl(`export class HttpException extends Error {
  constructor(response,status){super(response.message);this.response=response;this.status=status;}
  getResponse(){return this.response;}getStatus(){return this.status;}}
export class BadRequestException extends Error{};export class ConflictException extends Error{};
export const Injectable=()=>value=>value;`);
const prismaLabel = moduleUrl('export class PrismaService{}');
const contextLabel = moduleUrl('export class StrategyContextPlaneClient{}');
const enums = moduleUrl(`export const STRATEGY_TYPES=${JSON.stringify(['appropriations','authorization','regulatory','coalition','procurement','earmark','amendment'])};`);
const applicationUrl = await load('../src/planner/objective-canonical-application.ts');
const generationUrl = await load('../src/meri/objective-canonical-generation.ts', [["'../planner/objective-canonical-application.js'", applicationUrl]]);
const objectiveUrl = await load('../src/meri/objective-generation.types.ts', [["'@nestjs/common'", nest], ["'../strategy/dto/create-strategy.dto.js'", enums]]);
const producerUrl = await load('../src/meri/objective-canonical-producer.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-generation.types.js'", objectiveUrl],
]);
const ownerLedgerUrl = await load('../src/meri/objective-canonical-producer-ledger.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-canonical-producer.js'", producerUrl],
]);
const jobInputUrl = await load('../src/meri/objective-canonical-job-input.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
const factoryUrl = await load('../src/meri/objective-canonical-request.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
// The actual pure basis checker is exercised below. Its DB/history owner
// dependencies are explicit unused throwing bindings, not synthetic proof of
// history replay or capture. Service capture itself uses the named controlled
// port on each staged fixture transaction.
const unusedBasisVersion = moduleUrl(`export function buildSnapshot(){throw Error('unused native basis owner');}`);
const unusedBasisHistory = moduleUrl(`export function canonicalRegenerationSnapshot(){throw Error('unused native history owner');}
export function checkCanonicalRegenerationNormalization(){throw Error('unused native history owner');}`);
const pureBasisUrl = await load('../src/meri/objective-canonical-basis.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl],
  ["'../strategy/versioning.js'", unusedBasisVersion], ["'./objective-canonical-producer-ledger.js'", ownerLedgerUrl],
  ["'./objective-canonical-regeneration-ledger.js'", unusedBasisHistory],
]);
const regenerationFactoryUrl = await load('../src/meri/objective-canonical-regeneration-request.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-canonical-basis.js'", pureBasisUrl], ["'./objective-canonical-request.js'", factoryUrl],
]);
const requestLedgerUrl = await load('../src/meri/objective-canonical-request-ledger.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-canonical-producer-ledger.js'", ownerLedgerUrl], ["'./objective-canonical-request.js'", factoryUrl],
  ["'./objective-canonical-regeneration-request.js'", regenerationFactoryUrl],
]);
// Emulate the one TS parameter property with an ordinary argument+assignment;
// every authority query and error path remains the actual shared owner source.
const sharedUrl = await load('../../../packages/shared/src/client-objective-destination.ts', [], [
  ['    readonly code:', '    code:'], ['    super(code);', '    super(code);\n    this.code = code;'],
]);
const fenceUrl = await load('../src/meri/objective-canonical-generation-fence.ts', [
  ["'@capiro/shared'", sharedUrl], ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
const authorityUrl = await load('../src/planner/objective-canonical-authority.ts', [
  ["'@nestjs/common'", nest], ["'./objective-canonical-application.js'", applicationUrl],
], [['@Injectable()\n', '']]);
const ownersUrl = await load('../src/meri/objective-canonical-owner-directory.ts', [
  ["'@nestjs/common'", nest], ["'../planner/objective-canonical-application.js'", applicationUrl],
], [['@Injectable()\n', '']]);
// This named synthetic capture port returns null only for actual initial
// admissions; regeneration packets pass the actual pure coherence checker.
// It models controlled owner observations, never actual SQL/history custody.
const basisLabel = moduleUrl(`export function captureCanonicalStrategyBasis(tx,admission){
  if(typeof tx.syntheticCaptureCanonicalStrategyBasis!=='function')throw Error('missing declared synthetic basis capture port');
  return tx.syntheticCaptureCanonicalStrategyBasis(admission);}`);
const constructor = '  constructor(private readonly prisma: PrismaService, private readonly authority: ObjectiveCanonicalWorkloadAuthority,\n' +
  '    private readonly contextPlane: StrategyContextPlaneClient, private readonly owners: ObjectiveCanonicalOwnerDirectory) {}';
const serviceUrl = await load('../src/meri/objective-canonical-request.service.ts', [
  ["'@nestjs/common'", nest], ["'../prisma/prisma.service.js'", prismaLabel], ["'../planner/objective-canonical-authority.js'", authorityUrl],
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-canonical-producer-ledger.js'", ownerLedgerUrl], ["'./objective-canonical-job-input.js'", jobInputUrl],
  ["'./objective-canonical-generation-fence.js'", fenceUrl], ["'./objective-canonical-request.js'", factoryUrl],
  ["'./objective-canonical-regeneration-request.js'", regenerationFactoryUrl],
  ["'./objective-canonical-request-ledger.js'", requestLedgerUrl], ["'./objective-canonical-basis.js'", basisLabel],
  ["'./objective-canonical-owner-directory.js'", ownersUrl], ["'./strategy-context-plane.client.js'", contextLabel],
], [['@Injectable()\n', ''], [constructor, '  constructor(prisma, authority, contextPlane, owners) {\n' +
  '    this.prisma = prisma; this.authority = authority; this.contextPlane = contextPlane; this.owners = owners;\n  }']]);
const unusedApplicationFence = moduleUrl(`export function requireCanonicalApplicationFence(){throw new Error('Planner application is outside this fixture');}
export function requireCanonicalApplicationRead(){throw new Error('Planner retained outputs are outside this fixture');}`);
const producerConstructor = '  constructor(private readonly prisma: PrismaService, private readonly authority: ObjectiveCanonicalWorkloadAuthority) {}';
const producerServiceUrl = await load('../src/meri/objective-canonical-producer.service.ts', [
  ["'@nestjs/common'", nest], ["'../prisma/prisma.service.js'", prismaLabel], ["'../planner/objective-canonical-authority.js'", authorityUrl],
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'../planner/objective-canonical-fence.js'", unusedApplicationFence],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-canonical-generation-fence.js'", fenceUrl],
  ["'./objective-canonical-producer-ledger.js'", ownerLedgerUrl], ["'./objective-canonical-producer.js'", producerUrl],
  ["'./objective-canonical-request-ledger.js'", requestLedgerUrl], ["'./objective-canonical-request.js'", factoryUrl],
], [['@Injectable()\n', ''], [producerConstructor, '  constructor(prisma, authority) { this.prisma = prisma; this.authority = authority; }']]);
const app = await import(applicationUrl), generation = await import(generationUrl), factory = await import(factoryUrl);
const pureBasis = await import(pureBasisUrl), regenerationFactory = await import(regenerationFactoryUrl);
const requestLedger = await import(requestLedgerUrl), ownerLedger = await import(ownerLedgerUrl);
const { ObjectiveCanonicalRequestService } = await import(serviceUrl);
const { ObjectiveCanonicalProducerService } = await import(producerServiceUrl);
const { ObjectiveCanonicalWorkloadAuthority } = await import(authorityUrl);
const { ObjectiveCanonicalOwnerDirectory } = await import(ownersUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const copy = value => structuredClone(value), hash = char => char.repeat(64);
const NOW = Date.parse('2026-10-16T06:00:00.000Z');
const body = { schemaVersion: 1, generationJobId: id(10) };
const http = Object.freeze({ synthetic: true });
function httpError(code, status = 503) { return error => {
  assert.equal(error.getStatus(), status); assert.equal(error.getResponse().code, code);
  assert.equal(error.getResponse().outcome, 'unconfirmed'); return true;
}; }

function facts() {
  const intent = { outcome: ' Exact outcome ', governmentProblem: 'Actual source context', askType: 'both', minimumWin: 'Reviewed minimum win', limits: ' Retain limits ' };
  const snapshot = { id: id(4), clientId: id(3), version: 2, status: 'ready', deletedAt: null, ...intent };
  const canonical = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4), canonicalStrategyId: id(5),
    canonicalProjectId: id(6), bindingVersion: 2, epoch: 1, requestedIntentId: id(7), requestedObjectiveRevisionId: id(8),
    requestedObjectiveVersion: 2, snapshotHash: app.applicationHash(snapshot) };
  const admission = { schemaVersion: 1, namespace: generation.GENERATION_ADMISSION_NAMESPACE, canonical,
    actorUserId: id(9), clerkUserId: 'user_fixture', consentId: id(12), controlVersion: 3, generationJobId: id(10), generationRequestId: id(11),
    admittedAtMs: NOW - 60000, effectExpiresAtMs: NOW + 1200000, expectedStrategyVersionId: null };
  const source = { clientId: id(3), objectiveId: id(4), objectiveVersion: 2, objectiveRevisionId: id(8) };
  const request = { requestId: id(11), clientId: id(3), objective: { objectiveId: id(4), objectiveVersion: 2 }, type: 'authorization' };
  const pending = { reobservedAt: null, state: 'pending', packetId: null, compiledAt: null, sourceDigest: null, coverageDigest: null, inputDigest: null, issues: [] };
  const job = { tenantId: id(2), id: id(10), clientId: id(3), ownerUserId: admission.clerkUserId, status: 'queued', attempt: 1,
    claimedBy: null, claimedAt: null, strategyId: null, deadlineMs: String(admission.effectExpiresAtMs),
    requestKey: `objective-v1:${app.applicationHash([id(2), admission.clerkUserId, id(11)])}`,
    input: { bearer: null, canonicalGeneration: ownerLedger.generationMarker(admission),
      dto: { clientId: id(3), type: 'authorization', goal: '  Exact queued goal\n', meriContext: ' Actual context ', ownerUserId: 'user_fixture', targetDate: '2028-02-29', attachmentIds: [] },
      objectiveGeneration: { request, fingerprint: app.applicationHash(request),
        receipt: { schemaVersion: 1, requestId: id(11), source, context: pending, result: null, failure: null } } } };
  const prompt = 'Literal governed prompt\naccepted history and pending evidence stay distinct.\n';
  const context = { reobservedAt: null, state: 'complete', packetId: id(20), compiledAt: new Date(NOW - 1000).toISOString(),
    sourceDigest: app.applicationHash({ source, intent }), coverageDigest: hash('b'), inputDigest: null, issues: [] };
  const compiled = { tenantId: id(2), clerkUserId: admission.clerkUserId, requestId: id(11), type: 'authorization', source, intent,
    localDigest: hash('c'), externalDigest: hash('d'), historyDigest: hash('e'), historyObservedAt: new Date(NOW - 2000).toISOString(),
    contactIds: [id(90)], context, coverage: [{ group: 'synthetic', state: 'available' }] };
  context.inputDigest = app.applicationHash({ sourceDigest: context.sourceDigest, coverageDigest: context.coverageDigest,
    packetId: context.packetId, requestId: id(11), type: 'authorization', localDigest: compiled.localDigest, externalDigest: compiled.externalDigest,
    historyDigest: compiled.historyDigest, promptDigest: app.applicationHash(prompt) });
  const typed = { schemaVersion: 1, tenantId: id(2), clerkUserId: admission.clerkUserId, requestId: id(11), source, intent,
    snapshotSha256: canonical.snapshotHash, sourceDigest: context.sourceDigest, packetId: context.packetId, compiledAt: context.compiledAt,
    coverageDigest: context.coverageDigest, promptSha256: sha(prompt), evidence: [
      { ref: `profile-fill:${id(30)}:${hash('f')}`, sourceId: id(30), asOfMs: NOW - 5000, scope: 'client', clientId: id(3), reviewState: 'accepted' },
      { ref: `profile-fill:${id(31)}:${hash('a')}`, sourceId: id(31), asOfMs: NOW - 2000, scope: 'client', clientId: id(3), reviewState: 'pending' },
    ] };
  const rowId = generation.generationLedgerId(generation.GENERATION_ADMISSION, id(2), admission.clerkUserId, id(10));
  const rows = new Map([[rowId, { id: rowId, tenantId: id(2), ownerId: admission.clerkUserId, projectId: null,
    kind: generation.GENERATION_ADMISSION, version: 1, archived: false, shareTokenHash: null, data: copy(admission) }]]);
  return { admission, canonical, snapshot, job, rows, compiled, typed, prompt };
}

// Structurally coherent pure-checker packet. No row or reference here claims
// native ownership, completeness, accepted-run custody or history replay.
function regenerationBasis(admission) {
  const node = (nodeId, title, machine = true) => ({ id: nodeId, kind: 'action', subject: 'Exact subject', title,
    note: null, ownerUserId: 'user_fixture', status: 'planned', startsOn: '2026-10-16', endsOn: null,
    openEnded: true, dependsOnIds: [], meriAuthored: machine, createdByUserId: machine ? 'user_fixture' : 'user_human',
    createdAt: '2026-10-15T12:00:00.000Z', provenance: { sources: [{ confidence: 0.75 }] } });
  const meta = { id: id(5), clientId: id(3), title: 'Human current title', type: 'authorization',
    goal: 'Human current goal', meriContext: null, meriSummary: 'Prior machine summary', targetDate: null,
    ownerUserId: 'user_fixture', createdByUserId: 'user_fixture', createdAt: '2026-10-15T12:00:00.000Z' };
  const oldJob = id(51), normId = generation.generationLedgerId(generation.GENERATION_NORMALIZATION, id(2), 'user_fixture', oldJob);
  return sealRegenerationBasis({ schemaVersion: 1, namespace: 'capiro.objective-strategy.basis:v1',
    canonical: copy(admission.canonical), sourceAdmissionSha256: generation.canonicalGenerationAdmissionSha256(admission),
    strategyId: id(5), expectedStrategyVersionId: admission.expectedStrategyVersionId,
    snapshot: { meta, nodes: [node(id(70), 'Human edited machine title'), node(id(71), 'Human-only node', false)] },
    archiveIndex: [{ nodeId: id(72), archivedAt: '2026-10-16T05:00:00.000Z' }],
    sourceIndex: [
      { sourceNodeKey: 'archived_step', nodeId: id(72), archived: true,
        lastMachine: { normalizationId: normId, node: node(id(72), 'Archived machine baseline') } },
      { sourceNodeKey: 'machine_step', nodeId: id(70), archived: false,
        lastMachine: { normalizationId: normId, node: node(id(70), 'Original machine title') } },
    ], lastMachineStrategy: { normalizationId: normId, meta: { ...copy(meta), title: 'Prior machine title', goal: 'Prior machine goal' } },
    provenance: [{ ownerUserId: 'user_fixture', generationJobId: oldJob, generationRequestId: id(52), canonicalBindingVersion: 1,
      admissionId: generation.generationLedgerId(generation.GENERATION_ADMISSION, id(2), 'user_fixture', oldJob), admissionSha256: hash('b'),
      acceptanceId: generation.generationLedgerId(generation.GENERATION_ACCEPTANCE, id(2), 'user_fixture', oldJob), acceptanceSha256: hash('c'),
      normalizationId: normId, normalizationSha256: hash('d'),
      producerId: generation.generationLedgerId(generation.GENERATION_PRODUCER, id(2), 'user_fixture', oldJob), producerSha256: hash('e'),
      strategyVersionId: id(53), snapshotSha256: hash('f') }],
  });
}
function sealRegenerationBasis(basis) {
  basis.snapshotSha256 = app.applicationHash(basis.snapshot);
  basis.sourceIndexSha256 = app.applicationHash(basis.sourceIndex);
  basis.archiveIndexSha256 = app.applicationHash(basis.archiveIndex);
  return basis;
}

/** Serialized cloned state models rollback for the ACTUAL service. It is not a
 * DB interpreter, shared PostgreSQL lock or multi-connection qualification. */
class PublisherFixture {
  constructor({ regeneration = false } = {}) {
    const f = facts(); this.data = { job: f.job, rows: f.rows };
    if (regeneration) {
      f.admission.expectedStrategyVersionId = id(50);
      const rowId = generation.generationLedgerId(generation.GENERATION_ADMISSION, id(2), 'user_fixture', id(10));
      this.data.rows.get(rowId).data = copy(f.admission);
    }
    this.initial = copy(f);
    this.admission = f.admission; this.canonical = f.canonical; this.snapshot = f.snapshot;
    this.currentStrategyVersionId = this.admission.expectedStrategyVersionId;
    this.currentBasis = regeneration ? regenerationBasis(this.admission) : null;
    this.compiled = f.compiled; this.typed = f.typed; this.prompt = f.prompt;
    this.now = NOW; this.depth = 0; this.sequence = 0; this.tail = Promise.resolve(); this.events = []; this.callScope = new AsyncLocalStorage();
    this.member = true; this.currentObjective = true; this.wall = false; this.wallGrant = true; this.feature = true;
    this.cancelled = false; this.consentId = this.admission.consentId; this.controlVersion = 3;
    this.ownerRows = [{ clerkUserId: 'user_fixture' }, { clerkUserId: 'user_secondary' }];
    this.compileHook = null; this.recheckHook = null; this.afterInsert = null; this.beforeFinal = null; this.onSnapshotRead = null;
    this.updateCount = 1; this.verifyDenied = false; this.claimDenied = false; this.compileCount = 0; this.recheckCount = 0;
    this.authority = {
      verifyGeneration: async (_request, subject) => {
        this.event('verify', { subject: copy(subject) });
        if (this.verifyDenied) throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
        return { tenantId: id(2), actorUserId: id(9), clerkUserId: 'user_fixture', consentId: this.consentId, controlVersion: this.controlVersion,
          requestSha256: subject.requestSha256, checkedAtMs: this.now, expiresAtMs: this.now + 1800000,
          delegationExpiresAtMs: this.now + 1800000, claimExpiresAtMs: this.now + 1800000,
          delegation: { ref: id(40), revision: 'synthetic-delegation:7', issuedAtMs: NOW - 120000, absoluteExpiresAtMs: NOW + 1800000 } };
      },
      assertGenerationCurrent: async (_tx, _grant, subject) => {
        assert.equal(this.depth, 1); this.event('currentProof', { phase: subject.phase });
        if (this.claimDenied) throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
      },
    };
    this.contextPlane = {
      compile: async (request, onCompiled, onTyped) => {
        assert.equal(this.callScope.getStore().txDepth, 0, 'context compile must be outside this request transaction');
        this.compileCount++; this.event('compile', { request: copy(request) });
        if (this.compileHook) await this.compileHook(this);
        await onCompiled(copy(this.compiled)); await onTyped(copy(this.typed));
        return { prompt: this.prompt };
      },
      recheckObjective: async (request, observed) => {
        assert.equal(this.callScope.getStore().txDepth, 0, 'source/history re-observation must be outside this request transaction');
        this.recheckCount++; this.event('recheck', { request: copy(request), observed: copy(observed) });
        if (this.recheckHook) await this.recheckHook(this);
      },
    };
    this.prisma = { withTenantUser: (tenant, clerk, run, options) => this.transaction(tenant, clerk, run, options),
      withTenant: (tenant, run, options) => this.transaction(tenant, 'user_fixture', run, options) };
    this.service = new ObjectiveCanonicalRequestService(this.prisma, this.authority, this.contextPlane, new ObjectiveCanonicalOwnerDirectory());
    this.producerService = new ObjectiveCanonicalProducerService(this.prisma, this.authority);
  }
  event(method, detail = {}) { this.events.push({ method, depth: this.depth, requestTxDepth: this.callScope.getStore()?.txDepth ?? 0, ...detail }); }
  publicationId() { return generation.generationLedgerId(generation.GENERATION_REQUEST, id(2), 'user_fixture', id(10)); }
  stored() { return this.data.rows.get(this.publicationId())?.data; }
  acceptanceId() { return generation.generationLedgerId(generation.GENERATION_ACCEPTANCE, id(2), 'user_fixture', id(10)); }
  prepareAcceptance() {
    const publication = this.stored().publication;
    const binding = { tenantId: id(2), actorId: 'user_fixture', conversationId: id(60), runId: id(61),
      attemptId: id(62), workerId: id(63), writerFence: 7 };
    this.acceptanceProof = { sourceAdmission: copy(this.admission), sourceAdmissionSha256: app.applicationHash(this.admission),
      sourceBinding: binding, sourceRequestSha256: hash('2'),
      issuance: { issuanceKey: generation.generationBindingKey(binding), binding: copy(binding), requestSha256: hash('2'),
        expiresAtMs: publication.request.originalExpiresAtMs, grantId: id(64), capabilitySha256: hash('3'), factsSha256: hash('4') },
      typedRequestSha256: publication.requestSha256, executionContextSha256: factory.candidateJcsSha256(publication.executionContext),
      acceptedRequestId: this.admission.generationRequestId, acceptedPromptSha256: publication.executionContext.promptSha256 };
    this.authority.verifyGenerationAcceptance = async (request, subject) => {
      this.event('verifyAcceptance', { subject: copy(subject) });
      return { ...copy(this.acceptanceProof), grant: await this.authority.verifyGeneration(request, subject) };
    };
  }
  async transaction(tenant, clerk, run, options) {
    assert.equal(tenant, id(2)); assert.equal(clerk, 'user_fixture'); assert.deepEqual(options, { timeoutMs: 15000 });
    const prior = this.tail; let release; this.tail = new Promise(resolve => { release = resolve; }); await prior;
    const txId = ++this.sequence, call = this.callScope.getStore();
    try {
      assert.equal(this.depth, 0); this.depth = 1; call.txDepth = 1; this.event('begin', { txId });
      if (txId === 2 && this.beforeFinal) await this.beforeFinal(this);
      const staged = copy(this.data);
      const tx = this.ports(staged, txId), result = await run(tx);
      this.data = staged; this.event('commit', { txId }); return result;
    } catch (error) { this.event('rollback', { txId }); throw error; }
    finally { this.depth = 0; call.txDepth = 0; release(); }
  }
  ports(staged, txId) {
    const event = (method, detail = {}) => this.event(method, { txId, ...detail });
    const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
    return {
      $queryRaw: async (strings, ...values) => {
        const sql = strings.join('?').replace(/\s+/g, ' ').trim(); event('sql', { sql, values });
        if (sql.startsWith('SELECT ceil(')) return [{ ms: String(this.now), nowMs: String(this.now) }];
        if (sql.includes('FROM sp_draft_job')) return sql.includes('deadline_at') ? [copy(staged.job)] : [{ id: staged.job.id }];
        if (sql.includes('FROM sp_strategy')) return this.currentStrategyVersionId === null ? [] :
          [{ id: this.canonical.canonicalStrategyId, clientId: this.canonical.clientId, archived: false }];
        if (sql.includes('FROM sp_version')) return this.currentStrategyVersionId === null ? [] :
          [{ id: this.currentStrategyVersionId, coalescible: false }];
        if (sql.includes('FROM client_objective_canonical_plans')) return [copy(this.canonical)];
        if (sql.includes('FROM users u JOIN tenant_memberships')) return this.member ? [{ actorUserId: id(9) }] : [];
        if (sql.startsWith('SELECT m.user_id')) return this.member ? [{ userId: id(9), memoryWall: this.wall }] : [];
        if (sql.includes('FROM client_memory_access')) return this.wallGrant ? [{ id: id(91) }] : [];
        if (sql.startsWith('SELECT version FROM client_objectives')) return this.currentObjective ? [{ version: this.canonical.requestedObjectiveVersion }] : [];
        if (sql.includes('FROM client_objective_revisions')) {
          if (sql.startsWith('SELECT snapshot')) {
            if (this.onSnapshotRead) await this.onSnapshotRead(this, staged);
            return [{ snapshot: copy(this.snapshot) }];
          }
          return [{ id: this.canonical.requestedObjectiveRevisionId }];
        }
        if (sql.includes('FROM client_objective_work_intents')) return this.feature ? [{ rootActorUserId: id(19), revisionActor: id(19),
          hash: this.canonical.snapshotHash, snapshot: copy(this.snapshot), operation: 'confirm_ready', purpose: 'objective_strategy_plan',
          state: 'pending', blocker: 'runtime_authority_unconnected', ready: true }] : [];
        if (sql.includes('FROM client_objective_work_controls')) return this.cancelled ? [] : [{
          consentId: this.consentId, controlVersion: this.controlVersion, actorUserId: id(9), membershipId: id(13), currentMembershipId: id(13), rootActorUserId: id(19),
          policyId: 'capiro.objective-generation-consent', policyRevision: 1, configured: '1800000', effective: '1800000',
          confirmedMs: String(NOW - 60000), expiresMs: String(NOW + 1740000), validExpiry: true }];
        if (sql.startsWith('SELECT u.id') && sql.includes('FROM tenants')) return this.member && this.feature ? [{ actorUserId: id(9), memoryWall: this.wall }] : [];
        if (sql.startsWith('SELECT id::text AS id FROM client_objectives')) return this.currentObjective ? [{ id: id(4) }] : [];
        if (sql.includes('SELECT u.clerk_user_id') && sql.includes('FROM tenant_memberships')) return copy(this.ownerRows);
        throw new Error(`Unimplemented synthetic SQL: ${sql}`);
      },
      spDraftJob: {
        findFirst: async ({ where }) => { event('readJob'); return matches(staged.job, where) ? copy(staged.job) : null; },
        updateMany: async ({ where, data }) => {
          event('updateJob'); if (!matches(staged.job, where) || this.updateCount !== 1) return { count: 0 };
          Object.assign(staged.job, copy(data)); return { count: 1 };
        },
      },
      spPlannerResource: {
        findFirst: async ({ where }) => { event('readLedger'); const row = staged.rows.get(where.id); return row && matches(row, where) ? copy(row) : null; },
        create: async ({ data }) => {
          event('insertLedger', { kind: data.kind }); assert.equal(staged.rows.has(data.id), false);
          staged.rows.set(data.id, copy(data)); if (this.afterInsert) await this.afterInsert(this, staged); return copy(data);
        },
      },
      syntheticCaptureCanonicalStrategyBasis: async admission => {
        const actual = generation.parseCanonicalGenerationAdmission(admission);
        event('syntheticBasisCapture', { expectedStrategyVersionId: actual.expectedStrategyVersionId });
        assert.equal(this.depth, 1); assert.equal(this.callScope.getStore().txDepth, 1);
        if (actual.expectedStrategyVersionId === null) {
          if (this.currentBasis !== null) throw new app.CanonicalApplicationError('OUTCOME_UNCONFIRMED');
          return null;
        }
        if (!this.currentBasis) throw new app.CanonicalApplicationError('OUTCOME_UNCONFIRMED');
        return pureBasis.checkCanonicalStrategyBasis(copy(this.currentBasis), actual);
      },
      $executeRaw: async () => { throw Error('Initial publisher must not execute model/Strategy mutations'); },
    };
  }
  publish() { return this.callScope.run({ txDepth: 0 }, () => this.service.publish(http, copy(body))); }
  lookup() { return this.callScope.run({ txDepth: 0 }, () => this.service.lookup(http, body.generationJobId)); }
  accept() { return this.callScope.run({ txDepth: 0 }, () => this.producerService.accept(http, copy(body))); }
}

test('custody covers the actual service, request ledger, factory, job helper and authority/fences with declared DI edits', t => {
  for (const path of ['objective-canonical-request.service.ts','objective-canonical-request-ledger.ts','objective-canonical-job-input.ts',
    'objective-canonical-request.ts','objective-canonical-authority.ts','objective-canonical-generation-fence.ts','objective-canonical-producer.service.ts',
    'objective-canonical-basis.ts','objective-canonical-regeneration-request.ts'])
    assert.equal(custody.filter(entry => entry.path.endsWith(path)).length, 1);
  const service = custody.find(entry => entry.path.endsWith('objective-canonical-request.service.ts'));
  assert.equal(service.sourceEdits.length, 2); assert.equal(service.sourceEdits[1], constructor);
  for (const entry of custody) assert.match(entry.rawSha256, /^[a-f0-9]{64}$/);
  t.diagnostic(JSON.stringify({ sourceCustody: custody, qualification: 'actual pure basis checker; named synthetic capture port and synthetic source ports only; no DB/history custody/network/model/authentic authority' }));
});

test('actual default genuine authority denies before opening a DB transaction or compiling context', async () => {
  const x = new PublisherFixture();
  x.service = new ObjectiveCanonicalRequestService(x.prisma, new ObjectiveCanonicalWorkloadAuthority(), x.contextPlane, new ObjectiveCanonicalOwnerDirectory());
  x.producerService = new ObjectiveCanonicalProducerService(x.prisma, new ObjectiveCanonicalWorkloadAuthority());
  await assert.rejects(() => x.publish(), httpError('AUTHORITY_UNAVAILABLE'));
  await assert.rejects(() => x.lookup(), httpError('AUTHORITY_UNAVAILABLE'));
  await assert.rejects(() => x.accept(), httpError('AUTHORITY_UNAVAILABLE'));
  assert.equal(x.sequence, 0); assert.equal(x.compileCount, 0); assert.equal(x.recheckCount, 0);
});

test('initial typed publication admits queued attempt1 and refuses circular accepted/running or reclaimed jobs before compile', async () => {
  for (const change of [x => { x.data.job.status = 'running'; x.data.job.attempt = 2; x.data.job.claimedBy = 'canonical:' + hash('a'); },
    x => { x.data.job.attempt = 2; }, x => { x.data.job.claimedAt = new Date(NOW); }, x => { x.data.job.claimedBy = 'legacy'; }]) {
    const x = new PublisherFixture(); change(x); const before = copy(x.data);
    await assert.rejects(() => x.publish(), httpError('AUTHORITY_UNAVAILABLE'));
    assert.deepEqual(x.data, before); assert.equal(x.compileCount, 0); assert.equal(x.stored(), undefined);
  }
});

test('actual compile/recheck occur outside tx and exact prompt/context/owner pairs persist once in the owner publication', async () => {
  const x = new PublisherFixture(), inputBefore = copy(x.data.job.input), result = await x.publish();
  assert.equal(x.compileCount, 1); assert.equal(x.recheckCount, 1); assert.equal(x.sequence, 2);
  assert.ok(x.events.filter(e => ['compile','recheck'].includes(e.method)).every(e => e.depth === 0));
  assert.equal(result.executionContext.prompt, x.prompt); assert.equal(result.executionContext.promptSha256, sha(x.prompt));
  assert.deepEqual(result.executionContext.ownerRefs, x.ownerRows.map(row => ({ ownerRef: row.clerkUserId, clerkUserId: row.clerkUserId })));
  assert.deepEqual(result.request.context.evidence, x.typed.evidence); assert.deepEqual(result.request.source.intent, x.typed.intent);
  assert.equal(result.request.context.packetId, x.typed.packetId); assert.equal(result.request.context.asOfMs, Date.parse(x.typed.compiledAt));
  assert.equal(result.request.input.goal, inputBefore.dto.goal); assert.equal(result.request.basis, null);
  assert.deepEqual(x.data.job.input.dto, inputBefore.dto); assert.deepEqual(x.data.job.input.objectiveGeneration.request, inputBefore.objectiveGeneration.request);
  assert.deepEqual(x.data.job.input.objectiveGeneration.receipt.context, x.compiled.context);
  assert.equal(x.data.job.status, 'queued'); assert.equal(x.data.job.attempt, 1); assert.equal(x.data.job.claimedBy, null);
  assert.equal(x.events.filter(e => e.method === 'insertLedger').length, 1);
  const stored = x.stored(); assert.equal(stored.publicationSha256, factory.candidateJcsSha256(result));
  assert.deepEqual(stored.compiled, x.compiled); assert.deepEqual(stored.publication, result);
  assert.deepEqual((await requestLedger.readCanonicalRequestPublication(x.ports(copy(x.data), -1), x.admission)).publication, result);
});

test('immutable input, source admission and current consent are rechecked after outside compilation', async () => {
  for (const [change, expected] of [
    [x => { x.data.job.input.dto.goal = 'Changed during compile'; }, 'REQUEST_CONFLICT'],
    [x => { x.data.job.input.objectiveGeneration.receipt.source.objectiveRevisionId = id(99); }, 'OUTCOME_UNCONFIRMED'],
    [x => { x.consentId = id(99); }, 'SOURCE_STALE'],
    [x => { x.canonical.bindingVersion++; }, 'SOURCE_STALE'],
    [x => { x.cancelled = true; }, 'AUTHORITY_UNAVAILABLE'],
  ]) {
    const x = new PublisherFixture(); let afterOutside;
    x.recheckHook = fixture => { change(fixture); afterOutside = copy(fixture.data); };
    await assert.rejects(() => x.publish(), httpError(expected, expected === 'REQUEST_CONFLICT' || expected === 'SOURCE_STALE' ? 409 : 503));
    assert.deepEqual(x.data, afterOutside); assert.equal(x.stored(), undefined);
    assert.equal(x.events.some(e => e.method === 'updateJob'), false);
  }
});

test('expiry, claim loss or revocation after insertion rolls back both staged job context and publication', async () => {
  for (const [change, expected] of [
    [x => { x.now = x.admission.effectExpiresAtMs; }, 'AUTHORITY_UNAVAILABLE'],
    [x => { x.claimDenied = true; }, 'AUTHORITY_UNAVAILABLE'],
    [x => { x.member = false; }, 'AUTHORITY_UNAVAILABLE'],
    [x => { x.cancelled = true; }, 'AUTHORITY_UNAVAILABLE'],
  ]) {
    const x = new PublisherFixture(), before = copy(x.data); x.afterInsert = change;
    await assert.rejects(() => x.publish(), httpError(expected, expected === 'SOURCE_STALE' ? 409 : 503));
    assert.deepEqual(x.data, before); assert.equal(x.stored(), undefined);
    assert.equal(x.events.filter(e => e.method === 'updateJob').length, 1);
    assert.equal(x.events.filter(e => e.method === 'insertLedger').length, 1);
    assert.equal(x.events.at(-1).method, 'rollback');
  }
});

test('original typed-request deadline is checked after staged insert, independently of later consent expiry', async () => {
  const x = new PublisherFixture(), before = copy(x.data); x.afterInsert = owner => { owner.now = NOW + 900000; };
  await assert.rejects(() => x.publish(), httpError('AUTHORITY_UNAVAILABLE'));
  assert.deepEqual(x.data, before); assert.equal(x.stored(), undefined);
});

test('delay in final retained revision reconstruction crossing only the typed deadline rolls back the publication and context', async () => {
  const x = new PublisherFixture(), before = copy(x.data);
  x.onSnapshotRead = fixture => { fixture.now = NOW + 900000; };
  await assert.rejects(() => x.publish(), httpError('AUTHORITY_UNAVAILABLE'));
  assert.ok(x.now < x.admission.effectExpiresAtMs, 'overall consent/job admission is still live');
  assert.deepEqual(x.data, before); assert.equal(x.stored(), undefined);
  assert.equal(x.events.filter(e => e.method === 'insertLedger').length, 1);
  assert.equal(x.events.filter(e => e.method === 'updateJob').length, 1);
  const revisionIndex = x.events.findIndex(e => e.method === 'sql' && e.sql.startsWith('SELECT snapshot FROM client_objective_revisions'));
  assert.ok(revisionIndex >= 0);
  assert.equal(x.events.slice(revisionIndex + 1).some(e => e.method === 'currentProof'), true);
  assert.equal(x.events.at(-1).method, 'rollback');
});

test('POST replay and GET after original expiry return identical historical bytes with fresh read admission and no compilation/renewal', async () => {
  const x = new PublisherFixture(), original = await x.publish(), originalBytes = JSON.stringify(original), before = copy(x.data);
  x.now = NOW + 3600000; x.cancelled = true; x.currentObjective = true;
  assert.ok(x.now > original.request.originalExpiresAtMs);
  assert.equal(JSON.stringify(await x.publish()), originalBytes); assert.equal(JSON.stringify(await x.lookup()), originalBytes);
  assert.deepEqual(x.data, before); assert.equal(x.compileCount, 1); assert.equal(x.recheckCount, 1);
  assert.equal(x.events.filter(e => e.method === 'insertLedger').length, 1);
  x.member = false; const count = x.compileCount;
  await assert.rejects(() => x.lookup(), httpError('AUTHORITY_UNAVAILABLE')); assert.equal(x.compileCount, count);
});

test('GET missing is 503/unconfirmed and never compiles, claims, updates job or creates a publication', async () => {
  const x = new PublisherFixture(), before = copy(x.data);
  await assert.rejects(() => x.lookup(), httpError('OUTCOME_UNCONFIRMED'));
  assert.equal(x.compileCount, 0); assert.equal(x.recheckCount, 0); assert.deepEqual(x.data, before);
  assert.equal(x.events.some(e => ['updateJob','insertLedger','compile'].includes(e.method)), false);
});

test('two callers compiling outside transactions converge on the one committed lock winner', { timeout: 5000 }, async () => {
  const x = new PublisherFixture(); let entered = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  x.compileHook = async () => { if (++entered === 2) release(); await gate; };
  const [first, second] = await Promise.all([x.publish(), x.publish()]);
  assert.equal(entered, 2); assert.equal(x.compileCount, 2); assert.deepEqual(first, second);
  assert.equal(x.events.filter(e => e.method === 'insertLedger').length, 1);
  assert.equal(x.events.filter(e => e.method === 'updateJob').length, 1);
  assert.equal(x.data.rows.size, 2);
});

test('failed job CAS or source re-observation publishes nothing and preserves original pending context', async () => {
  for (const mode of ['cas','recheck']) {
    const x = new PublisherFixture(), before = copy(x.data);
    if (mode === 'cas') x.updateCount = 0;
    else x.recheckHook = () => { throw Error('synthetic re-observation failure'); };
    await assert.rejects(() => x.publish(), httpError('OUTCOME_UNCONFIRMED'));
    assert.deepEqual(x.data, before); assert.equal(x.events.some(e => e.method === 'insertLedger'), false);
  }
});

test('private publication hash detects a self-consistent owner-pair sidecar rewrite outside the candidate Request hash', async () => {
  const x = new PublisherFixture(); await x.publish(); const saved = x.stored(), originalRequestHash = saved.publication.requestSha256;
  saved.publication.executionContext.ownerRefs[1].clerkUserId = 'user_other';
  assert.equal(saved.publication.requestSha256, originalRequestHash);
  // Factory reconstruction alone accepts this same-ref/changed-value sidecar;
  // the separately retained whole-publication hash must refuse it.
  assert.doesNotThrow(() => factory.checkCanonicalRequestPublication(saved.publication, { admission: x.admission, dto: x.data.job.input.dto }));
  await assert.rejects(() => x.lookup(), httpError('OUTCOME_UNCONFIRMED'));
  assert.equal(x.compileCount, 1);
});

test('compiled prompt digest rejects prompt+promptSHA+publicationSHA rewrites even when the candidate factory is self-consistent', async () => {
  const x = new PublisherFixture(); await x.publish(); const saved = x.stored();
  saved.publication.executionContext.prompt = 'Changed private prompt';
  saved.publication.executionContext.promptSha256 = sha(saved.publication.executionContext.prompt);
  saved.publicationSha256 = factory.candidateJcsSha256(saved.publication);
  assert.doesNotThrow(() => factory.checkCanonicalRequestPublication(saved.publication, { admission: x.admission, dto: x.data.job.input.dto }));
  await assert.rejects(() => x.lookup(), httpError('OUTCOME_UNCONFIRMED'));
  assert.equal(x.compileCount, 1);
});

test('exact saved Objective revision refuses self-consistent publication/compiled intent rewrites', async () => {
  const x = new PublisherFixture(); await x.publish(); const saved = x.stored(), typed = copy(x.typed);
  typed.intent.outcome = 'Changed intent absent from actual saved revision';
  typed.sourceDigest = app.applicationHash({ source: typed.source, intent: typed.intent });
  saved.compiled.intent = copy(typed.intent); saved.compiled.context.sourceDigest = typed.sourceDigest;
  saved.compiled.context.inputDigest = app.applicationHash({ sourceDigest: typed.sourceDigest,
    coverageDigest: saved.compiled.context.coverageDigest, packetId: typed.packetId, requestId: x.admission.generationRequestId,
    type: x.data.job.input.dto.type, localDigest: saved.compiled.localDigest, externalDigest: saved.compiled.externalDigest,
    historyDigest: saved.compiled.historyDigest, promptDigest: app.applicationHash(x.prompt) });
  const original = saved.publication;
  saved.publication = factory.createCanonicalRequestPublication({ admission: x.admission, dto: x.data.job.input.dto,
    context: typed, prompt: x.prompt, owners: original.executionContext.ownerRefs, delegation: original.request.delegation,
    requestedAtMs: original.request.requestedAtMs, effectExpiresAtMs: original.request.originalExpiresAtMs });
  saved.publicationSha256 = factory.candidateJcsSha256(saved.publication);
  x.data.job.input.objectiveGeneration.receipt.context = copy(saved.compiled.context);
  assert.doesNotThrow(() => factory.checkCanonicalRequestPublication(saved.publication, { admission: x.admission, dto: x.data.job.input.dto }));
  await assert.rejects(() => x.lookup(), httpError('OUTCOME_UNCONFIRMED'));
  assert.equal(x.compileCount, 1);
});

test('actual accept refuses missing owner publication before recording acceptance or claiming the job', async () => {
  const x = new PublisherFixture(); await x.publish(); x.prepareAcceptance(); x.data.rows.delete(x.publicationId());
  const before = copy(x.data);
  await assert.rejects(() => x.accept(), httpError('OUTCOME_UNCONFIRMED'));
  assert.deepEqual(x.data, before); assert.equal(x.data.rows.has(x.acceptanceId()), false);
  assert.equal(x.data.job.status, 'queued'); assert.equal(x.compileCount, 1);
});

test('actual accept refuses each missing or mismatched protected request/context/prompt identity and expanded issuance deadline', async () => {
  for (const [field, wrong] of [['typedRequestSha256', hash('0')], ['executionContextSha256', hash('0')],
    ['acceptedRequestId', id(99)], ['acceptedPromptSha256', hash('0')]]) {
    for (const value of [wrong, undefined]) {
      const x = new PublisherFixture(); await x.publish(); x.prepareAcceptance();
      if (value === undefined) delete x.acceptanceProof[field]; else x.acceptanceProof[field] = value;
      const before = copy(x.data);
      await assert.rejects(() => x.accept(), httpError('REQUEST_CONFLICT', 409));
      assert.deepEqual(x.data, before); assert.equal(x.data.rows.has(x.acceptanceId()), false);
    }
  }
  const x = new PublisherFixture(); await x.publish(); x.prepareAcceptance();
  x.acceptanceProof.issuance.expiresAtMs = x.stored().publication.request.originalExpiresAtMs + 1;
  const before = copy(x.data);
  await assert.rejects(() => x.accept(), httpError('REQUEST_CONFLICT', 409));
  assert.deepEqual(x.data, before);
});

test('coherent original protected proof records actual acceptance and advances only the queued claim', async () => {
  const x = new PublisherFixture(), publication = await x.publish(); x.prepareAcceptance();
  const beforeInput = copy(x.data.job.input), result = await x.accept();
  assert.equal(result.sourceAdmissionSha256, app.applicationHash(x.admission));
  assert.deepEqual(result.sourceBinding, x.acceptanceProof.sourceBinding); assert.deepEqual(result.issuance, x.acceptanceProof.issuance);
  assert.notEqual(result.sourceRequestSha256, publication.requestSha256); // Distinct issuer/request domains.
  assert.equal(x.data.job.status, 'running'); assert.equal(x.data.job.stage, 'drafting'); assert.equal(x.data.job.attempt, 2);
  assert.equal(x.data.job.claimedBy, `canonical:${x.acceptanceProof.issuance.issuanceKey}`);
  assert.equal(x.data.job.claimedAt.getTime(), NOW); assert.deepEqual(x.data.job.input, beforeInput);
  const acceptance = x.data.rows.get(x.acceptanceId()).data;
  assert.equal(acceptance.acceptedAtMs, NOW); assert.equal(acceptance.issuance.expiresAtMs, publication.request.originalExpiresAtMs);
  assert.equal(x.events.filter(e => e.method === 'insertLedger' && e.kind === generation.GENERATION_ACCEPTANCE).length, 1);
  assert.equal(x.compileCount, 1); assert.equal(x.recheckCount, 1);
});

test('accept at the original publication expiry refuses its nonpositive remaining issuance interval without claiming', async () => {
  const x = new PublisherFixture(); await x.publish(); x.prepareAcceptance();
  x.now = x.stored().publication.request.originalExpiresAtMs; const before = copy(x.data);
  // The actual acceptance parser rejects issuance<=acceptedAt before the later
  // explicit original-expiry branch. No synthetic parser bypass is supplied.
  await assert.rejects(() => x.accept(), httpError('INPUT_INVALID', 400));
  assert.deepEqual(x.data, before); assert.equal(x.data.job.status, 'queued'); assert.equal(x.data.rows.has(x.acceptanceId()), false);
});

test('acceptance insertion plus claim CAS failure rolls back the staged acceptance row', async () => {
  const x = new PublisherFixture(); await x.publish(); x.prepareAcceptance(); x.updateCount = 0;
  const before = copy(x.data);
  await assert.rejects(() => x.accept(), httpError('OUTCOME_UNCONFIRMED'));
  assert.deepEqual(x.data, before); assert.equal(x.data.rows.has(x.acceptanceId()), false);
  assert.equal(x.events.some(e => e.method === 'insertLedger' && e.kind === generation.GENERATION_ACCEPTANCE), true);
});

test('missing delegation, current memory-wall grant or private ledger access metadata never becomes issuance', async () => {
  for (const mode of ['delegation','wall','share']) {
    const x = new PublisherFixture(), before = copy(x.data);
    if (mode === 'delegation') { const verify = x.authority.verifyGeneration; x.authority.verifyGeneration = async (...args) => {
      const grant = await verify(...args); delete grant.delegation; return grant;
    }; }
    if (mode === 'wall') { x.wall = true; x.wallGrant = false; }
    if (mode === 'share') x.data.rows.values().next().value.shareTokenHash = hash('a');
    await assert.rejects(() => x.publish(), httpError(mode === 'share' ? 'OUTCOME_UNCONFIRMED' : 'AUTHORITY_UNAVAILABLE'));
    if (mode !== 'share') assert.deepEqual(x.data, before);
    assert.equal(x.compileCount, 0); assert.equal(x.stored(), undefined);
  }
});

test('named synthetic capture returns null only for initial admission and refuses missing or unknown regeneration packets', async () => {
  const initial = new PublisherFixture(), published = await initial.publish();
  assert.equal(published.request.basis, null);
  assert.equal(published.request.candidateVersion, factory.CANONICAL_STRATEGY_CANDIDATE_VERSION);
  assert.deepEqual(initial.events.filter(e => e.method === 'syntheticBasisCapture').map(e => e.expectedStrategyVersionId), [null, null]);
  for (const mutate of [x => { x.currentBasis = null; }, x => { x.currentBasis.schemaVersion = 99; },
    x => { x.currentBasis.namespace = 'unknown:owner'; }]) {
    const x = new PublisherFixture({ regeneration: true }), before = copy(x.data); mutate(x);
    await assert.rejects(() => x.publish(), httpError('OUTCOME_UNCONFIRMED'));
    assert.deepEqual(x.data, before); assert.equal(x.compileCount, 0);
    assert.equal(x.events.some(e => ['updateJob','insertLedger'].includes(e.method)), false);
  }
});

test('actual publisher captures unchanged basis in both transactions and commits the distinct private regeneration request', async () => {
  const x = new PublisherFixture({ regeneration: true }), beforeInput = copy(x.data.job.input), beforeBasis = copy(x.currentBasis);
  const result = await x.publish(), captures = x.events.filter(e => e.method === 'syntheticBasisCapture');
  assert.deepEqual(captures.map(e => e.txId), [1, 2]);
  assert.ok(captures.every(e => e.depth === 1 && e.expectedStrategyVersionId === id(50)));
  assert.equal(result.request.requestVersion, regenerationFactory.CORE_CANONICAL_REGENERATION_REQUEST_VERSION);
  assert.equal(Object.hasOwn(result.request, 'candidateVersion'), false); assert.equal(result.request.operation, 'strategy.draft');
  assert.deepEqual(result.request.applicationTarget, { mode: 'regenerate', canonical: x.admission.canonical, expectedStrategyVersionId: id(50) });
  assert.deepEqual(result.request.basis, beforeBasis); assert.equal(result.request.basisSha256, app.applicationHash(beforeBasis));
  assert.equal(result.request.basis.snapshot.nodes[0].title, 'Human edited machine title');
  assert.equal(result.request.basis.sourceIndex[1].lastMachine.node.title, 'Original machine title');
  assert.equal(result.request.basis.snapshot.nodes[1].meriAuthored, false);
  assert.equal(result.request.basis.snapshot.nodes[0].provenance.sources[0].confidence, 0.75);
  assert.equal(result.requestSha256, factory.privateRequestJcsSha256(result.request));
  assert.deepEqual(result.request.basis.archiveIndex, beforeBasis.archiveIndex);
  assert.equal(x.compileCount, 1); assert.equal(x.recheckCount, 1);
  assert.equal(x.events.filter(e => e.method === 'updateJob').length, 1);
  assert.equal(x.events.filter(e => e.method === 'insertLedger').length, 1);
  assert.equal(x.data.job.status, 'queued'); assert.equal(x.data.job.attempt, 1);
  assert.deepEqual(x.data.job.input.dto, beforeInput.dto);
  assert.deepEqual(x.data.job.input.objectiveGeneration.receipt.context, x.compiled.context);
  assert.deepEqual((await requestLedger.readCanonicalRequestPublication(x.ports(copy(x.data), -1), x.admission)).publication, result);
});

test('whole basis drift between compile and final transaction refuses SOURCE_STALE before any publication or job writes', async () => {
  for (const mutate of [b => { b.snapshot.nodes[0].title = 'New human edit'; },
    b => { b.sourceIndex[1].lastMachine.node.title = 'Different original baseline'; },
    b => { b.archiveIndex[0].archivedAt = '2026-10-16T05:01:00.000Z'; },
    b => { b.lastMachineStrategy.meta.title = 'Different prior machine title'; },
    b => { b.provenance[0].acceptanceSha256 = hash('0'); }]) {
    const x = new PublisherFixture({ regeneration: true }), before = copy(x.data);
    x.recheckHook = fixture => { mutate(fixture.currentBasis); sealRegenerationBasis(fixture.currentBasis); };
    await assert.rejects(() => x.publish(), httpError('SOURCE_STALE', 409));
    assert.equal(x.compileCount, 1); assert.equal(x.recheckCount, 1);
    assert.deepEqual(x.data, before); assert.equal(x.stored(), undefined);
    assert.equal(x.events.filter(e => e.method === 'syntheticBasisCapture').length, 2);
    assert.equal(x.events.some(e => ['updateJob','insertLedger'].includes(e.method)), false);
    assert.equal(x.events.at(-1).method, 'rollback');
  }
});

test('GET and POST replay retain the exact old regeneration basis after current head/source changes and original expiry', async () => {
  const x = new PublisherFixture({ regeneration: true }), original = await x.publish();
  const bytes = JSON.stringify(original), committed = copy(x.data);
  x.currentStrategyVersionId = id(99); x.canonical.bindingVersion++; x.canonical.requestedObjectiveVersion++;
  x.currentBasis = { schemaVersion: 99, note: 'Current basis must never be recaptured by retained read' };
  x.now = NOW + 3600000; x.cancelled = true;
  const captureCount = x.events.filter(e => e.method === 'syntheticBasisCapture').length;
  assert.equal(JSON.stringify(await x.lookup()), bytes); assert.equal(JSON.stringify(await x.publish()), bytes);
  assert.ok(x.now > original.request.originalExpiresAtMs);
  assert.equal(x.events.filter(e => e.method === 'syntheticBasisCapture').length, captureCount);
  assert.equal(x.compileCount, 1); assert.equal(x.recheckCount, 1); assert.deepEqual(x.data, committed);
  assert.equal(x.events.filter(e => e.method === 'insertLedger').length, 1);
});

test('concurrent regeneration compiles converge on one full-basis publication without substituting current observations', { timeout: 5000 }, async () => {
  const x = new PublisherFixture({ regeneration: true }); let entered = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  x.compileHook = async () => { if (++entered === 2) release(); await gate; };
  const [first, second] = await Promise.all([x.publish(), x.publish()]);
  assert.equal(entered, 2); assert.deepEqual(first, second);
  assert.equal(first.request.requestVersion, regenerationFactory.CORE_CANONICAL_REGENERATION_REQUEST_VERSION);
  assert.deepEqual(first.request.basis, x.currentBasis);
  assert.equal(x.events.filter(e => e.method === 'syntheticBasisCapture').length, 3);
  assert.equal(x.events.filter(e => e.method === 'updateJob').length, 1);
  assert.equal(x.events.filter(e => e.method === 'insertLedger').length, 1); assert.equal(x.data.rows.size, 2);
});
