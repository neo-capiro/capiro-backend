import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// Actual extracted writer and owner helpers with staged synthetic ORM/clock/
// versioning/objective hooks. No DB SQL, model, provider graph, authenticated
// workload or native locking/transaction qualification is claimed here.
const custody = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function source(path, imports = []) {
  const file = new URL(path, import.meta.url), raw = await readFile(file, 'utf8');
  let transformed = raw;
  for (const [specifier, replacement, occurrences = 1] of imports) {
    assert.equal(transformed.split(specifier).length, occurrences + 1, `exact declared dependency count: ${path}: ${specifier}`);
    transformed = occurrences === 1 ? transformed.replace(specifier, JSON.stringify(replacement))
      : transformed.replaceAll(specifier, JSON.stringify(replacement));
  }
  const stripped = stripTypeScriptTypes(transformed, { mode: 'strip', sourceUrl: file.href });
  custody.push({ path: file.pathname, rawSha256: sha(raw), importSpecifiers: imports.map(([specifier]) => specifier),
    importOccurrences: imports.map(([, , occurrences = 1]) => occurrences), strippedSha256: sha(stripped) });
  return asModule(stripped);
}
const appUrl = await source('../src/planner/objective-canonical-application.ts');
const generationUrl = await source('../src/meri/objective-canonical-generation.ts', [["'../planner/objective-canonical-application.js'", appUrl]]);
const nest = asModule('export class BadRequestException extends Error{};export class ConflictException extends Error{};');
const enums = asModule(`export const STRATEGY_TYPES=${JSON.stringify(['appropriations','authorization','regulatory','coalition','procurement','earmark','amendment'])};`);
const objectiveUrl = await source('../src/meri/objective-generation.types.ts', [["'@nestjs/common'", nest], ["'../strategy/dto/create-strategy.dto.js'", enums]]);
const jobTypesUrl = await source('../src/meri/draft-job.types.ts', [["'./objective-generation.types.js'", objectiveUrl, 2]]);
const producerUrl = await source('../src/meri/objective-canonical-producer.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-generation.types.js'", objectiveUrl],
]);
const snapshotUrl = await source('../src/strategy/versioning.ts');
const ledgerUrl = await source('../src/meri/objective-canonical-producer-ledger.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-canonical-producer.js'", producerUrl],
]);
const draftUrl = await source('../src/meri/objective-canonical-draft.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
const mergeUrl = await source('../src/meri/objective-canonical-regeneration.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'../strategy/versioning.js'", snapshotUrl],
]);
const jobInputUrl = await source('../src/meri/objective-canonical-job-input.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
const regenerationLedgerUrl = await source('../src/meri/objective-canonical-regeneration-ledger.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'../strategy/versioning.js'", snapshotUrl],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-canonical-producer-ledger.js'", ledgerUrl],
  ["'./objective-canonical-job-input.js'", jobInputUrl], ["'./objective-canonical-regeneration.js'", mergeUrl],
]);
const basisUrl = await source('../src/meri/objective-canonical-basis.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'../strategy/versioning.js'", snapshotUrl],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-canonical-producer-ledger.js'", ledgerUrl],
  ["'./objective-canonical-regeneration-ledger.js'", regenerationLedgerUrl],
]);
const requestUrl = await source('../src/meri/objective-canonical-request.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
const regenerationRequestUrl = await source('../src/meri/objective-canonical-regeneration-request.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-canonical-basis.js'", basisUrl], ["'./objective-canonical-request.js'", requestUrl],
]);
const requestLedgerUrl = await source('../src/meri/objective-canonical-request-ledger.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-canonical-producer-ledger.js'", ledgerUrl], ["'./objective-canonical-request.js'", requestUrl],
  ["'./objective-canonical-regeneration-request.js'", regenerationRequestUrl],
]);
const datesUrl = await source('../src/strategy/dates.ts', [["'@nestjs/common'", nest]]);
const liveUrl = await source('../src/strategy/live-node.ts');
const prismaLabel = asModule('export const Prisma={JsonNull:null};');
const detailUrl = await source('../src/strategy/detail.ts', [
  ["'../../generated/prisma-client/index.js'", prismaLabel], ["'./live-node.js'", liveUrl],
]);
const app = await import(appUrl), g = await import(generationUrl), ledger = await import(ledgerUrl);
const snapshots = await import(snapshotUrl), draft = await import(draftUrl), basis = await import(basisUrl), merge = await import(mergeUrl);
const request = await import(requestUrl), regenerationRequest = await import(regenerationRequestUrl), requestLedger = await import(requestLedgerUrl);

const meriFile = new URL('../src/meri/meri.service.ts', import.meta.url), meriRaw = await readFile(meriFile, 'utf8');
const meri = meriRaw.replace(/\r\n/g, '\n');
const methodStart = '  async applyCanonicalRegeneration(', methodEnd = '\n  private async persistDraftResponse(';
assert.equal(meri.split(methodStart).length, 2, 'one actual writer method');
assert.equal(meri.split(methodEnd).length, 2, 'one exact following method boundary');
const startIndex = meri.indexOf(methodStart), endIndex = meri.indexOf(methodEnd, startIndex);
assert.ok(endIndex > startIndex); const method = meri.slice(startIndex, endIndex);
const errorStart = 'function draftErrorBody(', errorEnd = '\n}\n\n/** Draft nodeData';
assert.equal(meri.split(errorStart).length, 2); assert.equal(meri.split(errorEnd).length, 2);
const errorHelper = meri.slice(meri.indexOf(errorStart), meri.indexOf(errorEnd, meri.indexOf(errorStart)) + 2);
const wrapper = `import {applicationHash,CanonicalApplicationError} from ${JSON.stringify(appUrl)};
import {parseCanonicalGenerationAdmission,canonicalGenerationAdmissionSha256,generationLedgerId,GENERATION_NORMALIZATION} from ${JSON.stringify(generationUrl)};
import {generationAssociation} from ${JSON.stringify(ledgerUrl)};
import {deriveCanonicalJobInput} from ${JSON.stringify(jobInputUrl)};
import {readCanonicalRequestPublication} from ${JSON.stringify(requestLedgerUrl)};
import {CORE_CANONICAL_REGENERATION_REQUEST_VERSION} from ${JSON.stringify(regenerationRequestUrl)};
import {captureCanonicalStrategyBasis} from ${JSON.stringify(basisUrl)};
import {planCanonicalStrategyRegeneration} from ${JSON.stringify(mergeUrl)};
import {recordCanonicalRegenerationNormalization} from ${JSON.stringify(regenerationLedgerUrl)};
import {parseDbDate} from ${JSON.stringify(datesUrl)};
import {loadStrategyDetail} from ${JSON.stringify(detailUrl)};
import {Prisma} from ${JSON.stringify(prismaLabel)};
import {DRAFT_JOB_STAGE_TEXT} from ${JSON.stringify(jobTypesUrl)};
export class UnprocessableEntityException extends Error {constructor(response){super(response.message);this.response=response;this.status=422;}}
${errorHelper}
export class ActualRegenerationWriter {
${method}
}`;
const writerStripped = stripTypeScriptTypes(wrapper, { mode: 'strip', sourceUrl: meriFile.href });
custody.push({ path: meriFile.pathname, rawSha256: sha(meriRaw), methodStart, methodEnd, methodSha256: sha(method),
  errorHelperStart: errorStart, errorHelperSha256: sha(errorHelper), strippedSha256: sha(writerStripped),
  extraction: 'unchanged method and error helper in class wrapper; no Nest/provider/application graph' });
const { ActualRegenerationWriter, UnprocessableEntityException } = await import(asModule(writerStripped));
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const copy = value => structuredClone(value);
const hex = char => char.repeat(64);
const NOW = Date.parse('2026-10-16T12:00:00.000Z');

const row = (kind, admission, data) => ({ id: g.generationLedgerId(kind, id(2), admission.clerkUserId, admission.generationJobId),
  tenantId: id(2), ownerId: admission.clerkUserId, kind, projectId: null, archived: false, version: 1, shareTokenHash: null, data: copy(data) });
function accepted(a, start) {
  const binding = { tenantId: id(2), actorId: a.clerkUserId, conversationId: id(a.expectedStrategyVersionId ? 80 : 13),
    runId: id(a.expectedStrategyVersionId ? 81 : 14), attemptId: id(a.expectedStrategyVersionId ? 82 : 15), workerId: id(16), writerFence: 7 };
  return { schemaVersion: 1, sourceAdmissionSha256: app.applicationHash(a), sourceBinding: binding, sourceRequestSha256: hex('b'), acceptedAtMs: start,
    issuance: { issuanceKey: g.generationBindingKey(binding), binding, requestSha256: hex('b'), expiresAtMs: start + 500000,
      grantId: id(17), capabilitySha256: hex('c'), factsSha256: hex('d') } };
}
function envelope(a, compiledAt, reobservedAt = null) {
  const request = { requestId: a.generationRequestId, clientId: id(3), objective: { objectiveId: id(4), objectiveVersion: a.canonical.requestedObjectiveVersion }, type: 'authorization' };
  return { request, fingerprint: app.applicationHash(request), receipt: { schemaVersion: 1, requestId: a.generationRequestId,
    source: { clientId: id(3), objectiveId: id(4), objectiveVersion: a.canonical.requestedObjectiveVersion, objectiveRevisionId: a.canonical.requestedObjectiveRevisionId },
    context: { state: 'complete', packetId: id(18), compiledAt: new Date(compiledAt).toISOString(), sourceDigest: hex('e'), coverageDigest: hex('f'), inputDigest: hex('1'), issues: [], reobservedAt },
    result: null, failure: null } };
}
const candidate = (keys, summary = 'Updated machine summary') => ({ type: 'authorization', rationale: 'Private synthetic producer result', summary,
  nodes: keys.map((sourceNodeKey, i) => ({ sourceNodeKey, kind: 'action', subject: 'deliverable', title: `Proposed ${sourceNodeKey}`,
    note: `Source note ${i}`, status: 'draft', ownerRef: null, startsOn: '2026-10-17', endsOn: null, openEnded: false,
    sources: [], dependsOn: i ? [keys[i - 1]] : [] })), coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } });

class Fixture {
  constructor() {
    this.data = { strategy: null, nodes: [], jobs: new Map(), versions: new Map(), rows: new Map(), headId: id(30), activities: [] };
    this.events = []; this.active = false; this.sequence = 0; this.now = NOW; this.denied = false; this.failure = null;
    this.beforeTransactionHook = null; this.groundingHook = null; this.afterCut = null; this.verifierErrors = []; this.afterWriteFailure = false;
    this.writer = new ActualRegenerationWriter();
    this.writer.prisma = { withTenantUser: async (tenant, clerk, run) => {
      assert.equal(tenant, id(2)); assert.equal(clerk, this.admission.clerkUserId); assert.equal(this.active, false);
      const staged = copy(this.data), tx = this.ports(staged), txId = ++this.sequence;
      this.active = true; this.events.push({ method: 'begin', txId });
      try { const result = await run(tx); this.data = staged; this.events.push({ method: 'commit', txId }); return result; }
      catch (error) { this.events.push({ method: 'rollback', txId }); throw error; }
      finally { this.active = false; }
    } };
    this.writer.grounding = async tenant => { assert.equal(this.active, false); assert.equal(tenant, id(2)); this.events.push({ method: 'grounding' });
      if (this.groundingHook) await this.groundingHook(this); return {}; };
    this.writer.verify = (type, nodes, ground, goal) => { this.events.push({ method: 'verify', type, nodeIds: nodes.map(n => n.id), goal }); return copy(this.verifierErrors); };
    this.writer.versioning = {
      cutVersion: async (tx, options) => {
        this.events.push({ method: 'cutVersion', options: copy(options) }); assert.equal(this.active, true);
        assert.deepEqual(options, { tenantId: id(2), strategyId: id(5), authorKind: 'meri', authorUserId: this.admission.clerkUserId,
          note: 'Regenerated from the current saved Objective; preserved existing work', coalesce: false });
        const data = tx._data, saved = { id: id(100), tenantId: id(2), strategyId: id(5), authorKind: 'meri', authorUserId: this.admission.clerkUserId,
          coalescible: false, createdAt: new Date(this.now), snapshot: snapshots.buildSnapshot(data.strategy, data.nodes.filter(n => n.archivedAt === null)) };
        data.versions.set(saved.id, saved); data.headId = saved.id; if (this.afterCut) await this.afterCut(this, data, saved); return saved.id;
      },
      logActivity: async (tx, activity) => { this.events.push({ method: 'activity' }); tx._data.activities.push(copy(activity)); },
    };
  }
  ports(data) {
    const matches = (r, where) => r && Object.entries(where).every(([key, value]) => r[key] === value);
    const log = (method, detail = {}) => this.events.push({ method, ...detail });
    return { _data: data,
      $queryRaw: async (strings, ...values) => {
        const sql = strings.join('?').replace(/\s+/g, ' ').trim(); log('sql', { sql, values });
        if (sql.startsWith('SELECT clock_timestamp() AS now')) return [{ now: new Date(this.now) }];
        if (sql.includes('FROM sp_strategy')) return data.strategy && data.strategy.archivedAt !== 'missing' ? [{ id: data.strategy.id }] : [];
        if (sql.includes('FROM sp_version')) return data.versions.has(data.headId) ? [copy(data.versions.get(data.headId))] : [];
        if (sql.includes('FROM sp_node')) return data.nodes.map(n => ({ id: n.id }));
        if (sql.includes('FROM client_objective_revisions')) return [{ snapshot: copy(this.objectiveSnapshot) }];
        throw Error(`Unexpected synthetic writer SQL: ${sql}`);
      },
      spStrategy: {
        findFirst: async ({ where }) => matches(data.strategy, where) ? copy(data.strategy) : null,
        findFirstOrThrow: async ({ where, include }) => {
          assert.equal(where.id, data.strategy.id); assert.deepEqual(include.nodes.where, { archivedAt: null });
          return { ...copy(data.strategy), nodes: copy(data.nodes.filter(n => n.archivedAt === null)), artifacts: [] };
        },
        updateMany: async ({ where, data: patch }) => {
          log('strategyUpdate', { patch: copy(patch) }); if (!matches(data.strategy, where) || this.failure === 'strategyCas') return { count: 0 };
          Object.assign(data.strategy, copy(patch)); return { count: 1 };
        },
      },
      spNode: {
        findMany: async ({ where }) => copy(data.nodes.filter(n => matches(n, where))),
        updateMany: async ({ where, data: patch }) => {
          log('nodeUpdate', { id: where.id, patch: copy(patch) }); const n = data.nodes.find(n => matches(n, where));
          if (!n || this.failure === 'nodeCas') return { count: 0 }; Object.assign(n, copy(patch)); return { count: 1 };
        },
        createMany: async ({ data: nodes }) => {
          log('nodeCreate', { ids: nodes.map(n => n.id) }); if (this.failure === 'newNode') throw Error('synthetic new-node failure');
          for (const n of nodes) { assert.equal(data.nodes.some(old => old.id === n.id), false);
            data.nodes.push({ ...copy(n), archivedAt: null, archivedByUserId: null, archivedReason: null, updatedAt: new Date(this.now) }); }
          return { count: nodes.length };
        },
      },
      spDraftJob: { findFirst: async ({ where }) => { const job = data.jobs.get(where.id); return matches(job, where) ? copy(job) : null; } },
      spVersion: { findFirst: async ({ where }) => { const v = data.versions.get(where.id); return matches(v, where) ? copy(v) : null; } },
      spPlannerResource: {
        findFirst: async ({ where }) => { const r = data.rows.get(where.id); return matches(r, where) ? copy(r) : null; },
        findMany: async ({ where }) => copy([...data.rows.values()].filter(r => r.tenantId === where.tenantId && r.kind === where.kind && r.data.strategyId === where.data.equals)),
        create: async ({ data: value }) => { log('ledgerInsert', { kind: value.kind, schemaVersion: value.data.schemaVersion });
          assert.equal(data.rows.has(value.id), false); data.rows.set(value.id, copy(value)); return copy(value); },
      },
    };
  }
  async initialize() {
    const start = NOW - 3600000;
    const old = { schemaVersion: 1, namespace: g.GENERATION_ADMISSION_NAMESPACE,
      canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4), canonicalStrategyId: id(5), canonicalProjectId: id(6),
        bindingVersion: 1, epoch: 1, requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 1, snapshotHash: hex('a') },
      actorUserId: id(9), clerkUserId: 'user_original_writer', consentId: id(10), controlVersion: 1,
      generationJobId: id(11), generationRequestId: id(12), admittedAtMs: start, effectExpiresAtMs: start + 600000, expectedStrategyVersionId: null };
    const oldAccepted = accepted(old, start + 100), oldEnvelope = envelope(old, start + 50, new Date(start + 150).toISOString());
    const initialNormalized = draft.normalizeCanonicalDraft(candidate(['first_step','second_step','archived_step'], 'Initial machine summary'), { admission: old, queuedType: 'authorization' });
    this.data.strategy = { id: id(5), tenantId: id(2), clientId: id(3), title: 'Initial Strategy', type: 'authorization', goal: 'Initial goal',
      meriContext: null, meriSummary: initialNormalized.response.summary, targetDate: null, ownerUserId: old.clerkUserId,
      createdByUserId: old.clerkUserId, createdAt: new Date(start + 200), archivedAt: null };
    this.data.nodes = initialNormalized.response.nodes.map((n, i) => ({ id: initialNormalized.nodeIds[i], tenantId: id(2), strategyId: id(5),
      kind: n.kind, subject: n.subject, title: n.title, note: n.note, status: n.status, ownerUserId: n.ownerUserId,
      startsOn: new Date(n.startsOn), endsOn: null, openEnded: n.openEnded, dependsOnIds: n.dependsOn.map(index => initialNormalized.nodeIds[index]),
      provenance: null, targetRef: null, meriAuthored: true, createdByUserId: old.clerkUserId, createdAt: new Date(start + 200),
      archivedAt: null, archivedByUserId: null, archivedReason: null, updatedAt: new Date(start + 200) }));
    const initialVersion = { id: id(19), tenantId: id(2), strategyId: id(5), authorKind: 'meri', authorUserId: old.clerkUserId,
      coalescible: false, snapshot: snapshots.buildSnapshot(this.data.strategy, this.data.nodes) };
    this.data.versions.set(initialVersion.id, initialVersion);
    const oldJob = { id: old.generationJobId, tenantId: id(2), clientId: id(3), ownerUserId: old.clerkUserId, status: 'running', attempt: 2,
      claimedBy: `canonical:${oldAccepted.issuance.issuanceKey}`, strategyId: null,
      input: { dto: { clientId: id(3), type: 'authorization' }, canonicalGeneration: ledger.generationMarker(old), objectiveGeneration: oldEnvelope } };
    this.data.jobs.set(oldJob.id, oldJob);
    for (const [kind, value] of [[g.GENERATION_ADMISSION, old], [g.GENERATION_ACCEPTANCE, oldAccepted]]) {
      const r = row(kind, old, value); this.data.rows.set(r.id, r);
    }
    await ledger.recordCanonicalNormalization(this.ports(this.data), id(2), old.clerkUserId, old.generationJobId,
      { strategyId: id(5), strategyVersionId: initialVersion.id }, initialNormalized);
    oldJob.status = 'completed'; oldJob.strategyId = id(5); oldEnvelope.receipt.result = { strategyId: id(5), strategyVersionId: initialVersion.id,
      savedAt: new Date(start + 200).toISOString(), sourceDigest: oldEnvelope.receipt.context.sourceDigest,
      contextPacketId: oldEnvelope.receipt.context.packetId, coverageDigest: oldEnvelope.receipt.context.coverageDigest, inputDigest: oldEnvelope.receipt.context.inputDigest };
    await ledger.recordCanonicalGenerationProducer(this.ports(this.data), id(2), old.clerkUserId, old.generationJobId);
    const intent = { outcome: 'Updated saved Objective', governmentProblem: 'Actual saved problem', askType: 'both', minimumWin: 'A reviewed revision', limits: '' };
    this.objectiveSnapshot = { id: id(4), clientId: id(3), version: 2, status: 'ready', deletedAt: null, ...intent };
    this.admission = { ...copy(old), canonical: { ...copy(old.canonical), bindingVersion: 2, requestedObjectiveVersion: 2,
      requestedIntentId: id(21), requestedObjectiveRevisionId: id(22), snapshotHash: app.applicationHash(this.objectiveSnapshot) },
      actorUserId: id(23), clerkUserId: 'user_current_writer', consentId: id(24), controlVersion: 2,
      generationJobId: id(25), generationRequestId: id(26), admittedAtMs: NOW - 1000, effectExpiresAtMs: NOW + 600000, expectedStrategyVersionId: id(30) };
    this.acceptance = accepted(this.admission, NOW - 500);
    Object.assign(this.data.strategy, { title: 'Human current Strategy', goal: 'Human retained goal', meriSummary: 'Human retained summary', ownerUserId: 'user_human_owner' });
    Object.assign(this.data.nodes[0], { title: 'Human retained step', note: 'Human retained note', startsOn: new Date('2026-10-18'), status: 'completed',
      ownerUserId: 'user_human_owner', provenance: { human: 'retained' }, targetRef: { human: 'target' } });
    this.data.nodes[1].status = 'active';
    this.data.nodes[2].archivedAt = new Date(NOW - 10000);
    const manual = { ...copy(this.data.nodes[1]), id: id(70), title: 'Manual unrelated step', note: 'Keep manual note',
      dependsOnIds: [], meriAuthored: false, createdByUserId: 'user_manual', createdAt: new Date(NOW - 20000), status: 'in_progress',
      provenance: { manual: true }, targetRef: { manual: 'target' } };
    this.data.nodes.push(manual);
    this.refreshHead();
    this.basis = await basis.captureCanonicalStrategyBasis(this.ports(this.data), this.admission);
    const proposed = candidate(['first_step','second_step','new_step']);
    proposed.nodes.forEach((node, i) => { node.startsOn = `2026-10-${18 + i}`; });
    proposed.nodes[1].title = 'New source second title'; proposed.nodes[1].note = 'Updated source note';
    this.normalized = draft.normalizeCanonicalRegenerationDraft(proposed,
      { admission: this.admission, queuedType: 'authorization', basis: this.basis });
    const a = this.admission, currentEnvelope = envelope(a, NOW - 1000);
    const source = currentEnvelope.receipt.source, prompt = 'Actual private regeneration context prompt';
    const sourceDigest = app.applicationHash({ source, intent });
    const compiled = { tenantId: id(2), clerkUserId: a.clerkUserId, requestId: a.generationRequestId, type: 'authorization', source, intent,
      localDigest: hex('c'), externalDigest: hex('d'), historyDigest: hex('e'), historyObservedAt: new Date(NOW - 1000).toISOString(), contactIds: [], coverage: [],
      context: { ...copy(currentEnvelope.receipt.context), sourceDigest } };
    compiled.context.inputDigest = app.applicationHash({ sourceDigest, coverageDigest: compiled.context.coverageDigest, packetId: compiled.context.packetId,
      requestId: a.generationRequestId, type: 'authorization', localDigest: compiled.localDigest, externalDigest: compiled.externalDigest,
      historyDigest: compiled.historyDigest, promptDigest: app.applicationHash(prompt) });
    currentEnvelope.receipt.context = copy(compiled.context);
    Object.assign(currentEnvelope, { localDigest: compiled.localDigest, externalDigest: compiled.externalDigest,
      historyDigest: compiled.historyDigest, historyObservedAt: compiled.historyObservedAt, coverage: [], contactIds: [] });
    const dto = { clientId: id(3), type: 'authorization', goal: 'Actual queued regeneration goal', attachmentIds: [] };
    const job = { id: a.generationJobId, tenantId: id(2), clientId: id(3), ownerUserId: a.clerkUserId, status: 'running', attempt: 2,
      claimedBy: `canonical:${this.acceptance.issuance.issuanceKey}`, claimedAt: new Date(NOW - 500), strategyId: null,
      requestKey: `objective-v1:${app.applicationHash([id(2), a.clerkUserId, a.generationRequestId])}`,
      input: { bearer: null, dto, canonicalGeneration: ledger.generationMarker(a), objectiveGeneration: currentEnvelope } };
    this.data.jobs.set(job.id, job);
    for (const [kind, value] of [[g.GENERATION_ADMISSION, a], [g.GENERATION_ACCEPTANCE, this.acceptance]]) {
      const r = row(kind, a, value); this.data.rows.set(r.id, r);
    }
    const publication = regenerationRequest.createCanonicalRegenerationRequestPublication({ admission: a, dto,
      context: { schemaVersion: 1, tenantId: id(2), clerkUserId: a.clerkUserId, requestId: a.generationRequestId, source, intent,
        snapshotSha256: a.canonical.snapshotHash, sourceDigest, packetId: compiled.context.packetId, compiledAt: compiled.context.compiledAt,
        coverageDigest: compiled.context.coverageDigest, promptSha256: sha(prompt), evidence: [] },
      prompt, owners: [{ ownerRef: a.clerkUserId, clerkUserId: a.clerkUserId }], delegation: { ref: id(90), revision: 'synthetic-original-delegation',
        issuedAtMs: NOW - 2000, absoluteExpiresAtMs: NOW + 600000 }, requestedAtMs: NOW - 500, effectExpiresAtMs: a.effectExpiresAtMs, basis: this.basis });
    const stored = { schemaVersion: 1, sourceAdmissionSha256: app.applicationHash(a), inputSha256: requestLedger.canonicalPublicationInputHash(job.input),
      publicationSha256: request.candidateJcsSha256(publication), compiled, publication };
    const publicationRow = row(g.GENERATION_REQUEST, a, stored); this.data.rows.set(publicationRow.id, publicationRow);
    this.publication = publication;
    this.runtime = { objective: { envelope: copy(currentEnvelope), onCompiled: async () => { throw Error('writer must not compile'); } },
      timeoutMs: 10000, onStage: (stage, text) => this.events.push({ method: 'stage', stage, text }),
      onStreamDelta: () => { throw Error('writer must not stream/model'); }, persistence: {
        beforeTransaction: async () => { assert.equal(this.active, false); this.events.push({ method: 'beforeTransaction' }); if (this.beforeTransactionHook) await this.beforeTransactionHook(this); },
        beforeWrite: async tx => { assert.equal(this.active, true); this.events.push({ method: 'beforeWrite' });
          if (this.denied) throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
          const actual = tx._data.jobs.get(a.generationJobId);
          assert.equal(actual.claimedBy, `canonical:${this.acceptance.issuance.issuanceKey}`);
          if (this.now >= Math.min(a.effectExpiresAtMs, this.acceptance.issuance.expiresAtMs)) throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
        },
        afterWrite: async (tx, saved) => {
          assert.equal(this.active, true); this.events.push({ method: 'afterWrite', saved: copy(saved) });
          if (this.now >= Math.min(a.effectExpiresAtMs, this.acceptance.issuance.expiresAtMs, this.publication.request.originalExpiresAtMs))
            throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
          const actual = tx._data.jobs.get(a.generationJobId), c = actual.input.objectiveGeneration.receipt.context;
          c.reobservedAt = new Date(this.now).toISOString(); actual.status = 'completed'; actual.strategyId = saved.strategyId;
          actual.input.objectiveGeneration.receipt.result = { ...saved, savedAt: new Date(this.now).toISOString(), sourceDigest: c.sourceDigest,
            contextPacketId: c.packetId, coverageDigest: c.coverageDigest, inputDigest: c.inputDigest };
          await ledger.recordCanonicalGenerationProducer(tx, id(2), a.clerkUserId, a.generationJobId);
          if (this.afterWriteFailure) throw Error('synthetic afterWrite failure');
        },
      } };
    this.events.length = 0; return this;
  }
  refreshHead() {
    this.data.versions.set(this.data.headId, { id: this.data.headId, tenantId: id(2), strategyId: id(5), authorKind: 'person',
      authorUserId: 'user_human', coalescible: false, snapshot: snapshots.buildSnapshot(this.data.strategy, this.data.nodes.filter(n => n.archivedAt === null)) });
  }
  run() { return this.writer.applyCanonicalRegeneration(id(2), this.admission.clerkUserId, this.admission, this.normalized, this.runtime); }
  writes() { return this.events.filter(e => ['strategyUpdate','nodeUpdate','nodeCreate','cutVersion','ledgerInsert','activity'].includes(e.method)); }
}

const fixture = async () => new Fixture().initialize();
const refuses = (run, code) => assert.rejects(run, error => code ? error.code === code : typeof error.code === 'string');
const normalizationId = x => g.generationLedgerId(g.GENERATION_NORMALIZATION, id(2), x.admission.clerkUserId, x.admission.generationJobId);

test('custody pins the exact actual writer method/error helper and real owner/merge dependencies', t => {
  const writer = custody.find(entry => entry.path.endsWith('/meri.service.ts'));
  assert.equal(writer.methodStart, methodStart); assert.equal(writer.methodEnd, methodEnd);
  assert.equal(writer.methodSha256, sha(method)); assert.match(writer.rawSha256, /^[a-f0-9]{64}$/);
  assert.ok(method.includes('await recordCanonicalRegenerationNormalization('));
  assert.ok(method.includes('await jobRuntime.persistence!.afterWrite('));
  for (const expected of ['objective-canonical-basis.ts','objective-canonical-regeneration.ts','objective-canonical-regeneration-ledger.ts',
    'objective-canonical-request-ledger.ts','objective-canonical-draft.ts','objective-canonical-job-input.ts'])
    assert.equal(custody.some(entry => entry.path.endsWith('/' + expected)), true);
  t.diagnostic(JSON.stringify({ sourceCustody: custody, qualification: 'extracted actual method + synthetic staged ORM/versioning/Objective hooks; no native DB or authentic authority' }));
});

test('actual preserving writer applies source patches/new IDs while retaining human fields, manual rows and archived identities', async () => {
  const x = await fixture(), before = copy(x.data), input = copy(x.normalized), result = await x.run();
  const firstId = x.normalized.nodeIds[0], secondId = x.normalized.nodeIds[1], newId = x.normalized.nodeIds[2];
  const find = (data, nodeId) => data.nodes.find(n => n.id === nodeId);
  assert.deepEqual(find(x.data, firstId), find(before, firstId));
  for (const name of ['title','goal','ownerUserId','meriSummary','createdByUserId','createdAt'])
    assert.deepEqual(x.data.strategy[name], before.strategy[name]);
  assert.equal(find(x.data, secondId).title, 'New source second title');
  assert.equal(find(x.data, secondId).note, 'Updated source note');
  assert.equal(find(x.data, secondId).startsOn.toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(find(x.data, secondId).status, 'active');
  for (const node of before.nodes.filter(n => !n.meriAuthored || n.archivedAt !== null)) assert.deepEqual(find(x.data, node.id), node);
  const added = find(x.data, newId);
  assert.equal(added.createdByUserId, x.admission.clerkUserId); assert.equal(added.createdAt.toISOString(), new Date(NOW).toISOString());
  assert.equal(added.meriAuthored, true); assert.deepEqual(added.dependsOnIds, [secondId]);
  assert.equal(added.archivedAt, null); assert.equal(x.data.nodes.length, before.nodes.length + 1);
  assert.deepEqual(result.nodes.map(n => n.id).sort(), x.data.nodes.filter(n => n.archivedAt === null).map(n => n.id).sort());
  assert.equal(result.regeneration.counts.createdNodes, 1);
  assert.ok(result.regeneration.preservedFields.some(f => f.field === 'title' && f.nodeId === firstId));
  assert.deepEqual(x.normalized, input);
});

test('one exact version, cumulative normalization, activity and Objective completion share the same staged write transaction', async () => {
  const x = await fixture(); await x.run();
  assert.equal(x.events.filter(e => e.method === 'cutVersion').length, 1);
  const saved = x.data.versions.get(id(100)), record = x.data.rows.get(normalizationId(x)).data;
  assert.equal(saved.authorKind, 'meri'); assert.equal(saved.authorUserId, x.admission.clerkUserId); assert.equal(saved.coalescible, false);
  assert.equal(record.schemaVersion, 2); assert.equal(record.strategyVersionId, saved.id);
  assert.equal(record.snapshotDigest, app.applicationHash(saved.snapshot));
  assert.equal(record.priorBasisSha256, app.applicationHash(x.basis));
  assert.deepEqual(record.normalizationWitness, x.normalized.normalizationWitness);
  assert.equal(record.mergePlan.counts.createdNodes, 1);
  const normalization = x.events.findIndex(e => e.method === 'ledgerInsert' && e.schemaVersion === 2);
  assert.ok(normalization > x.events.findIndex(e => e.method === 'cutVersion'));
  assert.ok(normalization < x.events.findIndex(e => e.method === 'afterWrite'));
  const job = x.data.jobs.get(x.admission.generationJobId);
  assert.equal(job.status, 'completed'); assert.equal(job.strategyId, id(5));
  assert.equal(job.input.objectiveGeneration.receipt.result.strategyVersionId, saved.id);
  assert.equal(x.data.activities.length, 1); assert.equal(x.data.activities[0].action, 'strategy.regenerated');
});

test('stale head/basis, changed original input, lost claim or denied current authority produce zero Strategy/evidence writes', async () => {
  const changes = [
    x => { const v = copy(x.data.versions.get(id(30))); v.id = id(31); x.data.versions.set(v.id, v); x.data.headId = v.id; },
    x => { x.data.strategy.title = 'Changed after publication'; x.refreshHead(); },
    x => { x.data.nodes[0].archivedAt = new Date(NOW - 1); x.data.nodes[1].dependsOnIds = []; x.refreshHead(); },
    x => { x.data.jobs.get(x.admission.generationJobId).claimedBy = 'canonical:' + hex('0'); },
    x => { x.denied = true; },
  ];
  for (const change of changes) {
    const x = await fixture(); change(x); const before = copy(x.data);
    await assert.rejects(() => x.run()); assert.deepEqual(x.data, before); assert.equal(x.writes().length, 0);
  }
  const x = await fixture(); let afterObservation;
  x.beforeTransactionHook = owner => { owner.data.jobs.get(owner.admission.generationJobId).input.dto.goal = 'Changed queued goal'; afterObservation = copy(owner.data); };
  await refuses(() => x.run(), 'OUTCOME_UNCONFIRMED'); assert.deepEqual(x.data, afterObservation); assert.equal(x.writes().length, 0);
});

test('normalization mutation during outside grounding cannot change the locked application result', async () => {
  const x = await fixture(); x.normalized = copy(x.normalized); const before = copy(x.data);
  x.groundingHook = owner => { owner.normalized.response.summary = 'Changed after first preflight';
    owner.normalized.normalizationWitness.normalizedResponseSha256 = app.applicationHash(owner.normalized.response); };
  await refuses(() => x.run(), 'REQUEST_CONFLICT'); assert.deepEqual(x.data, before); assert.equal(x.writes().length, 0);
});

test('proposing an archived canonical key refuses without resurrecting it or replacing its identity', async () => {
  const x = await fixture();
  x.normalized = draft.normalizeCanonicalRegenerationDraft(candidate(['archived_step']),
    { admission: x.admission, queuedType: 'authorization', basis: x.basis });
  const before = copy(x.data);
  await refuses(() => x.run(), 'ARCHIVED_NODE_PROPOSED'); assert.deepEqual(x.data, before); assert.equal(x.writes().length, 0);
});

test('whole-plan verifier refusal happens before any Strategy mutation', async () => {
  const x = await fixture(); x.verifierErrors = [{ code: 'dep-cycle', severity: 'error', message: 'Synthetic whole-graph refusal' }];
  const before = copy(x.data);
  await assert.rejects(() => x.run(), error => error instanceof UnprocessableEntityException && error.status === 422);
  assert.deepEqual(x.data, before); assert.equal(x.writes().length, 0);
});

test('Strategy/node CAS loss or new-row failure rolls back every earlier staged mutation', async () => {
  for (const failure of ['strategyCas','nodeCas','newNode']) {
    const x = await fixture(); x.failure = failure; const before = copy(x.data);
    if (failure === 'newNode') await assert.rejects(() => x.run(), /synthetic new-node failure/);
    else await refuses(() => x.run(), 'SOURCE_STALE');
    assert.deepEqual(x.data, before); assert.equal(x.data.rows.has(normalizationId(x)), false);
    assert.equal(x.data.versions.has(id(100)), false); assert.equal(x.events.at(-1).method, 'rollback');
  }
});

test('actual normalization recorder refuses a corrupt cut version and rolls back patch/new rows/version', async () => {
  const x = await fixture(), before = copy(x.data);
  x.afterCut = (_owner, _data, saved) => { saved.authorUserId = 'user_other'; };
  await refuses(() => x.run(), 'OUTCOME_UNCONFIRMED'); assert.deepEqual(x.data, before);
  assert.equal(x.events.some(e => e.method === 'cutVersion'), true);
  assert.equal(x.events.some(e => e.method === 'afterWrite'), false);
});

test('late Objective completion failure rolls back normalization, receipt, activity and exact version together', async () => {
  const x = await fixture(); x.afterWriteFailure = true; const before = copy(x.data);
  await assert.rejects(() => x.run(), /synthetic afterWrite failure/);
  assert.deepEqual(x.data, before); assert.equal(x.events.some(e => e.method === 'ledgerInsert' && e.schemaVersion === 2), true);
  assert.equal(x.events.some(e => e.method === 'afterWrite'), true); assert.equal(x.events.at(-1).method, 'rollback');
});

test('DB clock reaching the original accepted issuance deadline before afterWrite rolls back all prepared writes', async () => {
  const x = await fixture(), before = copy(x.data);
  x.afterCut = owner => { owner.now = owner.acceptance.issuance.expiresAtMs; };
  await refuses(() => x.run(), 'AUTHORITY_UNAVAILABLE');
  assert.deepEqual(x.data, before); assert.equal(x.events.some(e => e.method === 'ledgerInsert' && e.schemaVersion === 2), true);
  assert.equal(x.events.some(e => e.method === 'afterWrite'), true);
});

test('grounding and source observation occur outside transactions; Objective beforeWrite precedes all writes', async () => {
  const x = await fixture(); await x.run();
  assert.equal(x.sequence, 2);
  const ground = x.events.findIndex(e => e.method === 'grounding'), outside = x.events.findIndex(e => e.method === 'beforeTransaction');
  const beforeWrite = x.events.findIndex(e => e.method === 'beforeWrite'), firstWrite = x.events.findIndex(e => e.method === 'strategyUpdate');
  assert.ok(ground >= 0 && ground < outside && outside < beforeWrite && beforeWrite < firstWrite);
});
