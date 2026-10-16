// Backend adapter cases, not Meri contract validation or authority proof.
// One native Node process, source stripping, no hooks/children/DB/model/provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const custody = [];
const digest = value => createHash('sha256').update(value).digest('hex');
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function sourceModule(relative, replacements = []) {
  const url = new URL(relative, import.meta.url), original = await readFile(url, 'utf8');
  let source = original;
  for (const [from, to] of replacements) {
    const parts = source.split(from); assert.equal(parts.length, 2, `exact source dependency ${from}`); source = parts.join(to);
  }
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url.href });
  custody.push({ path: relative, sha256: digest(original), replacementSpecifiers: replacements.map(([from]) => from),
    transformedSha256: digest(stripped) });
  return dataModule(stripped);
}
const applicationUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const generationUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(applicationUrl)],
]);
const draftUrl = await sourceModule('../src/meri/objective-canonical-draft.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(applicationUrl)],
  ["'./objective-canonical-generation.js'", JSON.stringify(generationUrl)],
]);
const { applicationHash } = await import(applicationUrl);
const { GENERATION_ADMISSION_NAMESPACE, canonicalGenerationAdmissionSha256, generationUuid } = await import(generationUrl);
const { normalizeCanonicalDraft, CanonicalDraftNormalizationError } = await import(draftUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const clone = value => structuredClone(value);
const refuse = (run, code = 'DRAFT_INVALID') => assert.throws(run,
  e => e instanceof CanonicalDraftNormalizationError && e.code === code);
const node = (key, changes = {}) => ({ sourceNodeKey: key, kind: 'action', subject: 'deliverable',
  title: ` Exact title ${key} `, note: ' Literal note\n', status: 'suggested', ownerRef: null,
  startsOn: '2028-02-29', endsOn: '2028-03-01', openEnded: false,
  sources: [{ section: 'accepted', ref: 'evidence:approved' }], dependsOn: [], ...changes });
function fixture() {
  const canonical = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 4,
    snapshotHash: 'a'.repeat(64) };
  const admission = { schemaVersion: 1, namespace: GENERATION_ADMISSION_NAMESPACE, canonical,
    actorUserId: id(9), clerkUserId: 'user_fixture', consentId: id(12), controlVersion: 3,
    generationJobId: id(10), generationRequestId: id(11), admittedAtMs: 1_000_000,
    effectExpiresAtMs: 1_020_000, expectedStrategyVersionId: null };
  const payload = { type: 'appropriations', rationale: ' Literal rationale\n', summary: ' Exact summary\n',
    nodes: [node('prepare'), node('submit', { kind: 'milestone', subject: 'submission', dependsOn: ['prepare'] })],
    coverage: { complete: false, omitted: ['Missing research'], assumptions: ['Pending data remains uncertain'],
      sources: [{ section: 'accepted', ref: 'evidence:approved' }],
      pendingSources: [{ section: 'pending', ref: 'evidence:candidate' }] } };
  return { payload, options: { admission, queuedType: 'appropriations' } };
}
const normalize = x => normalizeCanonicalDraft(x.payload, x.options);
function regenerated() {
  const x = fixture(); x.options.admission.expectedStrategyVersionId = id(20);
  x.options.sourceNodeBasis = { expectedStrategyVersionId: id(20),
    nodeIdsBySourceKey: new Map([['prepare', id(21)], ['submit', id(22)], ['older_retained_key', id(23)]]) };
  return x;
}

test('source custody includes three actual TS inputs and only exact declared import rewrites', t => {
  assert.equal(custody.length, 3); assert.deepEqual(custody.map(x => x.replacementSpecifiers.length), [0, 1, 2]);
  t.diagnostic(JSON.stringify({ sourceCustody: custody }));
});

test('valid draft retains literal text and every exact edge without fabricating health/provenance', () => {
  const x = fixture(), before = clone(x.payload), result = normalize(x);
  assert.deepEqual(x.payload, before);
  assert.equal(result.response.summary, x.payload.summary);
  assert.deepEqual(Object.keys(result.response).sort(), ['nodes', 'summary']);
  assert.equal(result.response.nodes.length, 2);
  assert.deepEqual(result.sourceKeys, ['prepare', 'submit']);
  assert.deepEqual(result.response.nodes.map(n => n.dependsOn), [[], [0]]);
  assert.equal(result.response.nodes[0].title, x.payload.nodes[0].title);
  assert.equal(result.response.nodes[0].note, x.payload.nodes[0].note);
  assert.equal(result.response.nodes[0].ownerUserId, null);
  assert.deepEqual(result.response.nodes[0].sources, x.payload.nodes[0].sources);
  assert.equal(result.normalizationWitness.rationale, x.payload.rationale);
  assert.equal(result.normalizationWitness.strategyType, x.options.queuedType);
  assert.deepEqual(result.normalizationWitness.coverage, x.payload.coverage);
  assert.equal(result.normalizationWitness.proposedPayloadSha256, applicationHash(x.payload));
  assert.equal(result.normalizationWitness.normalizedResponseSha256, applicationHash(result.response));
  assert.equal(result.normalizationWitness.sourceAdmissionSha256, canonicalGenerationAdmissionSha256(x.options.admission));
  assert.equal(result.normalizationWitness.nodeIdsSha256, applicationHash(result.nodeIds));
  assert.equal(result.normalizationWitness.sourceKeysSha256, applicationHash(result.sourceKeys));
});

test('initial IDs depend only on protected canonical reservation/source key, never title/order/model IDs', () => {
  const x = fixture(), first = normalize(x);
  x.payload.nodes.reverse(); x.payload.nodes.forEach(n => { n.title = 'Different title'; n.dependsOn = []; });
  const reordered = normalize(x);
  assert.deepEqual(reordered.nodeIds, first.nodeIds.toReversed());
  for (const value of first.nodeIds) assert.equal(generationUuid(value), value);
  x.options.admission.canonical.canonicalPlanId = id(30);
  assert.notDeepEqual(normalize(x).nodeIds, reordered.nodeIds);
  x.payload.nodes[0].nodeId = id(99); refuse(() => normalize(x));
});

test('whole 60-node graph is retained, 61st node refuses instead of truncating', () => {
  const x = fixture(); x.payload.nodes = Array.from({ length: 60 }, (_, i) => node(`node_${i}`,
    { dependsOn: i ? [`node_${i - 1}`] : [] }));
  const result = normalize(x);
  assert.equal(result.response.nodes.length, 60); assert.equal(result.nodeIds.length, 60);
  assert.deepEqual(result.response.nodes[59].dependsOn, [58]);
  x.payload.nodes.push(node('node_60')); refuse(() => normalize(x));
});

test('type must equal actual queued DTO type; no inferred meri_propose/default policy', () => {
  const x = fixture(); x.payload.type = 'authorization'; refuse(() => normalize(x), 'DRAFT_TYPE_CONFLICT');
  x.payload.type = 'meri_propose'; refuse(() => normalize(x));
  x.payload.type = 'appropriations'; x.options.queuedType = 'unknown'; refuse(() => normalize(x));
});

test('all closed payload/node/source/coverage fields reject missing or unknown values', () => {
  const x = fixture();
  for (const key of Object.keys(x.payload)) { const f = fixture(); delete f.payload[key]; refuse(() => normalize(f)); }
  for (const key of Object.keys(x.payload.nodes[0])) { const f = fixture(); delete f.payload.nodes[0][key]; refuse(() => normalize(f)); }
  for (const mutate of [p => { p.extra = true; }, p => { p.nodes[0].ownerUserId = 'user_posted'; },
    p => { p.nodes[0].sources[0].extra = true; }, p => { delete p.nodes[0].sources[0].ref; },
    p => { p.coverage.groundingHealth = { status: 'ok' }; }, p => { delete p.coverage.pendingSources; }]) {
    const f = fixture(); mutate(f.payload); refuse(() => normalize(f));
  }
});

test('no proxy/accessor/symbol/sparse-array reflection can execute model code', () => {
  const x = fixture();
  x.payload = new Proxy(x.payload, { ownKeys() { throw Error('must not invoke'); } }); refuse(() => normalize(x));
  const revocable = Proxy.revocable({}, {}); revocable.revoke(); x.payload = revocable.proxy; refuse(() => normalize(x));
  for (const mutate of [p => { Object.defineProperty(p.nodes[0], 'title', { enumerable: true, get() { throw Error('must not invoke'); } }); },
    p => { p[Symbol('extra')] = true; }, p => { p.nodes[0].dependsOn = new Array(1); },
    p => { p.nodes.extra = true; }, p => { p.nodes = new Proxy(p.nodes, { ownKeys() { throw Error('must not invoke'); } }); },
    p => { Object.defineProperty(p.nodes, '0', { enumerable: true, get() { throw Error('must not invoke'); } }); }]) {
    const f = fixture(); mutate(f.payload); refuse(() => normalize(f));
  }
});

test('candidate enum and exact source-key syntax are defended independently', () => {
  for (const [key, value] of [['kind', 'task'], ['subject', 'unknown'], ['status', 'done'],
    ['sourceNodeKey', 'Upper'], ['sourceNodeKey', 'prepare\n'], ['sourceNodeKey', 'a'.repeat(65)],
    ['openEnded', 'false'], ['note', undefined]]) {
    const x = fixture(); x.payload.nodes[0][key] = value; refuse(() => normalize(x));
  }
});

test('text boundaries refuse oversize without trim/slice; Unicode lengths follow external schema', () => {
  const x = fixture(); x.payload.nodes[0].title = 'x'.repeat(300); assert.equal(normalize(x).response.nodes[0].title.length, 300);
  x.payload.nodes[0].title += 'x'; refuse(() => normalize(x));
  x.payload.nodes[0].title = '😀'.repeat(300); assert.equal(Array.from(normalize(x).response.nodes[0].title).length, 300);
  for (const mutate of [p => { p.summary = 'x'.repeat(16001); }, p => { p.rationale = 'x'.repeat(4001); },
    p => { p.nodes[0].note = 'x'.repeat(8001); }, p => { p.nodes[0].ownerRef = 'x'.repeat(129); },
    p => { p.nodes[0].sources[0].section = 'x'.repeat(129); }, p => { p.nodes[0].sources[0].ref = 'x'.repeat(257); },
    p => { p.coverage.assumptions = ['x'.repeat(1001)]; }, p => { p.coverage.omitted = ['x'.repeat(257)]; },
    p => { p.nodes[0].title = ' \t\n'; }]) {
    const f = fixture(); mutate(f.payload); refuse(() => normalize(f));
  }
});

test('strict calendar dates reject rollover/newline/backwards ranges and nonrisk ongoing flags', () => {
  for (const mutate of [p => { p.nodes[0].startsOn = '2027-02-29'; }, p => { p.nodes[0].startsOn = '2028-02-30'; },
    p => { p.nodes[0].startsOn += '\n'; }, p => { p.nodes[0].endsOn = '2028-02-28'; },
    p => { p.nodes[0].endsOn = '2028-04-31'; }, p => { p.nodes[0].openEnded = true; }]) {
    const x = fixture(); mutate(x.payload); refuse(() => normalize(x));
  }
  const x = fixture(); x.payload.nodes[0].kind = 'risk'; x.payload.nodes[0].openEnded = true; x.payload.nodes[0].endsOn = null;
  assert.equal(normalize(x).response.nodes[0].openEnded, true);
});

test('graph refuses duplicate keys/edges, self/dangling dependencies and full cycles', () => {
  for (const mutate of [p => { p.nodes[1].sourceNodeKey = p.nodes[0].sourceNodeKey; },
    p => { p.nodes[1].dependsOn = ['prepare', 'prepare']; }, p => { p.nodes[0].dependsOn = ['prepare']; },
    p => { p.nodes[0].dependsOn = ['missing']; }, p => { p.nodes[0].dependsOn = ['submit']; },
    p => { p.nodes[1].dependsOn = ['prepare\n']; }]) {
    const x = fixture(); mutate(x.payload); refuse(() => normalize(x));
  }
  const x = fixture(); x.payload.nodes = Array.from({ length: 60 }, (_, i) => node(`n_${i}`,
    { dependsOn: [`n_${(i + 1) % 60}`] })); refuse(() => normalize(x));
});

test('more than 20 valid dependency edges survive exact index mapping with candidate bounds', () => {
  const x = fixture(); x.payload.nodes = Array.from({ length: 25 }, (_, i) => node(`n_${i}`));
  x.payload.nodes[24].dependsOn = x.payload.nodes.slice(0, 24).map(n => n.sourceNodeKey).toReversed();
  assert.deepEqual(normalize(x).response.nodes[24].dependsOn, Array.from({ length: 24 }, (_, i) => 23 - i));
});

test('owner references resolve only from explicit backend map; UUID-like model subjects are never cast', () => {
  const x = fixture(); x.payload.nodes[0].ownerRef = 'owner_reference';
  refuse(() => normalize(x), 'OWNER_UNAVAILABLE');
  x.options.ownerMap = new Map([['different', 'user_other']]); refuse(() => normalize(x), 'OWNER_UNAVAILABLE');
  x.options.ownerMap = new Map([['owner_reference', 'user_current_owner']]);
  assert.equal(normalize(x).response.nodes[0].ownerUserId, 'user_current_owner');
  x.payload.nodes[0].ownerRef = id(99); refuse(() => normalize(x), 'OWNER_UNAVAILABLE');
  x.payload.nodes[0].ownerRef = null; assert.equal(normalize(x).response.nodes[0].ownerUserId, null);
});

test('owner map is backend Map data and current ID bound, never object/property lookup', () => {
  const x = fixture(); x.payload.nodes[0].ownerRef = 'owner_reference';
  x.options.ownerMap = { owner_reference: 'user_posted' }; refuse(() => normalize(x));
  x.options.ownerMap = new Proxy(new Map(), {}); refuse(() => normalize(x));
  x.options.ownerMap = new Map([['owner_reference', 'x'.repeat(121)]]); refuse(() => normalize(x));
});

test('regeneration never guesses from key/title when actual retained basis is absent', () => {
  const x = fixture(); x.options.admission.expectedStrategyVersionId = id(20);
  refuse(() => normalize(x), 'REGENERATION_BASIS_REQUIRED');
  x.payload.nodes.forEach(n => { n.title = 'Same unchanged title'; });
  refuse(() => normalize(x), 'REGENERATION_BASIS_REQUIRED');
});

test('explicit server basis preserves retained IDs and exact version identity, including cumulative extra keys', () => {
  const x = regenerated(), result = normalize(x);
  assert.deepEqual(result.nodeIds, [id(21), id(22)]);
  assert.equal(result.normalizationWitness.identityBasis, 'retained-server-basis');
  assert.equal(result.normalizationWitness.expectedStrategyVersionId, id(20));
  x.payload.nodes[0].title = 'Human-facing title change'; assert.deepEqual(normalize(x).nodeIds, result.nodeIds);
});

test('basis rejects wrong version/missing keys/duplicate IDs and cannot be supplied for initial creation', () => {
  for (const mutate of [x => { x.options.sourceNodeBasis.expectedStrategyVersionId = id(99); },
    x => { x.options.sourceNodeBasis.nodeIdsBySourceKey.delete('submit'); },
    x => { x.options.sourceNodeBasis.nodeIdsBySourceKey.set('submit', id(21)); }]) {
    const x = regenerated(); mutate(x); refuse(() => normalize(x), 'REGENERATION_BASIS_CONFLICT');
  }
  const x = regenerated(); x.options.sourceNodeBasis.nodeIdsBySourceKey.set('submit', id(22) + '\n');
  assert.throws(() => normalize(x), e => e.code === 'INPUT_INVALID');
  const initial = regenerated(); initial.options.admission.expectedStrategyVersionId = null;
  refuse(() => normalize(initial), 'REGENERATION_BASIS_CONFLICT');
});

test('coverage cannot declare complete with omissions or pending evidence without explicit assumptions', () => {
  const x = fixture(); x.payload.coverage.complete = true; refuse(() => normalize(x));
  x.payload.coverage.complete = false; x.payload.coverage.assumptions = []; refuse(() => normalize(x));
  x.payload.coverage.pendingSources = []; assert.ok(normalize(x));
});

test('all nested collection bounds refuse overflow without dropping source/coverage rows', () => {
  for (const mutate of [p => { p.nodes = []; }, p => { p.nodes[0].sources = Array.from({ length: 65 }, () => ({ section: 'a', ref: 'b' })); },
    p => { p.coverage.sources = Array.from({ length: 257 }, () => ({ section: 'a', ref: 'b' })); },
    p => { p.coverage.pendingSources = Array.from({ length: 257 }, () => ({ section: 'a', ref: 'b' })); },
    p => { p.coverage.omitted = Array(61).fill('gap'); }, p => { p.coverage.assumptions = Array(61).fill('unknown'); }]) {
    const x = fixture(); mutate(x.payload); refuse(() => normalize(x));
  }
});

test('aggregate result-byte bound refuses valid individual fields instead of truncating payload', () => {
  const x = fixture();
  x.payload.nodes = Array.from({ length: 60 }, (_, i) => node(`n_${i}`, { note: '😀'.repeat(8000),
    sources: Array.from({ length: 64 }, () => ({ section: 'a'.repeat(128), ref: 'b'.repeat(256) })) }));
  assert.ok(Buffer.byteLength(JSON.stringify(x.payload)) > 2097152); refuse(() => normalize(x));
  assert.equal(x.payload.nodes.length, 60); assert.equal(x.payload.nodes[59].sources.length, 64);
});

test('response, graph identity and protected witness are deeply detached and frozen', () => {
  const x = fixture(), result = normalize(x);
  x.payload.coverage.sources[0].ref = 'changed'; x.payload.nodes[0].sources[0].ref = 'changed';
  assert.equal(result.normalizationWitness.coverage.sources[0].ref, 'evidence:approved');
  assert.equal(result.response.nodes[0].sources[0].ref, 'evidence:approved');
  for (const value of [result, result.response, result.response.nodes, result.response.nodes[0],
    result.response.nodes[0].sources, result.response.nodes[0].sources[0], result.response.nodes[1].dependsOn,
    result.nodeIds, result.sourceKeys, result.normalizationWitness, result.normalizationWitness.coverage,
    result.normalizationWitness.coverage.sources, result.normalizationWitness.coverage.sources[0]]) assert.ok(Object.isFrozen(value));
});
