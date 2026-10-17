import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { app, m, applied, shared, sourceModule, sharedUrl, calendarUrl, regenerationUrl,
  regeneration, objectiveDigest, fullV2, fullV3, id, at, NOW } from './objective-planner-codec.fixtures.mjs';
const require = createRequire(import.meta.url), ts = require('typescript');
const hash = text => createHash('sha256').update(text).digest('hex');
const baseline = JSON.parse(await readFile(new URL('./objective-planner-codec-baseline.json', import.meta.url), 'utf8'));
const root = new URL('../../../', import.meta.url);
const materialRaw = await readFile(new URL('packages/shared/src/objective-planner-materialization.ts', root), 'utf8');
const applicationRaw = await readFile(new URL('packages/shared/src/objective-planner-application.ts', root), 'utf8');
const parse = (name, raw) => ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const materialSource = parse('material.ts', materialRaw), applicationSource = parse('application.ts', applicationRaw);
const name = node => node.name?.text;
const functionMap = (source, factory) => new Map(source.statements.find(n => name(n) === factory).body.statements
  .filter(ts.isFunctionDeclaration).map(node => [name(node), node]));
const materialFunctions = functionMap(materialSource, 'createPlannerMaterializationCodec');
const applicationFunctions = functionMap(applicationSource, 'createPlannerApplicationCodec');
const wrapperRaw = await readFile(new URL('apps/api-strategy/src/planner/strategy-materialization.ts', root), 'utf8');
const wrapperSource = parse('wrapper.ts', wrapperRaw);
const objectiveRaw = await readFile(new URL('apps/api-strategy/src/meri/objective-generation.types.ts', root), 'utf8');
const digestBegin = objectiveRaw.indexOf('export function digest('), digestEnd = objectiveRaw.indexOf('\nfunction exact(', digestBegin);
assert.ok(digestBegin > 0 && digestEnd > digestBegin);
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { stripTypeScriptTypes } = await import('node:module');
const digestUrl = data(stripTypeScriptTypes(`import { createHash } from 'node:crypto';\n${objectiveRaw.slice(digestBegin, digestEnd)}`));
const legacy = await import(digestUrl);
const calendarAdapter = data(`export { plannerResourceCalendarDate as plannerCalendarDate } from ${JSON.stringify(calendarUrl)};`);
const errorAdapter = data(`export class HttpException extends Error { constructor(response,status){super(response.code);this.response=response;this.status=status;}getResponse(){return this.response;}getStatus(){return this.status;} }`);
const mountedMaterialUrl = await sourceModule('../../api-strategy/src/planner/strategy-materialization.ts', [
  ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl], ["'@nestjs/common'", errorAdapter],
  ["'@capiro/strategy-verifier'", calendarAdapter], ["'../meri/objective-generation.types.js'", digestUrl],
  ["'./canonical-regeneration-plan.js'", regenerationUrl],
]);
const mountedApplicationUrl = await sourceModule('../../api-strategy/src/planner/objective-canonical-application.ts', [
  ["'@capiro/shared/objective-planner-owner-codec'", sharedUrl],
]);
const mountedMaterial = await import(mountedMaterialUrl), mountedApplication = await import(mountedApplicationUrl);
const copy = value => structuredClone(value);
const decode = f => applied.decodeObjectivePlannerApplied(f.operation, f.resources);
function rehash(f) {
  f.stored.ack.ownerReceiptSha256 = app.applicationHash(f.owner);
  f.stored.ackSha256 = app.applicationHash(f.stored.ack);
  f.resources.find(r => r.kind === 'objective_canonical_application_head').data.ackSha256 = f.stored.ackSha256;
}

test('shared full checker bodies retain immutable b8 source bytes with only explicit platform adapters', () => {
  assert.equal(baseline.sourceCommit, 'b8b7262aa0ae8b4d9ef30e75df41b147b2d6e3cf');
  for (const expected of baseline.movedFunctionBodies) {
    const material = expected.source.endsWith('/strategy-materialization.ts');
    const source = expected.adapter === 'error-transport' ? wrapperSource : material ? materialSource : applicationSource;
    const node = expected.adapter === 'error-transport' ? wrapperSource.statements.find(n => name(n) === expected.function) :
      (material ? materialFunctions : applicationFunctions).get(expected.function);
    assert.ok(node?.body, `retained original function ${expected.function}`);
    let body = node.body.getText(source);
    if (expected.function === 'materializationReceiptId') body = body.replace(
      'sha256(JSON.stringify([STRATEGY_MATERIALIZATION_RECEIPT, tenantId, actorId, requestId]))', baseline.receiptIdHashExpression);
    if (!material) body = body.replaceAll('isProxy(', 'nodeTypes.isProxy(');
    assert.equal(hash(body), expected.sha256, `immutable body parity: ${expected.function}`);
  }
  const errorClass = applicationSource.statements.find(ts.isClassDeclaration);
  assert.equal(hash(errorClass.getText(applicationSource)), baseline.applicationErrorClassSha256);
});
test('shared contract is an explicit pure subpath with no Node, Nest, Prisma or app runtime dependency', async () => {
  for (const file of ['objective-planner-materialization.ts', 'objective-planner-application.ts', 'objective-planner-owner-types.ts', 'objective-planner-owner-codec.ts']) {
    const source = parse(file, await readFile(new URL(`packages/shared/src/${file}`, root), 'utf8'));
    for (const node of source.statements.filter(ts.isImportDeclaration)) {
      assert.equal(node.importClause?.isTypeOnly, true, `only type imports in ${file}`);
      assert.match(node.moduleSpecifier.text, /^\.\/objective-planner-/);
    }
  }
  const index = await readFile(new URL('packages/shared/src/index.ts', root), 'utf8');
  assert.equal(index.includes('objective-planner-owner-codec'), false);
  const pkg = JSON.parse(await readFile(new URL('packages/shared/package.json', root), 'utf8'));
  assert.equal(pkg.exports['./objective-planner-owner-codec'].require, './dist/objective-planner-owner-codec.js');
});
test('app adapters preserve exported APIs, HTTP failure shape and one error identity', () => {
  for (const key of baseline.materializationExports) assert.equal(typeof mountedMaterial[key], 'function', key);
  for (const key of baseline.applicationExports) assert.equal(typeof mountedApplication[key], 'function', key);
  assert.equal(mountedApplication.CanonicalApplicationError, shared.CanonicalApplicationError);
  assert.throws(() => mountedMaterial.materializationError('MATERIALIZATION_OUTCOME_UNCONFIRMED', id(1)), error => {
    assert.equal(error.getStatus(), 503); assert.deepEqual(error.getResponse(), { httpStatus: 503,
      code: 'MATERIALIZATION_OUTCOME_UNCONFIRMED', requestId: id(1), message: 'Recover this request before starting another plan.',
      outcome: 'unconfirmed', recordedAttempt: null, issues: [] }); return true;
  });
  assert.throws(() => mountedApplication.parseCanonicalApplication({}), error => error instanceof shared.CanonicalApplicationError);
});
test('preserves all original hash conventions including distinct numeric-key enumeration', () => {
  for (const value of [null, false, '', '雪 🙂', 0, -1, [null, { z: 2, a: ['x'] }], { unicode: 'é', a: {}, z: [] }, fullV3().owner]) {
    assert.equal(legacy.digest(value), app.applicationHash(value));
    assert.equal(regeneration.canonicalRegenerationHash(value), app.applicationHash(value));
  }
  for (const value of [{ '2': 'b', '10': 'a' }, { nested: [{ '2': 'b', '10': 'a', '01': 1, '4294967295': 2 }] }]) {
    assert.notEqual(legacy.digest(value), app.applicationHash(value));
    assert.equal(objectiveDigest(value), legacy.digest(value));
    assert.equal(regeneration.canonicalRegenerationHash(value), app.applicationHash(value));
  }
});
test('injected existing calendar owners retain exact validation behavior', async () => {
  const sharedSource = parse('shared-calendar.ts', await readFile(new URL('packages/shared/src/planner-resource-schedule.ts', root), 'utf8'));
  const strategySource = parse('strategy-calendar.ts', await readFile(new URL('packages/strategy-verifier/src/planner.ts', root), 'utf8'));
  const a = sharedSource.statements.find(n => name(n) === 'plannerResourceCalendarDate');
  const b = strategySource.statements.find(n => name(n) === 'plannerCalendarDate');
  assert.equal(a.body.getText(sharedSource), b.body.getText(strategySource));
});
test('actual full v2 paired owner/application/head produces positive applied accounting', () => {
  const f = fullV2(), result = decode(f);
  assert.equal(result.terminalReceiptId, f.receiptId); assert.deepEqual(result.owner, f.owner);
  assert.deepEqual(result.application, f.stored); assert.equal(result.applications.length, 1);
  assert.equal(result.consumedResourceIds.length, 3);
});
test('actual full v3 decoding recursively reconstructs paired predecessor and preserved human decisions', () => {
  const f = fullV3(), result = decode(f);
  assert.equal(result.owner.receiptVersion, 3); assert.equal(result.applications.length, 2);
  assert.equal(result.owner.result.projects[0].output.id, f.work.canonical.canonicalProjectId);
  assert.ok(result.owner.result.issues.some(issue => issue.code === 'HUMAN_EDITS_PRESERVED'));
  assert.equal(JSON.stringify(result.owner).includes('PRIVATE_HUMAN_'), false);
});
test('recursive v3 predecessor-of-predecessor chain uses every actual paired application', () => {
  const f = fullV3(fullV3()), result = decode(f);
  assert.equal(result.applications.length, 3); assert.equal(result.consumedResourceIds.length, 7);
});
test('valid numeric-key v2 snapshot retains original Objective digest and positive applied decoding', () => {
  const f = fullV2({ numericKeys: true });
  assert.equal(f.work.snapshotDigest, legacy.digest(f.owner.snapshot));
  assert.notEqual(f.work.snapshotDigest, app.applicationHash(f.owner.snapshot));
  assert.deepEqual(decode(f).owner, f.owner);
});
test('valid numeric-key v3 snapshot retains original Objective digest and full predecessor proof', () => {
  const f = fullV3(fullV2(), { numericKeys: true });
  assert.equal(f.work.snapshotDigest, legacy.digest(f.owner.snapshot));
  assert.notEqual(f.work.snapshotDigest, app.applicationHash(f.owner.snapshot));
  assert.equal(decode(f).applications.length, 2);
});
for (const [label, mutate] of [
  ['missing snapshot', f => { delete f.owner.snapshot; rehash(f); }],
  ['missing fingerprint', f => { delete f.owner.fingerprint; rehash(f); }],
  ['missing archive witness', f => { delete f.owner.archivedSourceNodeIds; rehash(f); }],
  ['truncated original input', f => { delete f.owner.input.expected; rehash(f); }],
  ['coherently rehashed forged task output', f => { f.owner.result.tasks[0].output.id = id(999); f.stored.ack.tasks[0].taskId = id(999); rehash(f); }],
  ['coherently rehashed forged count', f => { f.owner.result.counts.createdTasks = 99; rehash(f); }],
  ['wrong actor', f => { f.stored.ack.actorUserId = id(998); rehash(f); }],
  ['wrong terminal receipt', f => { f.operation.terminal.receiptId = id(997); }],
  ['terminal before application', f => { f.operation.terminal.recordedAtMs = NOW; }],
  ['terminal beyond original deadline', f => { f.operation.terminal.recordedAtMs = NOW + 600000; }],
  ['wrong work hash', f => { f.operation.original.workSha256 = 'f'.repeat(64); }],
  ['archived owner receipt', f => { f.resources.find(r => r.id === f.ownerId).archived = true; }],
  ['mutable immutable-receipt version', f => { f.resources.find(r => r.id === f.ownerId).version = 2; }],
  ['missing head', f => { f.resources = f.resources.filter(r => r.kind !== 'objective_canonical_application_head'); }],
  ['mismatched head source', f => { f.resources.find(r => r.kind === 'objective_canonical_application_head').data.projectId = id(996); }],
  ['duplicate row identity', f => { f.resources.push(copy(f.resources[0])); }],
]) test(`positive applied refuses ${label}`, () => {
  const f = fullV2(); mutate(f); assert.throws(() => decode(f));
});
for (const [label, mutate] of [
  ['missing predecessor application', f => { const prior = f.owner.reconciliation.previous.applicationRequestId;
    f.resources = f.resources.filter(r => !(r.kind === 'objective_canonical_application_receipt' && r.data.request.applicationRequestId === prior)); }],
  ['missing predecessor owner', f => { f.resources = f.resources.filter(r => r.id !== f.owner.reconciliation.previous.ownerReceiptId); }],
  ['coherently rehashed false witness', f => { f.owner.reconciliation.tasks[0].appliedVersion++; rehash(f); }],
  ['coherently rehashed false predecessor', f => { f.owner.reconciliation.previous.ownerReceiptSha256 = 'e'.repeat(64); rehash(f); }],
  ['predecessor cycle', f => { f.owner.reconciliation.previous.ownerReceiptId = f.ownerId; rehash(f); }],
]) test(`v3 full predecessor proof refuses ${label}`, () => {
  const f = fullV3(); mutate(f); assert.throws(() => decode(f));
});
test('hostile JSON is rejected before accessors or proxy traps are evaluated', () => {
  for (const hostile of ['getter', 'proxy']) {
    const f = fullV2(); let observed = false;
    if (hostile === 'getter') Object.defineProperty(f.owner, 'snapshot', { enumerable: true, get() { observed = true; throw Error(); } });
    else f.resources[0].data = new Proxy(f.owner, { ownKeys() { observed = true; throw Error(); } });
    assert.throws(() => decode(f)); assert.equal(observed, false);
  }
});
test('decoded facts are detached from mutable owner rows', () => {
  const f = fullV3(), result = decode(f), before = copy(result);
  f.owner.result.tasks[0].output.id = id(990); f.stored.ack.tasks[0].taskId = id(991);
  assert.deepEqual(result, before);
});
