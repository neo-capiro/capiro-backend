import { generateKeyPairSync, sign } from 'node:crypto';
import { readerPurposes, readerTokenType } from './objective-reader-v2-contract.js';
import { createObjectiveReaderV2Request, createObjectiveReaderV2Signer, issueObjectiveReaderV2Jwt,
  verifyObjectiveReaderV2Jwt, type ObjectiveReaderV2Purpose } from './objective-reader-v2-jwt.js';

// All keys and native decisions here are SYNTHETIC, process-local source fixtures.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = 1_800_000_000;
const purposes = Object.keys(readerPurposes) as ObjectiveReaderV2Purpose[];
const keys = Object.fromEntries(purposes.map(p => [p, generateKeyPairSync('ed25519')])) as Record<ObjectiveReaderV2Purpose, ReturnType<typeof generateKeyPairSync>>;
const signer = (p: ObjectiveReaderV2Purpose) => ({ purpose: p, issuer: `urn:synthetic:objective-reader:${p}:v2`, kid: `${p}-synthetic-2`, privateKey: keys[p].privateKey });
const trust = (p: ObjectiveReaderV2Purpose) => ({ purpose: p, issuer: signer(p).issuer, kid: signer(p).kid, publicKey: keys[p].publicKey, nowSeconds: now });
const request = (p: ObjectiveReaderV2Purpose = 'active-source') => createObjectiveReaderV2Request(p, { generationJobId: id(1), sourceAdmissionSha256: 'a'.repeat(64) });
const decision = { jti: id(2), nowSeconds: now, expiresAtSeconds: now + 30 };
function token(p: ObjectiveReaderV2Purpose = 'active-source') { return issueObjectiveReaderV2Jwt(request(p), signer(p), decision); }
function resign(mutate: (header: Record<string, unknown>, claims: Record<string, unknown>) => void, transform?: (h: string, c: string) => [string, string]) {
  const [h, c] = token().split('.').map(v => Buffer.from(v!, 'base64url').toString('utf8'));
  const header = JSON.parse(h!), claims = JSON.parse(c!); mutate(header, claims);
  let hb = JSON.stringify(header), cb = JSON.stringify(claims); if (transform) [hb, cb] = transform(hb, cb);
  const input = `${Buffer.from(hb).toString('base64url')}.${Buffer.from(cb).toString('base64url')}`;
  return `${input}.${sign(null, Buffer.from(input), keys['active-source'].privateKey).toString('base64url')}`;
}

describe('Objective reader v2 distinct Ed25519 cryptographic binding', () => {
  test.each(purposes)('real synthetic Ed25519 %s round trip binds the closed nested tuple', p => {
    const r = request(p), claims = verifyObjectiveReaderV2Jwt(token(p), r, trust(p));
    expect(claims.objective).toMatchObject({ purpose: p, path: readerPurposes[p].path, query: '', method: 'POST' });
    expect(JSON.parse(Buffer.from(token(p).split('.')[0]!, 'base64url').toString())).toEqual({ alg: 'EdDSA', typ: readerTokenType, kid: signer(p).kid });
    expect(Buffer.from(r.body).toString()).toBe(JSON.stringify({ schemaVersion: 2, purpose: p, generationJobId: id(1), sourceAdmissionSha256: 'a'.repeat(64) }));
    expect(Object.isFrozen(claims.objective)).toBe(true);
  });
  test('the signer set requires separate purpose issuer/kid/key pins', () => {
    const pins = Object.fromEntries(purposes.map(p => [p, signer(p)])) as Record<ObjectiveReaderV2Purpose, ReturnType<typeof signer>>;
    expect(verifyObjectiveReaderV2Jwt(createObjectiveReaderV2Signer(pins).issue(request(), decision), request(), trust('active-source')).jti).toBe(id(2));
    expect(() => createObjectiveReaderV2Signer({ ...pins, 'historical-source': { ...pins['historical-source'], privateKey: pins['active-source'].privateKey } })).toThrow();
    expect(() => createObjectiveReaderV2Signer({ ...pins, 'historical-source': { ...pins['historical-source'], issuer: pins['active-source'].issuer } })).toThrow();
    expect(() => createObjectiveReaderV2Signer({ ...pins, 'historical-source': { ...pins['historical-source'], kid: pins['active-source'].kid } })).toThrow();
  });
  test.each(['purpose', 'operation', 'phase', 'method', 'path', 'query', 'bodySha256', 'sourceAdmissionSha256', 'generationJobId'])('rejects nested %s substitution', field => {
    const altered = resign((_h, c) => { (c.objective as Record<string, unknown>)[field] = 'wrong'; });
    expect(() => verifyObjectiveReaderV2Jwt(altered, request(), trust('active-source'))).toThrow();
  });
  test.each(['iss', 'sub', 'aud', 'jti'])('rejects top-level %s substitution', field => {
    expect(() => verifyObjectiveReaderV2Jwt(resign((_h, c) => { c[field] = 'wrong'; }), request(), trust('active-source'))).toThrow();
  });
  test.each(['RS256', 'HS256', 'none', 'Ed25519'])('rejects alg %s without algorithm fallback', alg => {
    expect(() => verifyObjectiveReaderV2Jwt(resign(h => { h.alg = alg; }), request(), trust('active-source'))).toThrow();
  });
  test.each(['typ', 'kid'])('rejects altered %s pin', field => {
    expect(() => verifyObjectiveReaderV2Jwt(resign(h => { h[field] = 'wrong'; }), request(), trust('active-source'))).toThrow();
  });
  test('rejects extra header, top-level and nested fields, duplicate fields and alternate order', () => {
    const tokens = [resign(h => { h.jku = 'https://attacker.invalid'; }), resign((_h, c) => { c.tenantId = id(1); }),
      resign((_h, c) => { (c.objective as Record<string, unknown>).binding = {}; }),
      resign(() => undefined, (h, c) => [h, c.replace(/}$/, ',"jti":"' + id(2) + '"}')]),
      resign(() => undefined, (h, c) => [h.replace(/}$/, ',"alg":"EdDSA"}'), c]),
      resign(() => undefined, (h, c) => [' ' + h, c])];
    tokens.forEach(t => expect(() => verifyObjectiveReaderV2Jwt(t, request(), trust('active-source'))).toThrow());
  });
  test('requires strict time domain with no skew or silent token refresh', () => {
    for (const patch of [{ iat: now + 1 }, { nbf: now + 1 }, { exp: now }, { exp: now + 61 }, { nbf: now - 1 }, { iat: -1 }]) {
      expect(() => verifyObjectiveReaderV2Jwt(resign((_h, c) => Object.assign(c, patch)), request(), trust('active-source'))).toThrow();
    }
    expect(verifyObjectiveReaderV2Jwt(issueObjectiveReaderV2Jwt(request(), signer('active-source'), { ...decision, expiresAtSeconds: now + 1000 }), request(), trust('active-source')).exp).toBe(now + 60);
  });
  test('rejects cross-purpose reuse, different body, path/query and wrong public key', () => {
    expect(() => verifyObjectiveReaderV2Jwt(token(), request('historical-source'), trust('historical-source'))).toThrow();
    expect(() => verifyObjectiveReaderV2Jwt(token(), { ...request(), body: Buffer.from(Buffer.from(request().body).toString() + ' ') }, trust('active-source'))).toThrow();
    expect(() => verifyObjectiveReaderV2Jwt(token(), { ...request(), query: '?x=1' } as never, trust('active-source'))).toThrow();
    expect(() => verifyObjectiveReaderV2Jwt(token(), request(), { ...trust('active-source'), publicKey: keys['retained-result'].publicKey })).toThrow();
  });
  test('refuses non-Ed25519 signer, getter/proxy inputs and oversized or noncanonical segments', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => issueObjectiveReaderV2Jwt(request(), { ...signer('active-source'), privateKey: rsa.privateKey }, decision)).toThrow();
    expect(() => createObjectiveReaderV2Request('active-source', new Proxy({ generationJobId: id(1), sourceAdmissionSha256: 'a'.repeat(64) }, {}))).toThrow();
    const getter = Object.defineProperty({ sourceAdmissionSha256: 'a'.repeat(64) }, 'generationJobId', { enumerable: true, get() { throw Error('never'); } });
    expect(() => createObjectiveReaderV2Request('active-source', getter as never)).toThrow();
    expect(() => verifyObjectiveReaderV2Jwt('x'.repeat(8193), request(), trust('active-source'))).toThrow();
    expect(() => verifyObjectiveReaderV2Jwt(token() + '=', request(), trust('active-source'))).toThrow();
  });
  test('request bytes reject executable conversion, shadowed fields, symbols, subclasses and proxies without running accessors', () => {
    let calls = 0;
    const bodies: Uint8Array[] = [];
    for (const key of ['valueOf', 'length', 'byteLength', 'buffer', Symbol.iterator]) {
      const body = Buffer.from(request().body);
      Object.defineProperty(body, key, { get() { calls++; throw Error('must not run byte getter'); }, configurable: true }); bodies.push(body);
    }
    class DerivedBytes extends Uint8Array { override valueOf() { calls++; return this; } }
    bodies.push(new DerivedBytes(request().body), new Proxy(Buffer.from(request().body), {
      get() { calls++; throw Error('must not read proxy'); }, getPrototypeOf() { calls++; throw Error('must not reflect proxy'); },
    }));
    for (const body of bodies) {
      expect(() => issueObjectiveReaderV2Jwt({ ...request(), body }, signer('active-source'), decision)).toThrow();
      expect(() => verifyObjectiveReaderV2Jwt(token(), { ...request(), body }, trust('active-source'))).toThrow();
    }
    expect(calls).toBe(0);
    const oversized = new Uint8Array(4097);
    expect(() => issueObjectiveReaderV2Jwt({ ...request(), body: oversized }, signer('active-source'), decision)).toThrow();
  });
});
