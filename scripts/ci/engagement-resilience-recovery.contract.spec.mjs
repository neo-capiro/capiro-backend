import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AUTH_RECOVERY_CASE, AUTH_RECOVERY_CALL, AUTH_RECOVERY_IMPORT,
  probeAuthRejectionRecovery, assertAuthRecoveryCase, assertResilienceReceipt,
  withoutAuthRecoveryProbe,
} from '../engagement-phase3-resilience-contract.mjs';

// IO-free probe ports and projected CLI/source controls only; never import or
// execute the application, real endpoints, provider, env, DB, or native child.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TASK = '11111111-1111-4111-8111-111111111111';
const PROGRAM = 'scripts/engagement-phase3-resilience.mjs';
const WRAPPER = 'scripts/run-engagement-phase3-resilience.mjs';
const EVIDENCE = 'scripts/verify-engagement-phase3-local-evidence.mjs';
const readSource = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value));
const refuse = (kind) => () => assert.fail(`unexpected real ${kind} in qualification`);
function response(status, body, preview = false) {
  return { kind: 'http', status, body, service: preview ? 'engagement-api' : null };
}
function fixtureCase() {
  return { id: AUTH_RECOVERY_CASE, taskId: TASK, requestCount: 4, path: '/api/engagement/tasks',
    rejected: { main: response(401, { statusCode: 401, message: 'Missing bearer token', error: 'Unauthorized' }),
      preview: response(401, { statusCode: 401, message: 'Missing bearer token', error: 'Unauthorized' }, true) },
    recovered: { main: response(200, [{ id: TASK }]), preview: response(200, [{ id: TASK }], true) } };
}
function nativeReceipt() {
  const ids = ['ordinary-429', 'ordinary-500', 'ordinary-502', 'ordinary-503', 'ordinary-504',
    'malformed_json', 'partial_response', 'reset', 'slow-timeout', 'safe-write-retry-no-duplicate',
    'database-after-boot-recovery', 'database-unavailable-at-boot', 'auth-upstream-unavailable', 'stream-interruption'];
  const results = ids.map((id) => id === 'safe-write-retry-no-duplicate'
    ? { id, retriedTask: { body: { id: TASK } } } : { id });
  results.push(fixtureCase());
  return { marker: 'ENGAGEMENT_PHASE3_RESILIENCE_COMPLETE', cases: 15, results };
}
async function runProbe(mutate = () => {}) {
  const record = fixtureCase(); mutate(record); const calls = [];
  const results = [record.rejected.main, record.rejected.preview, record.recovered.main, record.recovered.preview];
  const ports = { url: 'http://127.0.0.1:4601/api/engagement/tasks?clientId=synthetic-client', taskId: TASK,
    authenticatedHeaders: (preview) => ({ Authorization: 'Bearer synthetic-only', ...(preview ? { 'X-Capiro-Engagement-Preview': 'v3' } : {}) }),
    fetchResult: async (url, init) => { calls.push({ url, init }); return results[calls.length - 1]; } };
  return { receipt: await probeAuthRejectionRecovery(ports), calls };
}

test('new auth regression makes four local-proxy reads with isolated anonymous/authenticated headers', async () => {
  const { receipt, calls } = await runProbe();
  assert.deepEqual(receipt, fixtureCase()); assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(0, 2).map((row) => row.init.headers), [{}, { 'X-Capiro-Engagement-Preview': 'v3' }]);
  assert.equal(calls[2].init.headers.Authorization, 'Bearer synthetic-only');
  assert.equal(calls[3].init.headers['X-Capiro-Engagement-Preview'], 'v3');
  assert.ok(calls.every((row) => row.init.method === undefined && row.init.body === undefined));
  assert.ok(!JSON.stringify(receipt).includes('Bearer'));
});
for (const [label, mutate, expected] of [
  ['anonymous successful data', (r) => { r.rejected.main.status = 200; r.rejected.main.body = [{ id: TASK }]; }, /fail closed/],
  ['wrong denial status', (r) => { r.rejected.preview.status = 403; }, /fail closed/],
  ['provider/shadow refusal', (r) => { r.rejected.preview.status = 503; }, /fail closed/],
  ['transport denial', (r) => { r.rejected.main.kind = 'transport'; }, /fail closed/],
  ['malformed denial', (r) => { r.rejected.preview.body = 'not JSON'; }, /fail closed/],
  ['denial with leaked rows', (r) => { r.rejected.main.body.rows = [{ id: TASK }]; }, /fail closed/],
  ['unexpected main identity', (r) => { r.rejected.main.service = 'unrelated-service'; }, /ownership/],
  ['unsupported main-api label', (r) => { r.rejected.main.service = 'main-api'; }, /ownership/],
  ['wrong optional error class', (r) => { r.rejected.preview.body.error = 'Forbidden'; }, /fail closed/],
  ['wrong auth error', (r) => { r.rejected.main.body.message = 'database failure'; }, /fail closed/],
  ['missing preview denial identity', (r) => { r.rejected.preview.service = null; }, /ownership/],
  ['main misrouted preview', (r) => { r.rejected.main.service = 'engagement-api'; }, /ownership/],
  ['authenticated session poisoned', (r) => { r.recovered.main.status = 401; }, /recover/],
  ['recovery remains timed out', (r) => { r.recovered.preview.kind = 'timeout'; }, /recover/],
  ['empty successful recovery', (r) => { r.recovered.main.body = []; }, /recover/],
  ['wrong row recovered', (r) => { r.recovered.preview.body = [{ id: 'other' }]; }, /recover/],
  ['duplicate recovered row', (r) => { r.recovered.main.body.push({ id: TASK }); }, /recover/],
  ['wrong recovered preview identity', (r) => { r.recovered.preview.service = 'main-api'; }, /ownership/],
  ['recovery data mismatch', (r) => { r.recovered.preview.body[0].title = 'different'; }, /bodies differ/],
]) test(`new auth regression refuses: ${label}`, async () => {
  await assert.rejects(runProbe(mutate), expected);
});

test('new probe requires existing retry attribution and protected route before requests', async () => {
  for (const props of [{ taskId: '' }, { taskId: null }, { url: 'http://127.0.0.1:4601/health' }]) {
    await assert.rejects(probeAuthRejectionRecovery({ taskId: TASK, url: 'http://127.0.0.1:4601/api/engagement/tasks',
      fetchResult: refuse('request before prerequisites'), ...props }), /already-created retry row/);
  }
});
test('native result identity/count contract retains fourteen original identities plus new behavior', () => {
  assert.doesNotThrow(() => assertResilienceReceipt(nativeReceipt()));
  for (const mutate of [
    (r) => { r.cases = 14; }, (r) => { r.cases = 16; }, (r) => { r.cases = '15'; },
    (r) => { r.results[0].id = 'unrelated'; }, (r) => { r.results[0].id = r.results[1].id; },
    (r) => { r.results.at(-1).id = 'cleanup-count-padding'; }, (r) => { r.results.at(-1).requestCount = 3; },
    (r) => { r.results.at(-1).taskId = 'unattributable'; }, (r) => { delete r.results.at(-1).rejected; },
    (r) => { r.marker = 'ENGAGEMENT_PHASE3_RESILIENCE_BACKEND_SOURCE_POLICY_COMPLETE'; },
    (r) => { r.sourcePolicyOnly = true; }, (r) => { r.nativeProofPerformed = false; },
  ]) { const receipt = nativeReceipt(); mutate(receipt); assert.throws(() => assertResilienceReceipt(receipt)); }
});
test('exact earlier producer and wrapper reconstruct through declared additive case/receipt seams', () => {
  const current = readSource(PROGRAM);
  assert.equal(current.split(AUTH_RECOVERY_CALL).length, 2);
  assert.equal(current.split(AUTH_RECOVERY_IMPORT).length, 2);
  assert.equal(hash(withoutAuthRecoveryProbe(current)), '2a94b02b58bc9219a37f12905216f31154a91ad95a210b02d972b926a14a84c9');
  const oldWrapper = readSource(WRAPPER)
    .replace("import { assertResilienceReceipt } from './engagement-phase3-resilience-contract.mjs';\n", '')
    .replace('  assertResilienceReceipt(evidence);\n\n', '');
  assert.equal(hash(oldWrapper), '7298a452b940f8b02d5250da6c34440721eccb845a1f60820706da47305d860b');
});

function restoreEvidence(body) {
  return body.replace("import { assertResilienceReceipt } from './engagement-phase3-resilience-contract.mjs';\n", '')
    .replace('  assertResilienceReceipt(resilience);\n', '');
}
test('final evidence verifier original source reconstructs and retains all prior checks before additions', () => {
  const current = readSource(EVIDENCE);
  assert.equal(hash(restoreEvidence(current)), 'b3bec3448ee3c28034fa539c4bd33683c5955603f551194ea5b0196538f11220');
  assert.ok(current.indexOf('assertResilienceReceipt(resilience);') > current.indexOf('await assertNoRetainedSecrets();'));
  assert.match(current, /resilience.cases >= 15/);
});
function projection(body, name) {
  const at = body.lastIndexOf('main().catch('); assert.ok(at > 0);
  return body.slice(0, at).replace(/^#![^\n]*\n/, '').replace(/^import\s[\s\S]*?;\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(ROOT, name)).href));
}
async function wrapperRun(mutate = () => {}) {
  const receipt = nativeReceipt(); mutate(receipt); const calls = []; const writes = [];
  const context = vm.createContext({ URL, path, fileURLToPath, assertResilienceReceipt,
    process: { argv: ['node', WRAPPER], env: { DATABASE_URL: 'postgresql://synthetic.invalid:55474/synthetic', ENGAGEMENT_PHASE3_EVIDENCE_DIR: '/synthetic-evidence' },
      platform: 'linux', exit: refuse('process exit') },
    spawn: (command, args) => { calls.push(['child', command, args]); return { on: (kind, callback) => { if (kind === 'exit') callback(0); } }; },
    spawnSync: (command, args) => { calls.push(['container', command, args]); return { status: 0, stdout: args[0] === 'ps' ? 'engagement-phase3-synthetic\n' : 'DELETE 1\n0\n' }; },
    readFile: async () => JSON.stringify(receipt), writeFile: async (name, text) => writes.push(JSON.parse(text)),
    console: { log() {}, error: refuse('stderr') } });
  vm.runInContext(projection(readSource(WRAPPER), WRAPPER) + '\nglobalThis.done = main();', context);
  await context.done;
  return { calls, writes };
}
test('wrapper validates fifteen attributable results before original residual-zero cleanup', async () => {
  const result = await wrapperRun();
  assert.equal(result.writes[0].cases, 15); assert.equal(result.writes[0].results.length, 15);
  assert.equal(result.writes[0].retryRowCleaned, true); assert.equal(result.writes[0].retryCleanupResidual, 0);
  assert.equal(result.calls.filter(([kind]) => kind === 'container').length, 2);
});
test('wrapper cannot accept source-only, missing-auth or duplicate-identity evidence as native', async () => {
  for (const mutate of [(r) => { r.sourcePolicyOnly = true; }, (r) => { r.results.at(-1).id = 'other'; },
    (r) => { r.results[0].id = r.results[1].id; }]) await assert.rejects(wrapperRun(mutate));
});

test('new regression is supported by guard-before-provider, protected task and shared service identity source', () => {
  const middleware = readSource('apps/api/src/tenant/tenant-context.middleware.ts');
  assert.ok(middleware.indexOf("throw new UnauthorizedException('Missing bearer token')") < middleware.indexOf('claims = await this.clerk.verifySessionToken'));
  assert.match(readSource('apps/api/src/bootstrap/configure-api-http-app.ts'), /res.setHeader\('X-Capiro-Service', options.serviceHeader\)/);
  assert.match(readSource('apps/api/scripts/engagement-phase3-security-parity.ts'), /label: 'missing_bearer', token: null, headers: \{\}, allowed: \[401\]/);
  assert.match(readSource('apps/api/src/engagement/engagement.controller.ts'), /@Get\('tasks'\)/);
});

test('ordinary missing-bearer envelope permits absent optional error label, never wrong labels', async () => {
  const { receipt } = await runProbe((r) => { delete r.rejected.main.body.error; delete r.rejected.preview.body.error; });
  assert.equal(receipt.rejected.main.status, 401);
  assert.match(readSource('apps/api/src/main.ts'), /serviceHeader: undefined/);
  assert.match(readSource('apps/api/src/engagement-main.ts'), /serviceHeader: 'engagement-api'/);
});
