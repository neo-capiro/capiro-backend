import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify as rsaVerify, constants } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createSignedRetainedManifest, loadRetainedVectors } from './objective-workload-retained-signed-fixtures.mjs';

const source = await readFile(new URL('./objective-workload-jwt.ts', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const { issueObjectiveWorkloadJwt, verifyObjectiveWorkloadJwt, ObjectiveWorkloadJwtError } = await import(moduleUrl);
const vectors = await loadRetainedVectors();
const fixtureKeys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const manifest = createSignedRetainedManifest(vectors, fixtureKeys);
const portable = JSON.parse(await readFile(new URL('../../../../../docs/objective-workload-authority-20261015/CORE-MERI-RETAINED-READ-SIGNED-FIXTURES-20261016.json', import.meta.url), 'utf8'));
const base = vectors.base;
const denied = error => error instanceof ObjectiveWorkloadJwtError;
const publicKey = createPublicKey(manifest.publicKeyPem);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digestSource = value => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const binding = {
  subject: base.claims.sub, audience: base.claims.aud, method: 'POST', path: base.claims.path,
  query: '', body: Buffer.from(base.rawBodyUtf8, 'utf8'), operation: base.claims.operation,
  phase: base.claims.phase, tenantId: base.claims.tenantId,
  generationJobId: base.claims.generationJobId, delegationRef: base.claims.delegationRef,
  consentId: base.claims.consentId, attemptId: base.claims.attemptId, runId: base.claims.runId,
  acceptedBindingSha256: digestSource(base.source.binding),
  sourceSha256: digestSource(base.source),
};
const trust = { issuer: manifest.issuer, audience: base.claims.aud,
  publicKeys: { [manifest.kid]: publicKey }, nowSeconds: base.nowSeconds };
const cryptographicallyValidButNotAdmitted = new Set([
  'current-baseline', 'identical-replay', 'revoked-during-read',
  'same-jti-different-valid-token', 'pending-replay', 'revoked-replay',
  'unavailable-owner', 'unavailable-current-authority', 'revoked-membership',
  'unknown-trusted-source', 'unknown-retained-custody', 'unknown-before-owner',
  'unknown-after-owner', 'unknown-identical-replay',
]);

test('63 signed cases cover the unchanged vector IDs and disposable local public pin', () => {
  assert.equal(manifest.cases.length, 63);
  assert.deepEqual(manifest.cases.map(item => item.id), vectors.cases.map(item => item.id));
  assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 3072);
  assert.equal('privateKeyPem' in manifest, false);
  assert.equal(Object.keys(manifest.baseClaims).at(-1), 'sourceSha256');
});

test('portable public-only fixture pins all 63 exact signed byte strings', () => {
  assert.equal(portable.sourceVectorSha256,
    createHash('sha256').update(JSON.stringify(vectors), 'utf8').digest('hex'));
  assert.deepEqual(portable.sourcePins, vectors.sourcePins);
  assert.deepEqual(portable.cases.map(item => item.id), vectors.cases.map(item => item.id));
  assert.equal('privateKeyPem' in portable, false);
  const portableKey = createPublicKey(portable.publicKeyPem);
  assert.equal(portableKey.asymmetricKeyDetails.modulusLength, 3072);
  for (const item of portable.cases) {
    const [h, p, signature] = item.token.split('.');
    if (item.id === 'bad-signature' || item.id === 'oversize-compact-token') continue;
    assert.equal(rsaVerify('RSA-SHA256', Buffer.from(`${h}.${p}`, 'ascii'),
      { key: portableKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(signature, 'base64url')), true, item.id);
  }
  const baseline = portable.cases[0];
  assert.deepEqual(verifyObjectiveWorkloadJwt(baseline.token, binding,
    { ...trust, publicKeys: { [portable.kid]: portableKey } }), base.claims);
});

test('Core issuer produces the exact signed flat retained-read baseline wire', () => {
  // This test uses a fresh, process-local key. It does not allocate a product
  // signer, authorize an effect, or exercise Core's unmounted ledger.
  const baseline = manifest.cases.find(item => item.id === 'current-baseline');
  const issued = issueObjectiveWorkloadJwt(binding,
    { issuer: manifest.issuer, kid: manifest.kid, privateKey: fixtureKeys.privateKey },
    { jti: base.claims.jti, nowSeconds: base.nowSeconds, expiresAtSeconds: base.claims.exp });
  assert.equal(issued, baseline.token);
  const [h, p, signature] = baseline.token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), base.header);
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), base.claims);
  assert.equal(rsaVerify('RSA-SHA256', Buffer.from(`${h}.${p}`, 'ascii'),
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(signature, 'base64url')), true);
  assert.deepEqual(verifyObjectiveWorkloadJwt(baseline.token, binding, trust), base.claims);
});

test('Core gate accepts only crypto-current cases; Meri authority and runOnce remain separate', async t => {
  for (const item of manifest.cases) await t.test(item.id, () => {
    const expected = { ...binding, body: Buffer.from(item.rawBodyBase64, 'base64') };
    const clock = { ...trust, nowSeconds: item.nowSeconds };
    if (cryptographicallyValidButNotAdmitted.has(item.id)) {
      const claims = verifyObjectiveWorkloadJwt(item.token, expected, clock);
      assert.equal(claims.jti, base.claims.jti);
      if (item.id === 'same-jti-different-valid-token') {
        assert.equal(claims.exp, 1800000029);
        assert.notEqual(item.token, manifest.cases[0].token);
        assert.equal(claims.exp > item.nowSeconds, true);
      }
    } else {
      assert.throws(() => verifyObjectiveWorkloadJwt(item.token, expected, clock), denied);
    }
  });
});

test('signed fixture source/body hashes are independently reproduced from all trusted fields', () => {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const raw = Buffer.from(base.rawBodyUtf8, 'utf8');
  assert.equal(hash(raw), base.claims.bodySha256);
  assert.equal(hash(Buffer.from(base.canonicalSourceUtf8, 'utf8')), base.claims.sourceSha256);
  assert.equal(hash(Buffer.from(base.canonicalBindingUtf8, 'utf8')), base.claims.acceptedBindingSha256);
  assert.equal(binding.sourceSha256, base.claims.sourceSha256);
  assert.equal(binding.acceptedBindingSha256, base.claims.acceptedBindingSha256);
  assert.equal(base.source.binding.writerFence, 1);
  assert.equal(base.source.binding.workerId, '00000000-0000-4000-8000-000000000005');
});

test('synthetic size cases cross exactly their documented limits', () => {
  const byId = id => manifest.cases.find(item => item.id === id);
  const parts = id => byId(id).token.split('.');
  assert.equal(Buffer.from(parts('oversize-header')[0], 'base64url').length, 1025);
  assert.equal(Buffer.from(parts('oversize-payload')[1], 'base64url').length, 4097);
  assert.equal(`${parts('oversize-signing-input')[0]}.${parts('oversize-signing-input')[1]}`.length, 4097);
  assert.equal(byId('oversize-compact-token').token.length, 8193);
  assert.equal(Buffer.from(byId('oversize-raw-body').rawBodyBase64, 'base64').length, 65537);
});
