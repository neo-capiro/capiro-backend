// Actual read/projection, receipt codec and Core authority bodies. Synthetic ORM,
// Nest exception transport and canonical-custody port; no native SQL/HTTP claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import {
  objectiveStrategyIntakeUrl,
  objectivePlannerOwnerCodecUrl,
} from './objective-strategy-request-loader.mjs';
const data = (s) => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
async function load(p, replacements = [], dto = false) {
  let s = await read(p);
  if (dto)
    s = s.replace(/export class (Objective\w+QueryDto)[^]*?\n}\r?\n/, 'export class $1 {}\n');
  s = s.replace(/^import .* from 'class-(?:validator|transformer)';\r?\n/gm, '');
  for (const [from, to] of replacements) {
    assert.ok(s.includes(from), from);
    s = s.replaceAll(from, JSON.stringify(to));
  }
  return data(stripTypeScriptTypes(s, { mode: 'transform' }));
}
const nest = data(`export class BadRequestException extends Error{};
export class ConflictException extends Error{}; export class NotFoundException extends Error{}; export class ServiceUnavailableException extends Error{};`);
const errors = await import(nest);
const shared = await load('../../../packages/shared/src/client-objective-destination.ts');
const destination = await load(
  '../src/strategy/objective-destination.ts',
  [
    ["'@nestjs/common'", nest],
    ["'@capiro/shared'", shared],
  ],
  true,
);
const types = await load('../src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", nest],
  ["'@capiro/shared/objective-strategy-intake'", objectiveStrategyIntakeUrl],
]);
const { digest, requestKey } = await import(types);
const sourceUrl = await load('../src/strategy/objective-saved-source.ts', [
  ["'@nestjs/common'", nest],
  ["'../meri/objective-generation.types.js'", types],
  ["'./objective-destination.js'", destination],
]);
const canonical =
  data(`import {CanonicalApplicationError} from ${JSON.stringify(objectivePlannerOwnerCodecUrl)};
export async function requireCanonicalGenerationReadWithinTx(tx, admission, clerk) {
  tx.calls.readFence++; if(tx.state.canonicalRevoked)throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  if(clerk!==tx.calls.canonicalScope.clerkUserId)throw Error('wrong clerk');
}
export async function readCanonicalSavedGeneration(tx, scope) {
  tx.calls.canonical++; tx.calls.canonicalScope=scope;
  if(tx.state.custodyError)throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  return {publication:{request:{context:{evidence:[]}}},receipt:{snapshotDigest:tx.state.custodyDigest??tx.digest(tx.snapshot),
    objectiveReceipt:tx.state.custodyReceipt??tx.receipt}};
}`);
const reviewUrl = await load(
  '../src/strategy/objective-saved-review.ts',
  [
    ["'@nestjs/common'", nest],
    ["'../meri/objective-generation.types.js'", types],
    ["'../meri/objective-canonical-saved-generation.js'", canonical],
    ["'../meri/objective-canonical-generation-fence.js'", canonical],
    ["'../planner/objective-canonical-application.js'", objectivePlannerOwnerCodecUrl],
    ["'./objective-destination.js'", destination],
    ["'./objective-saved-source.js'", sourceUrl],
  ],
  true,
);
const { readObjectiveSavedReview, projectSavedStrategy } = await import(reviewUrl);
const { readObjectiveSavedSource } = await import(sourceUrl);
const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ctx = { tenantId: id(1), clerkUserId: 'user_synthetic', role: 'standard_user' };
function fixture() {
  const input = {
    clientId: id(2),
    objectiveId: id(3),
    objectiveVersion: 2,
    generationJobId: id(4),
    strategyVersionId: id(6),
  };
  const state = {
    member: true,
    grant: true,
    objective: true,
    revision: true,
    strategy: true,
    version: true,
    job: true,
    objectiveVersion: 2,
  };
  const receipt = {
    schemaVersion: 1,
    requestId: id(7),
    source: {
      clientId: id(2),
      objectiveId: id(3),
      objectiveVersion: 2,
      objectiveRevisionId: id(8),
    },
    context: {
      state: 'complete',
      packetId: 'synthetic-packet',
      compiledAt: '2026-10-31T10:00:00.000Z',
      reobservedAt: '2026-10-31T10:01:00.000Z',
      sourceDigest: '1'.repeat(64),
      coverageDigest: '2'.repeat(64),
      inputDigest: '3'.repeat(64),
      issues: [],
    },
    result: {
      strategyId: id(5),
      strategyVersionId: id(6),
      savedAt: '2026-10-31T10:02:00.000Z',
      sourceDigest: '1'.repeat(64),
      coverageDigest: '2'.repeat(64),
      inputDigest: '3'.repeat(64),
      contextPacketId: 'synthetic-packet',
    },
    failure: null,
  };
  const job = {
    id: id(4),
    tenantId: ctx.tenantId,
    ownerUserId: ctx.clerkUserId,
    clientId: id(2),
    status: 'completed',
    strategyId: id(5),
    errorMessage: null,
    requestKey: requestKey(ctx.tenantId, ctx.clerkUserId, id(7)),
    input: {
      bearer: 'PRIVATE_SENTINEL',
      objectiveGeneration: {
        request: {
          requestId: id(7),
          clientId: id(2),
          objective: { objectiveId: id(3), objectiveVersion: 2 },
        },
        receipt,
      },
    },
  };
  const snapshot = {
    meta: {
      id: id(5),
      clientId: id(2),
      title: 'Saved before human edit',
      type: 'coalition',
      goal: 'Saved goal',
      targetDate: '2026-11-30',
      ownerUserId: ctx.clerkUserId,
      meriContext: 'PRIVATE_SENTINEL',
      meriSummary: 'PRIVATE_SENTINEL',
    },
    nodes: [
      {
        id: id(9),
        kind: 'action',
        subject: 'deliverable',
        title: 'Saved action',
        note: 'Saved note',
        ownerUserId: null,
        status: 'draft',
        startsOn: '2026-11-01',
        endsOn: null,
        openEnded: false,
        dependsOnIds: [id(10)],
        provenance: 'PRIVATE_SENTINEL',
        targetRef: 'PRIVATE_SENTINEL',
      },
      {
        id: id(10),
        kind: 'risk',
        subject: 'outcome',
        title: 'Saved context',
        note: null,
        ownerUserId: null,
        status: 'draft',
        startsOn: '2026-11-01',
        endsOn: null,
        openEnded: true,
        dependsOnIds: [],
      },
    ],
  };
  const version = {
    id: id(6),
    tenantId: ctx.tenantId,
    strategyId: id(5),
    coalescible: false,
    authorKind: 'meri',
    snapshot,
  };
  const current = [
    { id: id(9), archivedAt: null },
    { id: id(10), archivedAt: new Date() },
  ];
  const calls = { sql: [], canonical: 0, readFence: 0, versions: [], nodes: 0 };
  const match = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  const tx = {
    state,
    receipt,
    snapshot,
    digest,
    calls,
    $queryRaw: async (parts, ...values) => {
      const sql = parts.join('?');
      calls.sql.push({ sql, values });
      if (sql.includes('FROM sp_draft_job'))
        return state.job && values[1] === job.id && values[2] === job.ownerUserId
          ? [{ id: job.id }]
          : [];
      if (sql.includes('FROM sp_strategy')) return state.strategy ? [{ id: id(5) }] : [];
      if (sql.includes('FROM sp_version')) return state.version ? [{ id: id(6) }] : [];
      if (sql.includes('FROM tenants'))
        return state.member ? [{ userId: id(11), memoryWall: true }] : [];
      if (sql.includes('FROM client_memory_access')) return state.grant ? [{ id: id(12) }] : [];
      if (sql.includes('FROM client_objectives'))
        return state.objective ? [{ version: state.objectiveVersion }] : [];
      if (sql.includes('FROM client_objective_revisions'))
        return state.revision ? [{ id: state.revisionId ?? id(8) }] : [];
      throw Error('Unexpected read');
    },
    spDraftJob: { findFirst: async ({ where }) => (match(job, where) ? job : null) },
    spVersion: {
      findFirst: async ({ where }) => {
        calls.versions.push(where);
        return match(version, where) ? version : null;
      },
    },
    spNode: {
      findMany: async ({ where }) => {
        assert.deepEqual(where, { tenantId: ctx.tenantId, strategyId: id(5) });
        calls.nodes++;
        return current;
      },
    },
  };
  return {
    input,
    state,
    receipt,
    job,
    version,
    snapshot,
    current,
    tx,
    calls,
    run: () => readObjectiveSavedReview(tx, ctx, id(5), input),
  };
}
test('exact saved content, dates and graph survive later head edits; projection excludes private fields', async () => {
  const f = fixture();
  const out = await f.run();
  assert.equal(out.snapshot.meta.title, 'Saved before human edit');
  assert.equal(out.snapshot.nodes[0].startsOn, '2026-11-01');
  assert.deepEqual(out.snapshot.nodes[0].dependsOnIds, [id(10)]);
  assert.deepEqual(
    out.currentNodes.map((n) => n.availability),
    ['available', 'archived'],
  );
  assert.equal(out.source.snapshotDigest, digest(f.snapshot));
  assert.equal(JSON.stringify(out).includes('PRIVATE_SENTINEL'), false);
  assert.equal(f.calls.canonical, 0);
  assert.equal(f.calls.versions.length, 1);
  assert.equal(f.calls.versions[0].id, id(6));
  assert.ok(f.calls.sql.slice(0, 3).every((x) => x.sql.includes('FOR SHARE')));
});
for (const field of ['member', 'grant', 'objective', 'revision', 'strategy', 'version', 'job'])
  test(`refuses unavailable ${field} with no public content`, async () => {
    const f = fixture();
    f.state[field] = false;
    await assert.rejects(f.run(), errors.NotFoundException);
    assert.equal(f.calls.nodes, 0);
  });
for (const field of ['clientId', 'objectiveId', 'generationJobId', 'strategyVersionId'])
  test(`refuses substituted ${field}`, async () => {
    const f = fixture();
    f.input[field] = id(99);
    await assert.rejects(f.run(), errors.NotFoundException);
  });
test('refuses different Objective selection and stale current revision', async () => {
  const f = fixture();
  f.input.objectiveVersion = 3;
  await assert.rejects(f.run(), errors.NotFoundException);
  f.input.objectiveVersion = 2;
  f.state.objectiveVersion = 3;
  await assert.rejects(f.run(), errors.ConflictException);
  f.state.objectiveVersion = 2;
  f.state.revisionId = id(99);
  await assert.rejects(f.run(), errors.ConflictException);
});
for (const mutate of [
  (f) => (f.version.coalescible = true),
  (f) => (f.version.authorKind = 'person'),
  (f) => (f.job.ownerUserId = 'other'),
  (f) => (f.job.status = 'running'),
  (f) => (f.job.requestKey = 'unrelated'),
  (f) => (f.receipt.result.strategyId = id(99)),
  (f) => (f.receipt.result.strategyVersionId = id(99)),
  (f) => (f.snapshot.meta.clientId = id(99)),
  (f) => delete f.job.input.objectiveGeneration.request,
])
  test(`rejects corrupt saved identity ${mutate}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.run(), errors.NotFoundException);
  });
test('native marker requires canonical custody; mismatch or uncertainty never falls back to legacy', async () => {
  for (const marker of [
    'canonicalGeneration',
    'canonicalCompletion',
    'canonicalTerminal',
    'objectiveCanonicalReservation',
  ]) {
    const f = fixture();
    f.job.input[marker] = {};
    await f.run();
    assert.equal(f.calls.canonical, 1);
    assert.equal(f.calls.readFence, 1);
    f.state.custodyDigest = '9'.repeat(64);
    await assert.rejects(f.run(), errors.NotFoundException);
    f.state.custodyError = true;
    await assert.rejects(f.run(), errors.ServiceUnavailableException);
    f.state.custodyError = false;
    f.state.canonicalRevoked = true;
    await assert.rejects(f.run(), errors.NotFoundException);
  }
});
test('current node deletion stays explicit; empty saved output remains empty', async () => {
  const f = fixture();
  f.current.splice(0);
  assert.deepEqual(
    (await f.run()).currentNodes.map((n) => n.availability),
    ['unavailable', 'unavailable'],
  );
  f.snapshot.nodes = [];
  const empty = await f.run();
  assert.deepEqual(empty.snapshot.nodes, []);
  assert.deepEqual(empty.currentNodes, []);
});
test('projection rejects invalid dates and duplicate IDs, preserves context and full graph', () => {
  const f = fixture();
  f.snapshot.nodes[0].startsOn = '2026-02-30';
  assert.throws(() => projectSavedStrategy(f.snapshot), errors.NotFoundException);
  f.snapshot.nodes[0].startsOn = '2026-11-01';
  f.snapshot.nodes.push(f.snapshot.nodes[0]);
  assert.throws(() => projectSavedStrategy(f.snapshot), errors.NotFoundException);
});
test('Planner caller keeps its exact expected revision and original errors without allocating a new identity', async () => {
  const f = fixture();
  const selection = {
    generationJobId: id(4),
    expected: { strategyId: id(5), strategyVersionId: id(6), objectiveRevisionId: id(8) },
  };
  const unavailable = () => {
      throw Error('original-unavailable');
    },
    stale = () => {
      throw Error('original-stale');
    };
  const before = await readObjectiveSavedSource(f.tx, ctx, selection, { unavailable, stale });
  assert.equal(before.source.generationRequestId, id(7));
  selection.expected.objectiveRevisionId = id(99);
  await assert.rejects(
    readObjectiveSavedSource(f.tx, ctx, selection, { unavailable, stale }),
    /original-unavailable/,
  );
  selection.expected.objectiveRevisionId = id(8);
  f.state.objectiveVersion = 3;
  await assert.rejects(
    readObjectiveSavedSource(f.tx, ctx, selection, { unavailable, stale }),
    /original-stale/,
  );
});
