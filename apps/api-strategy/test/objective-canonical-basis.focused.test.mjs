import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// Actual source-stripped owner helpers with synthetic ORM/tagged-SQL ports.
// No compiler, real SQL, authentication, provider, server or native proof.
const custody = [];
const asModule = s => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
async function source(path, replacements = []) {
  const original = await readFile(new URL(path, import.meta.url), 'utf8');
  let transformed = original;
  for (const [from, to] of replacements) {
    assert.equal(transformed.split(from).length, 2, `one dependency ${from}`);
    transformed = transformed.replace(from, JSON.stringify(to));
  }
  custody.push({ path, sha256: createHash('sha256').update(original).digest('hex') });
  return asModule(stripTypeScriptTypes(transformed));
}
const appUrl = await source('../src/planner/objective-canonical-application.ts');
const generationUrl = await source('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
]);
const nest = asModule('export class BadRequestException extends Error{};export class ConflictException extends Error{};');
const enums = asModule(`export const STRATEGY_TYPES=${JSON.stringify(['appropriations','authorization','regulatory','coalition','procurement','earmark','amendment'])};`);
const outcomeUrl = await source('../src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", nest], ["'../strategy/dto/create-strategy.dto.js'", enums],
]);
const producerUrl = await source('../src/meri/objective-canonical-producer.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-generation.types.js'", outcomeUrl],
]);
const ledgerUrl = await source('../src/meri/objective-canonical-producer-ledger.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-canonical-producer.js'", producerUrl],
]);
const draftUrl = await source('../src/meri/objective-canonical-draft.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
const snapshotUrl = await source('../src/strategy/versioning.ts');
const jobInputUrl = await source('../src/meri/objective-canonical-job-input.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
const regenerationUrl = await source('../src/meri/objective-canonical-regeneration.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'../strategy/versioning.js'", snapshotUrl],
]);
const regenerationLedgerUrl = await source('../src/meri/objective-canonical-regeneration-ledger.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'../strategy/versioning.js'", snapshotUrl],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-canonical-producer-ledger.js'", ledgerUrl],
  ["'./objective-canonical-job-input.js'", jobInputUrl], ["'./objective-canonical-regeneration.js'", regenerationUrl],
]);
const basisUrl = await source('../src/meri/objective-canonical-basis.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'../strategy/versioning.js'", snapshotUrl],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-canonical-producer-ledger.js'", ledgerUrl],
  ["'./objective-canonical-regeneration-ledger.js'", regenerationLedgerUrl],
]);
const app = await import(appUrl), g = await import(generationUrl), ledger = await import(ledgerUrl);
const draft = await import(draftUrl), snapshots = await import(snapshotUrl), basis = await import(basisUrl);
const regeneration = await import(regenerationUrl), regenerationLedger = await import(regenerationLedgerUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const clone = structuredClone;
const refuses = async (run, code = 'OUTCOME_UNCONFIRMED') =>
  assert.rejects(run, e => e.code === code);

async function fixture(options = {}) {
  const old = { schemaVersion: 1, namespace: g.GENERATION_ADMISSION_NAMESPACE,
    canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
      canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 1, epoch: 1,
      requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 1, snapshotHash: 'a'.repeat(64) },
    actorUserId: id(9), clerkUserId: 'user_original_writer', consentId: id(10), controlVersion: 1,
    generationJobId: id(11), generationRequestId: id(12), admittedAtMs: 1000, effectExpiresAtMs: 20000,
    expectedStrategyVersionId: null };
  const binding = { tenantId: id(2), actorId: old.clerkUserId, conversationId: id(13), runId: id(14),
    attemptId: id(15), workerId: id(16), writerFence: 7 };
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: app.applicationHash(old), sourceBinding: binding,
    sourceRequestSha256: 'b'.repeat(64), acceptedAtMs: 1100, issuance: { issuanceKey: app.applicationHash(binding),
      binding, requestSha256: 'b'.repeat(64), expiresAtMs: 19000, grantId: id(17),
      capabilitySha256: 'c'.repeat(64), factsSha256: 'd'.repeat(64) } };
  const context = { state: 'complete', packetId: id(18), compiledAt: new Date(1050).toISOString(),
    sourceDigest: 'e'.repeat(64), coverageDigest: 'f'.repeat(64), inputDigest: '1'.repeat(64), issues: [],
    reobservedAt: new Date(1150).toISOString() };
  const receipt = { schemaVersion: 1, requestId: old.generationRequestId,
    source: { clientId: id(3), objectiveId: id(4), objectiveVersion: 1, objectiveRevisionId: id(8) },
    context, result: null, failure: null };
  const request = { requestId: old.generationRequestId, clientId: id(3),
    objective: { objectiveId: id(4), objectiveVersion: 1 }, type: 'authorization' };
  const normalized = draft.normalizeCanonicalDraft({ type: 'authorization', rationale: 'Synthetic normalization only',
    summary: 'Initial machine summary', nodes: ['first_step','second_step'].map((sourceNodeKey, i) => ({
      sourceNodeKey, kind: 'action', subject: 'deliverable', title: `Machine ${i}`, note: null, status: 'draft',
      ownerRef: null, startsOn: '2026-10-16', endsOn: null, openEnded: false, sources: [],
      dependsOn: i ? ['first_step'] : [] })), coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } },
  { admission: old, queuedType: 'authorization' });
  const strategy = { id: id(5), tenantId: id(2), clientId: id(3), title: 'Initial Strategy', type: 'authorization',
    goal: 'Saved goal', meriContext: null, meriSummary: normalized.response.summary, targetDate: null,
    ownerUserId: old.clerkUserId, createdByUserId: old.clerkUserId, createdAt: new Date(1200), archivedAt: null };
  const nodes = normalized.response.nodes.map((n, i) => ({ id: normalized.nodeIds[i], tenantId: id(2), strategyId: id(5),
    kind: n.kind, subject: n.subject, title: n.title, note: n.note, ownerUserId: n.ownerUserId, status: n.status,
    startsOn: new Date(n.startsOn), endsOn: null, openEnded: n.openEnded,
    dependsOnIds: n.dependsOn.map(index => normalized.nodeIds[index]), provenance: null, targetRef: null,
    meriAuthored: true, createdByUserId: old.clerkUserId, createdAt: new Date(1200), archivedAt: null,
    archivedByUserId: null, archivedReason: null, updatedAt: new Date(1200) }));
  const initial = { id: id(19), tenantId: id(2), strategyId: id(5), authorKind: 'meri', authorUserId: old.clerkUserId,
    coalescible: false, snapshot: snapshots.buildSnapshot(strategy, nodes) };
  const versions = new Map([[initial.id, initial]]), rows = new Map(), calls = [], writes = [];
  const resource = (kind, data) => ({ id: g.generationLedgerId(kind, id(2), old.clerkUserId, old.generationJobId),
    tenantId: id(2), ownerId: old.clerkUserId, kind, projectId: null, archived: false, version: 1, shareTokenHash: null, data: clone(data) });
  for (const [kind, data] of [[g.GENERATION_ADMISSION, old], [g.GENERATION_ACCEPTANCE, acceptance]]) {
    const r = resource(kind, data); rows.set(r.id, r);
  }
  const job = { id: old.generationJobId, tenantId: id(2), clientId: id(3), ownerUserId: old.clerkUserId,
    status: 'running', strategyId: null, attempt: 2, claimedBy: `canonical:${acceptance.issuance.issuanceKey}`,
    input: { dto: { clientId: id(3), type: 'authorization' }, canonicalGeneration: ledger.generationMarker(old),
      objectiveGeneration: { request, fingerprint: app.applicationHash(request), receipt } } };
  const jobs = new Map([[job.id, job]]);
  const admission = { ...clone(old), canonical: { ...clone(old.canonical), bindingVersion: 2,
    requestedObjectiveVersion: 2, requestedIntentId: id(21), requestedObjectiveRevisionId: id(22), snapshotHash: '2'.repeat(64) },
    actorUserId: id(23), clerkUserId: 'user_current_writer', consentId: id(24), controlVersion: 2,
    generationJobId: id(25), generationRequestId: id(26), admittedAtMs: 5000, expectedStrategyVersionId: id(30) };
  const head = { id: id(30), coalescible: false, snapshot: null };
  const tx = {
    $queryRaw: async (parts, ...values) => {
      const sql = parts.join('?'); calls.push({ sql, values: clone(values) });
      if (sql.includes('FROM sp_strategy')) return strategy.archivedAt === 'missing' ? [] : [{ id: strategy.id }];
      if (sql.includes('FROM sp_version')) return [clone(head)];
      if (sql.includes('FROM sp_node')) return nodes.map(n => ({ id: n.id }));
      throw Error('Unexpected SQL');
    },
    spStrategy: { findFirst: async () => clone(strategy) },
    spNode: { findMany: async args => { calls.push({ nodeRead: clone(args) }); return clone(nodes); } },
    spDraftJob: { findFirst: async ({where}) => {
      const found = jobs.get(where.id);
      return found && found.tenantId === where.tenantId && (!where.ownerUserId || found.ownerUserId === where.ownerUserId) ? clone(found) : null;
    } },
    spVersion: { findFirst: async ({where}) => clone(versions.get(where.id) ?? null) },
    spPlannerResource: {
      findFirst: async ({where}) => clone(rows.get(where.id) ?? null),
      findMany: async args => { calls.push({ normalizationRead: clone(args) });
        return clone([...rows.values()].filter(r => r.kind === g.GENERATION_NORMALIZATION &&
          r.tenantId === args.where.tenantId && r.data.strategyId === args.where.data.equals)); },
      create: async ({data}) => { writes.push(clone(data)); if (rows.has(data.id)) throw Error('duplicate');
        const r = {...clone(data)}; rows.set(r.id, r); return clone(r); },
    },
  };
  await ledger.recordCanonicalNormalization(tx, id(2), old.clerkUserId, job.id,
    {strategyId: strategy.id, strategyVersionId: initial.id}, normalized);
  job.status = 'completed'; job.strategyId = strategy.id;
  job.input.objectiveGeneration.receipt.result = { strategyId: strategy.id, strategyVersionId: initial.id,
    savedAt: new Date(1200).toISOString(), sourceDigest: context.sourceDigest, contextPacketId: context.packetId,
    coverageDigest: context.coverageDigest, inputDigest: context.inputDigest };
  await ledger.recordCanonicalGenerationProducer(tx, id(2), old.clerkUserId, job.id);
  strategy.title = 'Human current title'; nodes[0].title = 'Human current step';
  if (options.archiveFirst) { nodes[0].archivedAt = new Date(3000); nodes[1].dependsOnIds = []; }
  head.snapshot = snapshots.buildSnapshot(strategy, nodes.filter(n => n.archivedAt === null));
  calls.length = 0; writes.length = 0;
  return { tx, old, admission, normalized, strategy, nodes, head, initial, versions, rows, calls, writes, jobs,
    normalization: () => [...rows.values()].find(r => r.kind === g.GENERATION_NORMALIZATION),
    refresh: () => { head.snapshot = snapshots.buildSnapshot(strategy, nodes.filter(n => n.archivedAt === null)); } };
}

test('initial admission returns null without any owner read or mutation', async () => {
  const x = await fixture();
  assert.equal(await basis.captureCanonicalStrategyBasis({}, x.old), null);
  assert.equal(x.calls.length, 0); assert.equal(x.writes.length, 0);
});
test('captures exact current head and genuine old-owner machine baseline without current actor substitution', async () => {
  const x = await fixture(), result = await basis.captureCanonicalStrategyBasis(x.tx, x.admission);
  assert.equal(result.expectedStrategyVersionId, x.head.id);
  assert.equal(result.snapshot.meta.title, 'Human current title');
  assert.equal(result.sourceIndex.find(n => n.sourceNodeKey === 'first_step').lastMachine.node.title, 'Machine 0');
  assert.equal(result.provenance[0].ownerUserId, x.old.clerkUserId);
  assert.notEqual(result.provenance[0].ownerUserId, x.admission.clerkUserId);
  assert.equal(result.sourceIndex[0].nodeId, x.normalized.nodeIds[0]);
  assert.equal(result.snapshotSha256, app.applicationHash(x.head.snapshot));
  assert.equal(result.sourceIndexSha256, app.applicationHash(result.sourceIndex));
  assert.equal(basis.canonicalStrategyBasisSha256(result), app.applicationHash(result));
  assert.ok(Object.isFrozen(result.sourceIndex[0].lastMachine.node));
  assert.equal(x.writes.length, 0);
  assert.ok(x.calls[0].sql.includes('sp_strategy') && x.calls[0].sql.includes('FOR UPDATE'));
  assert.ok(x.calls[1].sql.includes('sp_version') && x.calls[1].sql.includes('FOR UPDATE'));
  const read = x.calls.find(c => c.nodeRead).nodeRead;
  assert.deepEqual(read, {where: {tenantId: id(2), strategyId: id(5)}});
});
test('archived mapped identity is retained without resurrection or replacement', async () => {
  const x = await fixture({archiveFirst: true}), result = await basis.captureCanonicalStrategyBasis(x.tx, x.admission);
  const first = result.sourceIndex.find(n => n.sourceNodeKey === 'first_step');
  assert.equal(first.archived, true); assert.equal(first.nodeId, x.nodes[0].id);
  assert.equal(first.lastMachine.node.title, 'Machine 0');
  assert.deepEqual(result.archiveIndex, [{nodeId: x.nodes[0].id, archivedAt: new Date(3000).toISOString()}]);
  assert.equal(result.snapshot.nodes.length, 1); assert.equal(x.writes.length, 0);
});
test('preserves unassociated human nodes in the complete current snapshot without inventing keys', async () => {
  const x = await fixture(), manual = {...clone(x.nodes[0]), id: id(100), title: 'Human addition', meriAuthored: false};
  x.nodes.push(manual); x.refresh();
  const result = await basis.captureCanonicalStrategyBasis(x.tx, x.admission);
  assert.equal(result.snapshot.nodes.length, 3); assert.equal(result.sourceIndex.length, 2);
  assert.ok(result.snapshot.nodes.some(n => n.id === manual.id));
  assert.ok(!result.sourceIndex.some(n => n.nodeId === manual.id));
});
for (const [name, mutate] of [
  ['changed exact head', x => {x.head.id = id(90);}],
  ['unsealed head', x => {x.head.coalescible = true;}],
  ['archived Strategy', x => {x.strategy.archivedAt = new Date(4000);} ],
  ['moved client', x => {x.strategy.clientId = id(90);} ],
  ['unversioned current row drift', x => {x.nodes[0].title = 'Changed after capture';}],
]) test(`refuses ${name}`, async () => {
  const x = await fixture(); mutate(x);
  await refuses(() => basis.captureCanonicalStrategyBasis(x.tx, x.admission), 'SOURCE_STALE');
  assert.equal(x.writes.length, 0);
});
for (const [name, mutate] of [
  ['missing normalization', x => x.rows.delete(x.normalization().id)],
  ['missing producer', x => {for (const [k,r] of x.rows) if(r.kind === g.GENERATION_PRODUCER)x.rows.delete(k);} ],
  ['missing mapped row', x => {x.nodes.shift(); x.nodes[0].dependsOnIds=[]; x.refresh();}],
  ['wrong historical owner namespace', x => {x.normalization().ownerId='user_other';}],
  ['tampered normalization content pin', x => {x.normalization().data.snapshotDigest='f'.repeat(64);}],
  ['duplicate mapping', x => {x.normalization().data.nodes[1]=clone(x.normalization().data.nodes[0]);}],
  ['forged source key despite recomputed key witness', x => {const r=x.normalization().data;r.nodes[0].sourceNodeKey='forged';
    r.normalizationWitness.sourceKeysSha256=app.applicationHash(r.nodes.map(n=>n.sourceNodeKey));}],
  ['unknown future schema', x => {x.normalization().data.schemaVersion=2;}],
  ['multiple initial records instead of a real cumulative schema', x => {const r=clone(x.normalization());r.id=id(500);x.rows.set(r.id,r);} ],
  ['wrong normalized response hash', x => {x.normalization().data.normalizationWitness.normalizedResponseSha256='f'.repeat(64);}],
  ['non-Meri original saved version', x => {x.initial.authorKind='person';}],
]) test(`refuses ${name} rather than guessing provenance`, async () => {
  const x = await fixture(); mutate(x);
  await refuses(() => basis.captureCanonicalStrategyBasis(x.tx, x.admission));
  assert.equal(x.writes.length, 0);
});
test('whole private packet overflow refuses without node truncation', async () => {
  const x = await fixture(); x.nodes[0].note = 'x'.repeat(basis.CANONICAL_STRATEGY_BASIS_MAX_BYTES + 1); x.refresh();
  await refuses(() => basis.captureCanonicalStrategyBasis(x.tx, x.admission));
  assert.equal(x.nodes.length, 2); assert.equal(x.writes.length, 0);
});
test('fixture loader records actual helper source custody', () => {
  assert.ok(custody.some(x => x.path.endsWith('objective-canonical-basis.ts')));
  assert.ok(custody.some(x => x.path.endsWith('objective-canonical-producer-ledger.ts')));
  assert.ok(custody.every(x => /^[a-f0-9]{64}$/.test(x.sha256)));
});

function addResource(x, kind, a, data) {
  const row = { id: g.generationLedgerId(kind, a.canonical.tenantId, a.clerkUserId, a.generationJobId),
    tenantId: a.canonical.tenantId, ownerId: a.clerkUserId, kind, projectId: null, archived: false,
    version: 1, shareTokenHash: null, data: clone(data) };
  x.rows.set(row.id, row); return row;
}
async function prepareRegeneration(x, a = x.admission, round = 1) {
  const captured = await basis.captureCanonicalStrategyBasis(x.tx, a);
  if (!x.versions.has(x.head.id)) x.versions.set(x.head.id, { ...clone(x.head), tenantId: id(2), strategyId: id(5),
    authorKind: 'person', authorUserId: 'user_human' });
  const run = { tenantId: id(2), actorId: a.clerkUserId, conversationId: id(100 + round), runId: id(110 + round),
    attemptId: id(120 + round), workerId: id(130 + round), writerFence: round + 1 };
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: app.applicationHash(a), sourceBinding: run,
    sourceRequestSha256: 'b'.repeat(64), acceptedAtMs: 5100 + round * 1000,
    issuance: { issuanceKey: app.applicationHash(run), binding: run, requestSha256: 'b'.repeat(64),
      expiresAtMs: 19000, grantId: id(140 + round), capabilitySha256: 'c'.repeat(64), factsSha256: 'd'.repeat(64) } };
  addResource(x, g.GENERATION_ADMISSION, a, a); addResource(x, g.GENERATION_ACCEPTANCE, a, acceptance);
  const request = { requestId: a.generationRequestId, clientId: id(3),
    objective: { objectiveId: id(4), objectiveVersion: a.canonical.requestedObjectiveVersion }, type: 'authorization' };
  const context = { state: 'complete', packetId: id(150 + round), compiledAt: new Date(5200 + round * 1000).toISOString(),
    sourceDigest: 'e'.repeat(64), coverageDigest: 'f'.repeat(64), inputDigest: '1'.repeat(64), issues: [], reobservedAt: null };
  const receipt = { schemaVersion: 1, requestId: a.generationRequestId,
    source: { clientId: id(3), objectiveId: id(4), objectiveVersion: a.canonical.requestedObjectiveVersion,
      objectiveRevisionId: a.canonical.requestedObjectiveRevisionId }, context, result: null, failure: null };
  const job = { id: a.generationJobId, tenantId: id(2), clientId: id(3), ownerUserId: a.clerkUserId, status: 'running',
    attempt: 2, claimedBy: `canonical:${acceptance.issuance.issuanceKey}`, claimedAt: new Date(acceptance.acceptedAtMs), strategyId: null,
    requestKey: `objective-v1:${app.applicationHash([id(2), a.clerkUserId, a.generationRequestId])}`,
    input: { bearer: null, dto: { clientId: id(3), type: 'authorization', goal: 'Actual stored goal' },
      canonicalGeneration: ledger.generationMarker(a), objectiveGeneration: { request, fingerprint: app.applicationHash(request), receipt } } };
  x.jobs.set(job.id, job);
  const payload = { type: 'authorization', rationale: 'Actual synthetic retained basis', summary: `Machine summary ${round}`,
    nodes: ['first_step', 'second_step', 'new_step'].filter(key => !captured.sourceIndex.find(e => e.sourceNodeKey === key)?.archived)
      .map((sourceNodeKey, i) => ({ sourceNodeKey, kind: 'action', subject: 'deliverable', title: `Proposal ${round} ${sourceNodeKey}`,
        note: null, status: 'active', ownerRef: null, startsOn: '2026-10-16', endsOn: null, openEnded: false,
        sources: [], dependsOn: i && !captured.sourceIndex.find(e => e.sourceNodeKey === 'first_step')?.archived ? ['first_step'] : [] })),
    coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } };
  const normalized = draft.normalizeCanonicalRegenerationDraft(payload, { admission: a, queuedType: 'authorization', basis: captured });
  const normalizationId = g.generationLedgerId(g.GENERATION_NORMALIZATION, id(2), a.clerkUserId, a.generationJobId);
  const plan = regeneration.planCanonicalStrategyRegeneration({ basis: captured, normalized, current: captured.snapshot,
    archivedNodeIds: captured.archiveIndex.map(e => e.nodeId), createdByUserId: a.clerkUserId,
    createdAt: new Date(6000 + round * 1000).toISOString(), normalizationId });
  const saved = { strategyId: id(5), strategyVersionId: id(300 + round) };
  return { a, acceptance, captured, job, normalized, plan, saved, round };
}
function applyActualRows(x, p) {
  const archiveRows = x.nodes.filter(n => n.archivedAt !== null);
  const live = p.plan.snapshot.nodes.map(n => ({ ...clone(n), tenantId: id(2), strategyId: id(5),
    startsOn: new Date(n.startsOn), endsOn: n.endsOn === null ? null : new Date(n.endsOn), createdAt: new Date(n.createdAt),
    updatedAt: new Date(p.plan.planning.createdAt), archivedAt: null, archivedByUserId: null, archivedReason: null }));
  x.nodes.splice(0, x.nodes.length, ...live, ...archiveRows);
  Object.assign(x.strategy, clone(p.plan.snapshot.meta), { createdAt: new Date(p.plan.snapshot.meta.createdAt),
    targetDate: p.plan.snapshot.meta.targetDate === null ? null : new Date(p.plan.snapshot.meta.targetDate) });
  const actualSnapshot = clone(p.plan.snapshot);
  actualSnapshot.nodes.reverse(); // real version order need not equal proposal/source-key order.
  const version = { id: p.saved.strategyVersionId, tenantId: id(2), strategyId: id(5), authorKind: 'meri',
    authorUserId: p.a.clerkUserId, coalescible: false, snapshot: actualSnapshot };
  x.versions.set(version.id, version); return version;
}
async function commitSyntheticRegeneration(x, p) {
  const version = applyActualRows(x, p);
  const record = await regenerationLedger.recordCanonicalRegenerationNormalization(x.tx, id(2), p.a.clerkUserId,
    p.a.generationJobId, p.saved, { basis: p.captured, normalized: p.normalized, plan: p.plan });
  p.job.status = 'completed'; p.job.strategyId = id(5);
  const e = p.job.input.objectiveGeneration;
  e.receipt.context.reobservedAt = new Date(6200 + p.round * 1000).toISOString();
  e.receipt.result = { ...p.saved, savedAt: new Date(6300 + p.round * 1000).toISOString(), sourceDigest: e.receipt.context.sourceDigest,
    contextPacketId: e.receipt.context.packetId, coverageDigest: e.receipt.context.coverageDigest, inputDigest: e.receipt.context.inputDigest };
  await ledger.recordCanonicalGenerationProducer(x.tx, id(2), p.a.clerkUserId, p.a.generationJobId);
  Object.assign(x.head, clone(version)); return record;
}
function nextAdmission(x, previous, round) {
  return { ...clone(previous), canonical: { ...clone(previous.canonical), bindingVersion: previous.canonical.bindingVersion + 1,
    requestedObjectiveVersion: previous.canonical.requestedObjectiveVersion + 1, requestedIntentId: id(400 + round),
    requestedObjectiveRevisionId: id(410 + round), snapshotHash: String(round + 3).repeat(64) },
    generationJobId: id(420 + round), generationRequestId: id(430 + round), expectedStrategyVersionId: x.head.id,
    consentId: id(440 + round), controlVersion: previous.controlVersion + 1, admittedAtMs: 5000 + round * 1000 };
}
test('pure basis checker verifies hashes/scope/index coherence without owner reads or history claims', async () => {
  const x = await fixture(), captured = await basis.captureCanonicalStrategyBasis(x.tx, x.admission);
  const count = x.calls.length; assert.deepEqual(basis.checkCanonicalStrategyBasis(captured, x.admission), captured);
  assert.equal(x.calls.length, count);
  for (const change of [b => { b.sourceIndexSha256 = 'f'.repeat(64); }, b => { b.provenance[0].normalizationId = id(990); },
    b => { b.sourceIndex[0].lastMachine.normalizationId = id(990); }, b => { b.sourceIndex[0].archived = true; }]) {
    const b = clone(captured); change(b); assert.throws(() => basis.checkCanonicalStrategyBasis(b, x.admission));
  }
});
test('schema2 shares the existing kind and replays actual saved rows with ID-normalized version order', async () => {
  const x = await fixture(), p = await prepareRegeneration(x), record = await commitSyntheticRegeneration(x, p);
  assert.equal(record.schemaVersion, 2); assert.equal(record.priorBasisSha256, app.applicationHash(p.captured));
  assert.deepEqual(record.predecessorNormalizationIds, p.captured.provenance.map(r => r.normalizationId));
  assert.equal(record.mergePlanSha256, app.applicationHash(p.plan)); assert.deepEqual(record.planning, p.plan.planning);
  const raw = x.rows.get(p.plan.normalizationId); assert.equal(raw.kind, g.GENERATION_NORMALIZATION); assert.equal(raw.version, 1);
  assert.equal(record.snapshotDigest, app.applicationHash(x.versions.get(p.saved.strategyVersionId).snapshot));
  const a3 = nextAdmission(x, p.a, 2), after = await basis.captureCanonicalStrategyBasis(x.tx, a3);
  assert.equal(after.provenance.length, 2); assert.equal(after.sourceIndex.length, 3);
  assert.equal(after.snapshot.nodes.find(n => n.id === p.normalized.nodeIds[0]).title, 'Human current step');
  assert.equal(after.sourceIndex.find(n => n.sourceNodeKey === 'first_step').lastMachine.node.title, 'Machine 0');
  assert.equal(after.sourceIndex.find(n => n.sourceNodeKey === 'first_step').lastMachine.normalizationId, p.plan.normalizationId);
});
test('two sequential schema2 records preserve original human-field baselines rather than laundering merged values', async () => {
  const x = await fixture(), second = await prepareRegeneration(x); await commitSyntheticRegeneration(x, second);
  const a3 = nextAdmission(x, second.a, 2), third = await prepareRegeneration(x, a3, 2); await commitSyntheticRegeneration(x, third);
  const after = await basis.captureCanonicalStrategyBasis(x.tx, nextAdmission(x, a3, 3));
  assert.equal(after.provenance.length, 3); assert.equal(after.sourceIndex.length, 3);
  const retained = after.sourceIndex.find(n => n.sourceNodeKey === 'first_step');
  assert.equal(retained.lastMachine.node.title, 'Machine 0');
  assert.equal(after.snapshot.nodes.find(n => n.id === retained.nodeId).title, 'Human current step');
  assert.equal(retained.nodeId, x.normalized.nodeIds[0]);
  assert.ok(third.plan.fields.some(f => f.sourceNodeKey === 'first_step' && f.field === 'title' && f.resolution === 'human_preserved'));
});
test('schema2 retains archived mapped identities and human-only nodes without key adoption or resurrection', async () => {
  const x = await fixture({ archiveFirst: true });
  const human = { ...clone(x.nodes.find(n => n.archivedAt === null)), id: id(980), title: 'Human-only addition', meriAuthored: false, dependsOnIds: [] };
  x.nodes.push(human); x.refresh(); const p = await prepareRegeneration(x); await commitSyntheticRegeneration(x, p);
  const after = await basis.captureCanonicalStrategyBasis(x.tx, nextAdmission(x, p.a, 2));
  assert.ok(after.snapshot.nodes.some(n => n.id === human.id)); assert.ok(!after.sourceIndex.some(n => n.nodeId === human.id));
  assert.equal(after.sourceIndex.find(n => n.sourceNodeKey === 'first_step').archived, true);
  assert.deepEqual(after.archiveIndex, p.captured.archiveIndex);
});
for (const [name, change] of [
  ['branch', (x, row) => { const other = clone(row); other.id = id(991); x.rows.set(other.id, other); }],
  ['cycle', (_x, row) => { row.data.predecessorNormalizationIds = [row.id]; }],
  ['missing predecessor', (x, row) => { x.rows.delete(row.data.predecessorNormalizationIds[0]); }],
  ['tampered baseline with recomputed local hash', (_x, row) => { row.data.priorBasis.sourceIndex[0].lastMachine.node.title = 'Human current step';
    row.data.priorBasis.sourceIndexSha256 = app.applicationHash(row.data.priorBasis.sourceIndex); row.data.priorBasisSha256 = app.applicationHash(row.data.priorBasis); }],
  ['changed original field decision', (_x, row) => { row.data.mergePlan.fields[0].resolution = 'source_applied'; row.data.mergePlan.fields[0].appliedSha256 = 'f'.repeat(64);
    row.data.mergePlanSha256 = app.applicationHash(row.data.mergePlan); }],
]) test(`schema2 refuses ${name} instead of selecting or resetting history`, async () => {
  const x = await fixture(), p = await prepareRegeneration(x); await commitSyntheticRegeneration(x, p);
  change(x, x.rows.get(p.plan.normalizationId));
  await refuses(() => basis.captureCanonicalStrategyBasis(x.tx, nextAdmission(x, p.a, 2)));
});
test('actual regeneration ledger refuses changed running claim and mismatched saved snapshot before insert', async () => {
  const x = await fixture(), p = await prepareRegeneration(x); applyActualRows(x, p);
  const count = x.rows.size; p.job.claimedBy = 'other-claim';
  await refuses(() => regenerationLedger.recordCanonicalRegenerationNormalization(x.tx, id(2), p.a.clerkUserId, p.a.generationJobId,
    p.saved, { basis: p.captured, normalized: p.normalized, plan: p.plan }));
  p.job.claimedBy = `canonical:${p.acceptance.issuance.issuanceKey}`;
  x.versions.get(p.saved.strategyVersionId).snapshot.nodes[0].title = 'Unplanned saved mutation';
  await refuses(() => regenerationLedger.recordCanonicalRegenerationNormalization(x.tx, id(2), p.a.clerkUserId, p.a.generationJobId,
    p.saved, { basis: p.captured, normalized: p.normalized, plan: p.plan }));
  assert.equal(x.rows.size, count);
});
