import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, constants, sign as rsaSign, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('./objective-workload-jwt.ts', import.meta.url), 'utf8');
const url = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const { issueObjectiveWorkloadJwt, verifyObjectiveWorkloadJwt,
  ObjectiveWorkloadJwtError, OBJECTIVE_WORKLOAD_JWT_TYPE,
  OBJECTIVE_GENERATION_WORKER_SUBJECT, OBJECTIVE_TERMINAL_ACCOUNTANT_SUBJECT,
  OBJECTIVE_CORE_RESULT_READER_SUBJECT, OBJECTIVE_STRATEGY_AUDIENCE,
  OBJECTIVE_MERI_RETAINED_AUDIENCE } = await import(url);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const other = generateKeyPairSync('rsa', { modulusLength: 3072 });
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = 1_800_000_000;
const issuer = 'urn:capiro:objective-workload:core:test:v1';
const audience = OBJECTIVE_STRATEGY_AUDIENCE;
const binding = Object.freeze({ subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience,
  method: 'POST', path: '/strategy-api/internal/objective-canonical/generation-admissions',
  query: '', body: Buffer.from('{"schemaVersion":1,"generationJobId":"' + id(1) + '"}'),
  operation: 'objective.strategy.draft', phase: 'admit', tenantId: id(8), generationJobId: id(1),
  delegationRef: id(2), consentId: id(3), attemptId: null, runId: null,
  acceptedBindingSha256: null, sourceSha256: null });
const signer = { issuer, kid: 'core-test-1', privateKey };
const decision = { jti: id(5), nowSeconds: now, expiresAtSeconds: now + 3600 };
const trust = { issuer, audience, nowSeconds: now, publicKeys: { 'core-test-1': publicKey } };
const issue = (b = binding, s = signer, d = decision) => issueObjectiveWorkloadJwt(b, s, d);
const verify = (token, b = binding, t = trust) => verifyObjectiveWorkloadJwt(token, b, t);
const denied = error => error instanceof ObjectiveWorkloadJwtError;

function resigned(token, mutateHeader = value => value, mutateClaims = value => value) {
  const [h, p] = token.split('.');
  const header = mutateHeader(JSON.parse(Buffer.from(h, 'base64url').toString('utf8')));
  const claims = mutateClaims(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')));
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${input}.${rsaSign('RSA-SHA256', Buffer.from(input),
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64url')}`;
}

test('issuer signs one sixty-second request-bound token and verifier returns only claims', () => {
  const token = issue();
  const claims = verify(token);
  assert.equal(claims.iss, issuer);
  assert.equal(claims.sub, binding.subject);
  assert.equal(claims.aud, audience);
  assert.equal(claims.tenantId, binding.tenantId);
  assert.equal(claims.jti, decision.jti);
  assert.equal(claims.iat, now);
  assert.equal(claims.nbf, now);
  assert.equal(claims.exp, now + 60);
  assert.equal(claims.bodySha256, createHash('sha256').update(binding.body).digest('hex'));
  assert.equal(Object.isFrozen(claims), true);
  assert.equal(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).typ,
    OBJECTIVE_WORKLOAD_JWT_TYPE);
});

test('receiver must bind exact raw bytes, method, path, empty query, phase and source IDs', () => {
  const token = issue();
  for (const change of [
    { body: Buffer.from(binding.body.toString().replace(':1,', ':1, ')) },
    { method: 'GET', body: Buffer.alloc(0) },
    { path: '/strategy-api/internal/objective-canonical/generation-acceptances' },
    { query: 'retry=1' },
    { phase: 'publish' },
    { tenantId: id(9) },
    { generationJobId: id(9) },
    { delegationRef: id(9) },
    { consentId: id(9) },
    { attemptId: id(9) },
    { runId: id(9) },
    { acceptedBindingSha256: 'a'.repeat(64) },
    { subject: 'capiro-objective-other-worker:v1' },
  ]) assert.throws(() => verify(token, { ...binding, ...change }), denied);
  assert.throws(() => verify(token, binding, { ...trust, audience: 'capiro:other-api:test:v1' }), denied);
  assert.throws(() => verify(token, binding, { ...trust, issuer: 'urn:capiro:other:test:v1' }), denied);
});

test('fixed key, algorithm and type pins reject forgery and substitution', () => {
  const token = issue();
  assert.throws(() => verify(token, binding, { ...trust, publicKeys: {} }), denied);
  assert.throws(() => verify(token, binding, { ...trust, publicKeys: { 'core-test-1': other.publicKey } }), denied);
  assert.equal(verify(token, binding, { ...trust,
    publicKeys: { 'core-test-1': publicKey, 'core-test-2': other.publicKey } }).jti, decision.jti);
  for (const changed of [
    resigned(token, h => ({ ...h, alg: 'none' })),
    resigned(token, h => ({ ...h, alg: 'HS256' })),
    resigned(token, h => ({ ...h, kid: 'core-test-2' })),
    resigned(token, h => ({ ...h, typ: 'JWT' })),
    resigned(token, h => ({ ...h, jku: 'https://attacker.invalid/keys' })),
    token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
  ]) assert.throws(() => verify(changed), denied);
});

test('bounded clock and canonical claims reject future, expiry, excess lifetime and duplicate fields', () => {
  const token = issue();
  assert.throws(() => verify(token, binding, { ...trust, nowSeconds: now - 1 }), denied);
  assert.throws(() => verify(token, binding, { ...trust, nowSeconds: now + 60 }), denied);
  assert.throws(() => issue(binding, signer, { ...decision, expiresAtSeconds: now }), denied);
  assert.throws(() => verify(resigned(token, h => h, p => ({ ...p, exp: now + 61 }))), denied);
  assert.throws(() => verify(resigned(token, h => h, p => ({ ...p, nbf: now + 1 }))), denied);
  const [h, p] = token.split('.');
  const duplicate = Buffer.from(Buffer.from(p, 'base64url').toString('utf8').replace(
    /\}$/, `,"jti":"${id(9)}"}`)).toString('base64url');
  const input = `${h}.${duplicate}`;
  const signature = rsaSign('RSA-SHA256', Buffer.from(input),
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64url');
  assert.throws(() => verify(`${input}.${signature}`), denied);
});

test('GET binds an empty body and exact job path; malformed input fails closed', () => {
  const get = { ...binding, method: 'GET', path: `${binding.path}/${binding.generationJobId}`,
    phase: 'admission-read', body: Buffer.alloc(0) };
  const token = issue(get);
  assert.equal(verify(token, get).bodySha256, createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  assert.throws(() => verify(token, { ...get, path: `${binding.path}/${id(9)}` }), denied);
  assert.throws(() => issue({ ...binding, query: 'x=1' }), denied);
  assert.throws(() => issue({ ...binding, path: '//strategy-api/internal' }), denied);
  assert.throws(() => issue({ ...binding, method: 'GET' }), denied);
  assert.throws(() => issue({ ...binding, operation: 'objective.plan.prepare' }), denied);
  assert.throws(() => verify('not.a.jwt'), denied);
});

test('accepted phases require a real full binding hash and their fixed named identity', () => {
  const accepted = { ...binding, phase: 'accept',
    path: '/strategy-api/internal/objective-canonical/generation-acceptances',
    attemptId: id(6), runId: id(7), acceptedBindingSha256: 'a'.repeat(64) };
  const token = issue(accepted);
  assert.equal(verify(token, accepted).acceptedBindingSha256, 'a'.repeat(64));
  for (const change of [
    { attemptId: null }, { runId: null }, { acceptedBindingSha256: null },
    { acceptedBindingSha256: 'b'.repeat(64) },
    { subject: OBJECTIVE_TERMINAL_ACCOUNTANT_SUBJECT },
  ]) assert.throws(() => verify(token, { ...accepted, ...change }), denied);
  assert.throws(() => issue({ ...accepted, attemptId: null }), denied);
  assert.throws(() => issue({ ...accepted, phase: 'terminal-account' }), denied);

  const terminal = { ...accepted, subject: OBJECTIVE_TERMINAL_ACCOUNTANT_SUBJECT,
    phase: 'terminal-account', path: '/strategy-api/internal/objective-canonical/generation-terminals' };
  assert.equal(verify(issue(terminal), terminal).sub, OBJECTIVE_TERMINAL_ACCOUNTANT_SUBJECT);
  const retained = { ...accepted, subject: OBJECTIVE_CORE_RESULT_READER_SUBJECT,
    audience: OBJECTIVE_MERI_RETAINED_AUDIENCE,
    phase: 'retained-result-read', path: '/v1/internal/objective-generation/retained-result/read',
    operation: 'objective.retained-result.read', sourceSha256: 'b'.repeat(64) };
  assert.equal(verify(issue(retained), retained,
    { ...trust, audience: OBJECTIVE_MERI_RETAINED_AUDIENCE }).sub, OBJECTIVE_CORE_RESULT_READER_SUBJECT);
  assert.throws(() => issue({ ...retained, audience: OBJECTIVE_STRATEGY_AUDIENCE }), denied);
  assert.throws(() => issue({ ...accepted, audience: OBJECTIVE_MERI_RETAINED_AUDIENCE }), denied);
  assert.throws(() => issue({ ...retained, subject: OBJECTIVE_GENERATION_WORKER_SUBJECT }), denied);
});

test('external authority records cannot change through accessors or Proxies', () => {
  const alternating = { ...binding };
  let reads = 0;
  Object.defineProperty(alternating, 'phase', {
    enumerable: true,
    get() { return ++reads === 1 ? 'admit' : 'publish'; },
  });
  assert.throws(() => issue(alternating), denied);
  assert.throws(() => verify(issue(), alternating), denied);
  assert.equal(reads, 0);
  assert.throws(() => issue(new Proxy({ ...binding }, {})), denied);
  assert.throws(() => verify(issue(), new Proxy({ ...binding }, {})), denied);

  const mutableSigner = { ...signer };
  Object.defineProperty(mutableSigner, 'issuer', {
    enumerable: true, get() { return issuer; },
  });
  assert.throws(() => issue(binding, mutableSigner), denied);
  const mutableDecision = { ...decision };
  Object.defineProperty(mutableDecision, 'jti', {
    enumerable: true, get() { return id(5); },
  });
  assert.throws(() => issue(binding, signer, mutableDecision), denied);
  const mutableTrust = { ...trust };
  Object.defineProperty(mutableTrust, 'audience', {
    enumerable: true, get() { return audience; },
  });
  assert.throws(() => verify(issue(), binding, mutableTrust), denied);
});
