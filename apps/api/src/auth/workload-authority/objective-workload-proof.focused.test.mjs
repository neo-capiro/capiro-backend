import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('./objective-workload-proof.ts', import.meta.url), 'utf8');
const url = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const { verifyObjectiveWorkloadCallerProof, ObjectiveWorkloadProofError,
  OBJECTIVE_WORKLOAD_PROOF_TYPE, OBJECTIVE_WORKLOAD_PROOF_AUDIENCE,
  OBJECTIVE_WORKLOAD_PROOF_PATH } = await import(url);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const other = generateKeyPairSync('rsa', { modulusLength: 3072 });
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const issuer = 'urn:capiro:objective:meri:test:v1';
const subject = 'capiro-objective-generation-worker:v1';
const now = 1_800_000_000;
const kid = 'meri-worker-test-1';
const body = Buffer.from(`{"operationId":"${id(1)}","phase":"admit"}`, 'utf8');
const request = { method: 'POST', path: OBJECTIVE_WORKLOAD_PROOF_PATH,
  query: '', body, operationId: id(1) };
const pin = { issuer, subject, publicKey };
const trust = { nowSeconds: now, publicKeys: { [kid]: pin } };
const claims = { iss: issuer, sub: subject, aud: OBJECTIVE_WORKLOAD_PROOF_AUDIENCE,
  iat: now, nbf: now, exp: now + 30, jti: id(2), operationId: id(1),
  method: 'POST', path: OBJECTIVE_WORKLOAD_PROOF_PATH, query: '',
  bodySha256: createHash('sha256').update(body).digest('hex') };
const header = { alg: 'RS256', typ: OBJECTIVE_WORKLOAD_PROOF_TYPE, kid };
const denied = error => error instanceof ObjectiveWorkloadProofError;

function signed(h = header, p = claims, signingKey = privateKey) {
  const input = `${Buffer.from(JSON.stringify(h)).toString('base64url')}.` +
    Buffer.from(JSON.stringify(p)).toString('base64url');
  const signature = rsaSign('RSA-SHA256', Buffer.from(input, 'ascii'),
    { key: signingKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64url');
  return `${input}.${signature}`;
}

const verify = (token = signed(), expected = request, pins = trust) =>
  verifyObjectiveWorkloadCallerProof(token, expected, pins);

test('pinned caller proof binds one exact Core issuer request for at most thirty seconds', () => {
  const identity = verify();
  assert.deepEqual(identity, { issuer, subject, kid, proofJti: id(2), operationId: id(1),
    issuedAtSeconds: now, notBeforeSeconds: now, expiresAtSeconds: now + 30 });
  assert.equal(Object.isFrozen(identity), true);
  // Cryptography alone does not consume a proof jti; the issuer transaction does.
  assert.deepEqual(verify(), identity);
});

test('actual route, empty query, raw entity bytes and parsed operation ID must all match', () => {
  for (const changed of [
    { method: 'GET' },
    { path: '/internal/objective-workload-authority/decisions' },
    { path: `${OBJECTIVE_WORKLOAD_PROOF_PATH}?` },
    { path: `${OBJECTIVE_WORKLOAD_PROOF_PATH}/` },
    { query: 'retry=1' },
    { body: Buffer.from(body.toString().replace(',', ', ')) },
    { body: Buffer.alloc(0) },
    { operationId: id(9) },
  ]) assert.throws(() => verify(signed(), { ...request, ...changed }), denied);
  assert.throws(() => verify(signed(header, { ...claims, operationId: id(9) })), denied);
  assert.throws(() => verify(signed(header, { ...claims, method: 'GET' })), denied);
  assert.throws(() => verify(signed(header, { ...claims, path: '/internal/objective-workload-authority/decisions' })), denied);
  assert.throws(() => verify(signed(header, { ...claims, bodySha256: 'a'.repeat(64) })), denied);
});

test('key, algorithm, type, issuer, subject and audience are locally pinned', () => {
  assert.throws(() => verify(signed(), request, { ...trust, publicKeys: {} }), denied);
  assert.throws(() => verify(signed(), request, { ...trust,
    publicKeys: { [kid]: { ...pin, publicKey: other.publicKey } } }), denied);
  assert.throws(() => verify(signed({ ...header, kid: 'other-key' })), denied);
  for (const h of [
    { ...header, alg: 'none' }, { ...header, alg: 'HS256' },
    { ...header, typ: 'JWT' }, { ...header, jku: 'https://attacker.invalid/key' },
  ]) assert.throws(() => verify(signed(h)), denied);
  for (const p of [
    { ...claims, iss: 'urn:capiro:objective:other:test:v1' },
    { ...claims, sub: 'capiro-objective-terminal-accountant:v1' },
    { ...claims, aud: 'capiro:objective-strategy-api:v1' },
    { ...claims, x5u: 'https://attacker.invalid/cert' },
  ]) assert.throws(() => verify(signed(header, p)), denied);
  assert.throws(() => verify(signed(), request, { ...trust,
    publicKeys: { [kid]: { ...pin, subject: 'capiro-objective-terminal-accountant:v1' } } }), denied);
});

test('future, expired, excessive, fractional and duplicated claims fail closed', () => {
  assert.throws(() => verify(signed(), request, { ...trust, nowSeconds: now - 1 }), denied);
  assert.throws(() => verify(signed(), request, { ...trust, nowSeconds: now + 30 }), denied);
  for (const p of [
    { ...claims, iat: now + 1 }, { ...claims, nbf: now + 1 },
    { ...claims, nbf: now - 1 }, { ...claims, exp: now + 31 },
    { ...claims, exp: now }, { ...claims, iat: now + 0.5 },
    { ...claims, jti: 'not-a-uuid' },
  ]) assert.throws(() => verify(signed(header, p)), denied);
  const [h, p] = signed().split('.');
  const duplicate = Buffer.from(Buffer.from(p, 'base64url').toString().replace(
    /\}$/, `,"jti":"${id(9)}"}`)).toString('base64url');
  const input = `${h}.${duplicate}`;
  const signature = rsaSign('RSA-SHA256', Buffer.from(input, 'ascii'),
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64url');
  assert.throws(() => verify(`${input}.${signature}`), denied);
});

test('external request and trust records cannot change through getters or proxies', () => {
  const mutableRequest = { ...request };
  let reads = 0;
  Object.defineProperty(mutableRequest, 'operationId', {
    enumerable: true, get() { reads++; return id(1); },
  });
  assert.throws(() => verify(signed(), mutableRequest), denied);
  assert.equal(reads, 0);
  assert.throws(() => verify(signed(), new Proxy({ ...request }, {})), denied);
  const mutablePin = { ...pin };
  Object.defineProperty(mutablePin, 'subject', { enumerable: true, get() { return subject; } });
  assert.throws(() => verify(signed(), request, { ...trust, publicKeys: { [kid]: mutablePin } }), denied);
  assert.throws(() => verify(signed(), request, { ...trust,
    publicKeys: new Proxy({ [kid]: pin }, {}) }), denied);
});
