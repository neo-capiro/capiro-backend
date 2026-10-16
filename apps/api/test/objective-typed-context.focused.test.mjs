// Pure private projection cases. No Nest/Prisma graph, compiler, DB, network,
// provider, subprocess, write fixture or proof of owner/read authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ObjectiveTypedContextError, projectObjectiveTypedContext } from '../src/context/objective-generation-typed-context.ts';
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const stable = v => v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(stable)
  : Object.fromEntries(Object.keys(v).sort().map(key => [key, stable(v[key])]));
const digest = value => sha(JSON.stringify(stable(value)));
const clone = value => structuredClone(value);
const refused = run => assert.throws(run, e => e instanceof ObjectiveTypedContextError &&
  e.message === 'Objective typed context is unavailable');
const finding = (n, status = 'accepted', changes = {}) => ({ id: id(n), runId: id(90), status,
  factKind: 'fact', disposition: status === 'accepted' ? 'historical_reviewed_applied'
    : status === 'pending' ? 'candidate_unverified' : 'withheld_not_supporting',
  contentHash: sha(`actual-content-${n}`), createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-15T03:00:00.000Z', ...changes });
function fixture() {
  const source = { clientId: id(2), objectiveId: id(3), objectiveVersion: 4, objectiveRevisionId: id(4) };
  const intent = { outcome: ' Saved outcome ', governmentProblem: 'Government problem', askType: 'funding',
    minimumWin: 'Minimum win', limits: '' };
  const saved = { id: source.objectiveId, clientId: source.clientId, version: source.objectiveVersion,
    status: 'ready', deletedAt: null, ...intent, createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z', priority: 'high' };
  const input = { tenantId: id(1), clerkUserId: 'user_fixture', requestId: id(5), source, intent,
    snapshotSha256: digest(saved), sourceDigest: digest({ source, intent }), packetId: id(6),
    compiledAt: '2026-10-16T04:00:00.000Z', coverageDigest: sha('actual-private-coverage'),
    prompt: ' Full governed prompt\n😀\nSAVED OBJECTIVE INTENT (data): literal content ',
    findings: [finding(20), finding(21, 'pending'), finding(22, 'rejected'), finding(23, 'informational')],
    packetPersisted: true, packetDegraded: false, coverageComplete: true, paginationComplete: true, truncated: false };
  return { input, saved };
}
const project = value => projectObjectiveTypedContext(value);

test('trusted resolved actor stays opaque and bounded rather than implying identity from an identifier pattern', () => {
  const x = fixture(); x.input.clerkUserId = 'opaque:trusted/subject';
  assert.equal(project(x.input).clerkUserId, x.input.clerkUserId);
  x.input.clerkUserId = 'x'.repeat(129); refused(() => project(x.input));
});

test('source custody records the exact helper and both narrow owner integration files', async t => {
  const sourceCustody = await Promise.all(['objective-generation-typed-context.ts', 'objective-generation-context.service.ts',
    'strategy-context-plane.service.ts'].map(async file => ({ file,
    sha256: sha(await readFile(new URL(`../src/context/${file}`, import.meta.url), 'utf8')) })));
  assert.equal(sourceCustody.length, 3); t.diagnostic(JSON.stringify({ sourceCustody }));
});
test('private projection wiring is explicitly opt-in and the internal request flag remains typed', async () => {
  const [service, controller] = await Promise.all(['objective-generation-context.service.ts', 'internal-strategy-context.controller.ts']
    .map(file => readFile(new URL(`../src/context/${file}`, import.meta.url), 'utf8')));
  assert.match(service, /snapshotSha256: objectiveDigest\(saved\)/);
  assert.match(service, /if \(input\.objectiveTypedContext === true\) \{\s*try \{\s*bundle\.objectiveTypedContext = projectObjectiveTypedContext/);
  assert.match(service, /snapshotSha256\?: string/); // legacy bind fixtures remain valid; opted-in projection rejects missing SHA.
  assert.match(controller, /typeof body\.objectiveTypedContext !== 'boolean'/);
  assert.match(controller, /body\.objectiveTypedContext === true \? \{ objectiveTypedContext: true \} : \{\}/);
});
test('projection has exactly the private 13-field contract and only explicit accepted/pending finding refs', () => {
  const { input } = fixture(), before = clone(input), result = project(input);
  assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(result).sort(), ['schemaVersion', 'tenantId', 'clerkUserId', 'requestId', 'source', 'intent',
    'snapshotSha256', 'sourceDigest', 'packetId', 'compiledAt', 'coverageDigest', 'promptSha256', 'evidence'].sort());
  assert.deepEqual(result.evidence.map(e => e.reviewState), ['accepted', 'pending']);
  assert.deepEqual(result.evidence[0], { ref: `profile-fill:${id(20)}:${input.findings[0].contentHash}`,
    sourceId: id(20), asOfMs: Date.parse(input.findings[0].updatedAt), scope: 'client', clientId: input.source.clientId, reviewState: 'accepted' });
  assert.equal(result.schemaVersion, 1); assert.deepEqual(result.source, input.source); assert.deepEqual(result.intent, input.intent);
});
test('full saved-revision SHA is separate from source+intent digest and raw prompt UTF8 hash', () => {
  const { input, saved } = fixture(), result = project(input);
  assert.equal(result.snapshotSha256, digest(saved)); assert.equal(result.sourceDigest, digest({ source: input.source, intent: input.intent }));
  assert.notEqual(result.snapshotSha256, result.sourceDigest);
  assert.equal(result.promptSha256, sha(input.prompt)); assert.notEqual(result.promptSha256, digest(input.prompt));
  assert.equal(result.intent.outcome, ' Saved outcome ');
  // The pure helper validates provenance fields; only snapshot() can establish
  // that the supplied SHA was captured from its full actual saved revision.
});
test('rejected/informational artifact identities and all content/manifest/private prompt fields are absent', () => {
  const { input } = fixture();
  for (const row of input.findings) { row.proposedValue = 'PRIVATE_CONTENT_SENTINEL'; row.evidence = [{ body: 'PRIVATE_CONTENT_SENTINEL' }]; }
  const result = project(input), serialized = JSON.stringify(result);
  for (const sentinel of [id(22), id(23), 'PRIVATE_CONTENT_SENTINEL', input.prompt, 'manifest', 'fieldInventory', 'proposedValue'])
    assert.equal(serialized.includes(sentinel), false);
  assert.equal(Object.hasOwn(result, 'coverage'), false); assert.equal(Object.hasOwn(result, 'prompt'), false);
});
test('other retrieval/steering authority cannot be injected or used to promote pending evidence', () => {
  const { input } = fixture();
  input.findings[1].authority = 'firm_approved'; input.findings[1].complete = true;
  assert.equal(project(input).evidence.find(e => e.sourceId === id(21)).reviewState, 'pending');
  input.retrieval = [{ authority: 'firm_approved', reviewState: 'accepted' }]; refused(() => project(input));
});
test('fact/recommendation classification never changes the explicit historical review status', () => {
  const { input } = fixture(); input.findings[0].factKind = 'recommendation';
  assert.equal(project(input).evidence[0].reviewState, 'accepted');
  input.findings[0].status = 'active'; refused(() => project(input));
});
test('all five actual packet/coverage completion flags are exact fail-closed booleans', () => {
  for (const [key, wrong] of [['packetPersisted', false], ['packetDegraded', true], ['coverageComplete', false],
    ['paginationComplete', false], ['truncated', true], ['packetPersisted', 'true'], ['packetDegraded', 0]]) {
    const { input } = fixture(); input[key] = wrong; refused(() => project(input));
  }
});
test('exactly 256 evidence refs survive; the 257th refuses instead of slicing', () => {
  const { input } = fixture(); input.findings = Array.from({ length: 256 }, (_, i) => finding(1000 + i, i % 2 ? 'pending' : 'accepted'));
  assert.equal(project(input).evidence.length, 256);
  input.findings.push(finding(2000)); refused(() => project(input)); assert.equal(input.findings.length, 257);
});
test('large withheld corpus is not turned into a new global finding-count cap', () => {
  const { input } = fixture(); input.findings = Array.from({ length: 300 }, (_, i) => finding(1000 + i, 'rejected'));
  assert.deepEqual(project(input).evidence, []);
});
test('actual updatedAt becomes asOf; future/missing/impossible timestamps refuse', () => {
  for (const value of ['2026-10-16T04:00:00.001Z', '2026-02-30T00:00:00.000Z', '2026-10-15T25:00:00Z',
    '2026-10-15T00:00:00Z\n', null, 'invalid', '1969-12-31T23:59:59Z']) {
    const { input } = fixture(); input.findings[0].updatedAt = value; refused(() => project(input));
  }
  const { input } = fixture(); input.findings[0].updatedAt = input.compiledAt;
  assert.equal(project(input).evidence[0].asOfMs, Date.parse(input.compiledAt));
});
test('wrong status/disposition/fact-kind flags refuse rather than relabel', () => {
  for (const changes of [{ status: 'verified' }, { status: true }, { disposition: 'candidate_unverified' },
    { factKind: 'unknown' }, { factKind: null }]) {
    const { input } = fixture(); Object.assign(input.findings[0], changes); refused(() => project(input));
  }
  const { input } = fixture(); input.findings[2].disposition = 'historical_reviewed_applied'; refused(() => project(input));
});
test('duplicate source ID refuses even when content hash differs; enumeration order is deterministic', () => {
  const { input } = fixture(), baseline = project(input);
  input.findings.reverse(); assert.deepEqual(project(input), baseline);
  input.findings.push(finding(20, 'accepted', { contentHash: sha('different') })); refused(() => project(input));
});
test('changing finding content/version changes exact ref; no title/value matching or inferred refs', () => {
  const { input } = fixture(), before = project(input);
  input.findings[0].contentHash = sha('new-content'); input.findings[0].updatedAt = '2026-10-15T04:00:00.000Z';
  const after = project(input);
  assert.notEqual(after.evidence[0].ref, before.evidence[0].ref); assert.notEqual(after.evidence[0].asOfMs, before.evidence[0].asOfMs);
  assert.equal(after.evidence[0].sourceId, before.evidence[0].sourceId);
});
test('all UUID/digest fields require exact lowercase full matches including newline adversaries', () => {
  for (const key of ['tenantId', 'requestId', 'packetId', 'snapshotSha256', 'sourceDigest', 'coverageDigest']) {
    const { input } = fixture(); input[key] += '\n'; refused(() => project(input));
  }
  for (const key of ['clientId', 'objectiveId', 'objectiveRevisionId']) {
    const { input } = fixture(); input.source[key] += '\n'; refused(() => project(input));
  }
  for (const key of ['id', 'contentHash']) {
    const { input } = fixture(); input.findings[0][key] += '\n'; refused(() => project(input));
  }
});
test('source/intent scope and digest cannot silently disagree or gain unknown fields', () => {
  for (const mutate of [x => { x.source.objectiveVersion++; }, x => { x.intent.outcome = 'changed'; },
    x => { x.source.other = true; }, x => { x.intent.other = true; }, x => { x.intent.askType = 'unknown'; },
    x => { x.source.objectiveVersion = 2147483648; }, x => { x.clerkUserId = ''; },
    x => { x.compiledAt = 'not-a-date'; }, x => { x.prompt = '  '; }, x => { x.manifest = []; }]) {
    const { input } = fixture(); mutate(input); refused(() => project(input));
  }
});
test('safe reflection refuses proxy/accessor/sparse metadata without invoking it', () => {
  for (const mutate of [x => { Object.defineProperty(x.source, 'clientId', { enumerable: true, get() { throw Error('must not invoke'); } }); },
    x => { Object.defineProperty(x.findings[0], 'status', { enumerable: true, get() { throw Error('must not invoke'); } }); },
    x => { x.findings = new Array(1); }, x => { x.findings = new Proxy(x.findings, { ownKeys() { throw Error('must not invoke'); } }); },
    x => { x.findings[0].factKind = { toString() { throw Error('must not coerce'); } }; }]) {
    const { input } = fixture(); mutate(input); refused(() => project(input));
  }
  const { input } = fixture(); refused(() => project(new Proxy(input, { ownKeys() { throw Error('must not invoke'); } })));
});
test('extra finding content is never inspected and output metadata is detached/deep frozen', () => {
  const { input } = fixture(); Object.defineProperty(input.findings[0], 'proposedValue', { get() { throw Error('must not read corpus content'); } });
  const result = project(input); input.source.objectiveVersion++; input.intent.outcome = 'changed'; input.findings[0].status = 'pending';
  assert.equal(result.source.objectiveVersion, 4); assert.equal(result.intent.outcome, ' Saved outcome ');
  assert.equal(result.evidence[0].reviewState, 'accepted');
  for (const value of [result, result.source, result.intent, result.evidence, result.evidence[0]]) assert.ok(Object.isFrozen(value));
});
