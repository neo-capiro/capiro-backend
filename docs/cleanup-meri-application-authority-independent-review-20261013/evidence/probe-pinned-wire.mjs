import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const evidence = path.dirname(new URL(import.meta.url).pathname);
const stage = '/workspace/capiro-application-authority-wire-review-20261013';
const head = '7ad86d7acc1234e446cacb61c8e7f00b4bf989ab';
const references = JSON.parse(fs.readFileSync(path.join(evidence, 'reference-identities.json')));
const paths = [
  'packages/contracts/action-authority-0.2/validate.mjs',
  'packages/contracts/commands-0.2/execution-boundary.mjs',
  'packages/contracts/retrieval-0.2/operation-contracts.mjs',
];
for (const sourcePath of paths) {
  const row = references.identities.find(row => row.head === head && row.path === sourcePath);
  const bytes = fs.readFileSync(path.join(stage, sourcePath));
  assert(row && bytes.length === row.bytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), row.sha256);
}
const wire = await import(pathToFileURL(path.join(stage, paths[0])));
assert.deepEqual(wire.applicationAuthorityRoutes, {
  identity: '/api/clio/application-authority/identity',
  context: '/api/clio/application-authority/context',
});
const id = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const hash = 'a'.repeat(64);
const contextRequest = () => ({ identitySha256: hash, conversationId: id, clientId: client });
const identityReceipt = () => ({ principal: { tenantId: id, actorId: client }, identityRevision: 'r1', checkedAtMs: 1000, expiresAtMs: 2000 });
const contextReceipt = () => ({ ...identityReceipt(), identitySha256: hash, conversationId: id, selectedClientId: client, contextRevision: 'c1' });
const cases = [];
function probe(name, method, value, accepted) {
  let result, error;
  try { result = wire[method](value); } catch (caught) { error = String(caught.message); }
  const actual = error === undefined;
  cases.push({ name, expectedAccepted: accepted, accepted: actual, passed: actual === accepted, ...(error ? { error } : {}) });
  if (actual) assert(Object.isFrozen(result));
}
probe('identity exact empty object', 'assertAuthorityIdentityRequest', {}, true);
probe('identity null-prototype inert object', 'assertAuthorityIdentityRequest', Object.create(null), true);
for (const [name, value] of [['null', null], ['array', []], ['scalar', ''], ['unknown authority', { tenantId: id }], ['custom prototype', Object.create({})], ['symbol field', { [Symbol('extra')]: 1 }]])
  probe('identity refuses ' + name, 'assertAuthorityIdentityRequest', value, false);
let getterCalls = 0;
const getter = {}; Object.defineProperty(getter, 'tenantId', { enumerable: true, get() { getterCalls++; throw Error('GETTER_RAN'); } });
probe('identity refuses accessor without invocation', 'assertAuthorityIdentityRequest', getter, false);
probe('identity refuses hidden field', 'assertAuthorityIdentityRequest', Object.defineProperty({}, 'x', { value: 1 }), false);
let proxyCalls = 0;
const proxy = new Proxy({}, { getPrototypeOf() { proxyCalls++; throw Error('PROXY_RAN'); }, ownKeys() { proxyCalls++; throw Error('PROXY_RAN'); } });
probe('identity refuses proxy without traps', 'assertAuthorityIdentityRequest', proxy, false);
probe('context exact selectors', 'assertAuthorityContextRequest', contextRequest(), true);
for (const [name, patch] of [
  ['empty hash', { identitySha256: '' }], ['short hash', { identitySha256: 'a'.repeat(63) }],
  ['long hash', { identitySha256: 'a'.repeat(65) }], ['uppercase hash', { identitySha256: 'A'.repeat(64) }],
  ['hash final newline', { identitySha256: hash + '\n' }], ['malformed uuid', { conversationId: 'bad' }],
  ['uuid final newline', { conversationId: id + '\n' }], ['uppercase uuid', { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() }],
  ['null client', { clientId: null }], ['caller principal', { principal: { tenantId: id, actorId: client } }],
  ['caller approval', { approval: true }], ['caller run', { runId: id }],
]) probe('context refuses ' + name, 'assertAuthorityContextRequest', { ...contextRequest(), ...patch }, false);
for (const field of ['identitySha256', 'conversationId', 'clientId']) {
  const value = contextRequest(); delete value[field];
  probe('context refuses missing ' + field, 'assertAuthorityContextRequest', value, false);
}
for (const [name, value] of [['nil UUID syntax', '00000000-0000-0000-0000-000000000000'], ['v7 UUID syntax', '11111111-1111-7111-8111-111111111111'], ['v8 UUID syntax', '11111111-1111-8111-8111-111111111111']])
  probe('context retains generic ' + name, 'assertAuthorityContextRequest', { ...contextRequest(), conversationId: value }, true);
for (const [name, factory, method] of [['identity', identityReceipt, 'assertAuthorityIdentityReceipt'], ['context', contextReceipt, 'assertAuthorityContextReceipt']]) {
  probe(name + ' exact receipt', method, factory(), true);
  for (const [label, patch] of [
    ['unsafe checked time', { checkedAtMs: Number.MAX_SAFE_INTEGER + 1 }], ['negative checked time', { checkedAtMs: -1 }],
    ['fractional checked time', { checkedAtMs: 1.5 }], ['equal expiry', { expiresAtMs: 1000 }],
    ['earlier expiry', { expiresAtMs: 999 }], ['unsafe expiry', { expiresAtMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['empty identity revision', { identityRevision: '' }], ['long identity revision', { identityRevision: 'r'.repeat(257) }],
    ['profile disclosure', { email: 'synthetic@example.invalid' }], ['token disclosure', { token: 'synthetic' }],
  ]) probe(name + ' refuses ' + label, method, { ...factory(), ...patch }, false);
  for (const field of ['tenantId', 'actorId']) {
    for (const [label, value] of [['empty', ''], ['long', 'x'.repeat(257)], ['not-string', 1]]) {
      const receipt = factory(); receipt.principal[field] = value;
      probe(name + ' refuses ' + label + ' principal ' + field, method, receipt, false);
    }
  }
  const receipt = factory(); receipt.principal.role = 'admin';
  probe(name + ' refuses extra principal role', method, receipt, false);
  const boundary = factory(); boundary.identityRevision = 'r'.repeat(256); boundary.principal.actorId = 'a'.repeat(256);
  probe(name + ' retains 256-character text boundary', method, boundary, true);
}
for (const [name, patch] of [['empty context revision', { contextRevision: '' }], ['long context revision', { contextRevision: 'c'.repeat(257) }], ['extra fence', { writerFence: 1 }], ['null selected client', { selectedClientId: null }]])
  probe('context receipt refuses ' + name, 'assertAuthorityContextReceipt', { ...contextReceipt(), ...patch }, false);
assert.equal(getterCalls, 0); assert.equal(proxyCalls, 0);
const result = { sourceHead: head, sourceIdentitiesVerified: paths.length, total: cases.length,
  passed: cases.filter(row => row.passed).length, failed: cases.filter(row => !row.passed), cases,
  getterCalls, proxyCalls, realClerkProviderDatabaseOrMeriFixtureCalls: 0,
  scope: 'Actual pinned wire admission only; no Capiro candidate authority or live acceptance.' };
const output = path.join(evidence, 'pinned-wire-probe.json');
assert(!fs.existsSync(output)); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ total: result.total, passed: result.passed, failed: result.failed }, null, 2));
assert.equal(result.failed.length, 0);
