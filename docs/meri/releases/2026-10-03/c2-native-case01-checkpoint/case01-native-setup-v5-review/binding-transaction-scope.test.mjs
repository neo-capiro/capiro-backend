// Offline extraction of the exact inline implementation; no setup imports or DB.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const parent = 'C:/dev/main/outputs/meri-c2-20261003';
const inner = readFileSync(parent + '/case01-native-setup-v2/case01-native-setup-inner.mjs', 'utf8');
const prior = readFileSync(parent + '/case01-native-setup-v1/case01-native-setup-inner.mjs', 'utf8');
const ctx = { tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f', userId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f' };
const start = inner.indexOf('function bindingTransactionScope(prisma) {');
const end = inner.indexOf('\n\nasync function savedState()', start);
assert.ok(start > 0 && end > start);
const source = inner.slice(start, end);
const make = vm.runInNewContext(source + '\nbindingTransactionScope', { assert, CTX: ctx });

test('forwards exact scope and identical callback once with real receiver and30second option', async () => {
  const tx = Object.freeze({ identity: 'sentinel-only-not-database-proof' });
  const returned = Object.freeze({ result: 'unchanged' });
  let calls = 0;
  const callback = actual => { assert.equal(actual, tx); return returned; };
  const prisma = { withTenantUser(tenant, user, work, options) {
    calls++; assert.equal(this, prisma); assert.equal(tenant, ctx.tenantId); assert.equal(user, ctx.userId);
    assert.equal(work, callback); assert.equal(options.timeoutMs, 30000);
    assert.deepEqual(Object.keys(options), ['timeoutMs']);
    return Promise.resolve(work(tx));
  } };
  const scoped = make(prisma);
  assert.equal(Object.isFrozen(scoped), true);
  assert.deepEqual(Object.keys(scoped), ['withTenantUser']);
  assert.equal(await scoped.withTenantUser(ctx.tenantId, ctx.userId, callback), returned);
  assert.equal(calls, 1);
});

for (const [name, args] of [
  ['wrong tenant', ['other', ctx.userId, () => {}]],
  ['wrong actor', [ctx.tenantId, 'other', () => {}]],
  ['missing tenant', [undefined, ctx.userId, () => {}]],
  ['missing actor', [ctx.tenantId, undefined, () => {}]],
  ['nonfunction callback', [ctx.tenantId, ctx.userId, {}]],
  ['missing callback', [ctx.tenantId, ctx.userId]],
  ['explicit caller timeout', [ctx.tenantId, ctx.userId, () => {}, { timeoutMs: 60000 }]],
  ['caller empty options', [ctx.tenantId, ctx.userId, () => {}, {}]],
  ['caller undefined fourth argument', [ctx.tenantId, ctx.userId, () => {}, undefined]],
  ['extra arguments', [ctx.tenantId, ctx.userId, () => {}, undefined, 'extra']],
]) {
  test('rejects ' + name + ' before calling the actual owner', () => {
    let calls = 0;
    const scoped = make({ withTenantUser() { calls++; } });
    assert.throws(() => scoped.withTenantUser(...args));
    assert.equal(calls, 0);
  });
}
test('missing real method rejects instead of substituting a transaction', () => {
  assert.throws(() => make({}));
});
test('underlying async timeout propagates identical error without retry', async () => {
  let calls = 0;
  const error = Object.assign(new Error('unit timeout'), { code: 'P2028' });
  const scoped = make({ withTenantUser() { calls++; return Promise.reject(error); } });
  await assert.rejects(scoped.withTenantUser(ctx.tenantId, ctx.userId, () => {}), actual => actual === error);
  assert.equal(calls, 1);
});
test('underlying synchronous error propagates identical error without retry', () => {
  let calls = 0;
  const error = new Error('unit immediate error');
  const scoped = make({ withTenantUser() { calls++; throw error; } });
  assert.throws(() => scoped.withTenantUser(ctx.tenantId, ctx.userId, () => {}), actual => actual === error);
  assert.equal(calls, 1);
});
test('full original success/mutation/rate paths are byte-identical after removing declared additions', () => {
  let normalized = inner.replace(
    "let factory, output, stage = 'VALIDATING', sequence = 0, diagnosticSubstage = 'START';",
    "let factory, output, stage = 'VALIDATING', sequence = 0;",
  );
  const helperStart = normalized.indexOf('// Only the binding owner');
  const helperEnd = normalized.indexOf('async function savedState()', helperStart);
  normalized = normalized.slice(0, helperStart) + normalized.slice(helperEnd);
  normalized = normalized.replace('prisma: bindingTransactionScope(factory.deps.prisma), sourceAuthority', 'prisma: factory.deps.prisma, sourceAuthority');
  normalized = normalized.replace(/^ *diagnosticSubstage = '[A-Z_]+';\r?\n/gm, '');
  const diagnosticStart = normalized.indexOf('  const diagnostic = {');
  const diagnosticEnd = normalized.indexOf("  const failure = { status: 'BLOCKED_OR_UNCERTAIN'", diagnosticStart);
  normalized = normalized.slice(0, diagnosticStart) + normalized.slice(diagnosticEnd);
  normalized = normalized.replace("code, lastStage: stage, diagnostic,", "code, lastStage: stage,");
  assert.equal(normalized, prior);
});
test('v5 uses new package/dirs and pins exact diagnostic before first cloud action', () => {
  const text = readFileSync(parent + '/run-case01-native-setup-v5.mjs', 'utf8');
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.ok(text.includes("packageRoot=parent+'/case01-native-setup-v2'"));
  assert.ok(text.includes("const root=parent+'/case01-native-setup-'+mode+'-v3';"));
  assert.ok(text.includes("const prior=read(parent+'/case01-native-setup-plan-v3/result.json');"));
  assert.ok(text.includes(hash(inner)));
  assert.ok(text.includes("assert.equal(diagnosticFailureSha256,'0892b58914b29f3303c02df045894e895778707075922a6888483b33ff8774fd');"));
  assert.ok(text.includes("assert.equal(diagnosticReceiptSha256,'0197f21682e6f7297f263018620c6cd4e078b694448f2081eb01b6e0ab28f563');"));
  assert.ok(text.includes("assert.equal(diagnosticFailure.cleanup.taskStopped,true);"));
  assert.ok(text.includes("assert.equal(diagnosticFailure.cleanup.taskDefinitionInactive,true);"));
  assert.ok(text.indexOf("assert.equal(diagnosticFailure.events[1].diagnostic.errorCode,'P2028');") < text.indexOf("aws(['sts','get-caller-identity'])"));
  const old = readFileSync(parent + '/run-case01-native-setup-v4.mjs', 'utf8');
  for (const [from, to] of [['const wrapper=`', '\nconst templateBytes='], ['function assembleReceipt(rawEvents)', 'async function collectLogs()'], ["  const expected=mode==='plan'?", '\n  assert.deepEqual(receiptEvents.map']]) {
    const extract = value => value.slice(value.indexOf(from), value.indexOf(to, value.indexOf(from)));
    assert.equal(extract(text), extract(old));
  }
});
