import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import {
  CORE_RETAINED_PRINCIPAL_MAX_BYTES,
  CoreRetainedPrincipalInvalidError, CoreRetainedPrincipalUnavailableError,
  createCoreRetainedPrincipalCryptographicVerifier, createCoreRetainedPrincipalSigner,
  type CoreRetainedPrincipalCanonicalizer, type CoreRetainedPrincipalSignInput,
  type CoreRetainedReadOperation,
} from './core-retained-principal.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const nowMs = 1_800_000_000_000;
const deadlineMs = nowMs + 30_000;
const bounds = { nowMs, deadlineMs };
const facts: CoreRetainedPrincipalSignInput = {
  principal: { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', actorId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', clerkUserId: 'user_current' },
  identityRevision: '1'.repeat(64), resourceRevision: '2'.repeat(64),
  rawRequestSha256: '3'.repeat(64), normalizedArgsSha256: '4'.repeat(64), normalizationContextSha256: '5'.repeat(64),
  currentAuthority: '{"schemaVersion":1,"observation":"synthetic-only"}',
  issuedAtMs: nowMs, originalExpiresAtMs: deadlineMs,
};
const expectedDigests = {
  rawRequestSha256: facts.rawRequestSha256, normalizedArgsSha256: facts.normalizedArgsSha256,
  normalizationContextSha256: facts.normalizationContextSha256,
};
const verification = { ...bounds, expectedDigests };
const pins = {
  keyId: 'synthetic-key-1', issuer: 'synthetic-core', audienceOrigin: 'https://intel.invalid',
  recipientPath: '/internal/retained-read', operation: 'get_florida_budget_project' as CoreRetainedReadOperation,
};
// Negative structural tests must reject before touching a JCS provider. This is
// deliberately NOT a substitute JSON serializer or a claim of JCS qualification.
const neverCanonicalize = jest.fn((_value: unknown): string => { throw new Error('JCS must not be reached'); });
const signer = () => createCoreRetainedPrincipalSigner({ ...pins, privateKey, canonicalize: neverCanonicalize });
const verifier = () => createCoreRetainedPrincipalCryptographicVerifier({ ...pins, publicKey, canonicalize: neverCanonicalize });
beforeEach(() => neverCanonicalize.mockClear());

describe('retained principal closed inputs and unavailable defaults', () => {
  it('keeps absent signer/verifier inert, before inspecting untrusted values', () => {
    const traps = jest.fn(() => { throw new Error('must not inspect'); });
    const poison = new Proxy({}, { get: traps, ownKeys: traps });
    expect(() => createCoreRetainedPrincipalSigner().sign(poison, bounds)).toThrow(CoreRetainedPrincipalUnavailableError);
    expect(() => createCoreRetainedPrincipalCryptographicVerifier(null).verifyCryptographically(poison, verification)).toThrow(CoreRetainedPrincipalUnavailableError);
    expect(traps).not.toHaveBeenCalled();
  });
  it('provides closed typed denial metadata', () => {
    expect(new CoreRetainedPrincipalUnavailableError()).toMatchObject({ status: 503, code: 'CORE_RETAINED_PRINCIPAL_UNAVAILABLE' });
    expect(new CoreRetainedPrincipalInvalidError()).toMatchObject({ status: 401, code: 'CORE_RETAINED_PRINCIPAL_INVALID' });
  });
  it.each(['http://intel.invalid', 'https://intel.invalid/', 'https://u:p@intel.invalid', 'https://intel.invalid/path',
    'https://intel.invalid?x=1', 'https://intel.invalid#x', 'https://INTEL.invalid', 'https://intel.invalid:443'])(
    'rejects a noncanonical or non-origin audience %s', (audienceOrigin) => {
      expect(() => createCoreRetainedPrincipalSigner({ ...pins, audienceOrigin, privateKey, canonicalize: neverCanonicalize })).toThrow(CoreRetainedPrincipalUnavailableError);
    },
  );
  it.each(['relative', '//other.invalid/read', '/read?x=1', '/read#x', '/a/../read', '/a\\read', '/read '])(
    'rejects a nonexact recipient path %s', (recipientPath) => {
      expect(() => createCoreRetainedPrincipalSigner({ ...pins, recipientPath, privateKey, canonicalize: neverCanonicalize })).toThrow(CoreRetainedPrincipalUnavailableError);
    },
  );
  it('requires pinned asymmetric Ed25519 keys and a canonicalizer', () => {
    expect(() => createCoreRetainedPrincipalSigner({ ...pins, privateKey: publicKey, canonicalize: neverCanonicalize })).toThrow(CoreRetainedPrincipalUnavailableError);
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() => createCoreRetainedPrincipalSigner({ ...pins, privateKey: ec.privateKey, canonicalize: neverCanonicalize })).toThrow(CoreRetainedPrincipalUnavailableError);
    expect(() => createCoreRetainedPrincipalSigner({ ...pins, privateKey, canonicalize: undefined } as never)).toThrow(CoreRetainedPrincipalUnavailableError);
    expect(() => createCoreRetainedPrincipalSigner({ ...pins, privateKey, canonicalize: neverCanonicalize, algorithm: 'HS256' } as never)).toThrow(CoreRetainedPrincipalUnavailableError);
  });
  it('rejects unknown, missing and nonenumerable fields before JCS', () => {
    const { resourceRevision: _required, ...missing } = facts;
    const hidden = { ...facts };
    Object.defineProperty(hidden, 'resourceRevision', { value: facts.resourceRevision, enumerable: false });
    for (const input of [{ ...facts, actor: 'user_other' }, missing, hidden, { ...facts, [Symbol('hidden')]: 1 }]) {
      expect(() => signer().sign(input, bounds)).toThrow(CoreRetainedPrincipalInvalidError);
    }
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('never calls input/principal getters or proxy traps', () => {
    const getter = jest.fn(() => facts.principal);
    const input = { ...facts };
    Object.defineProperty(input, 'principal', { get: getter, enumerable: true });
    const traps = jest.fn(() => { throw new Error('proxy touched'); });
    for (const value of [input, new Proxy(facts, { ownKeys: traps }), { ...facts, principal: new Proxy(facts.principal, { get: traps }) }]) {
      expect(() => signer().sign(value, bounds)).toThrow(CoreRetainedPrincipalInvalidError);
    }
    expect(getter).not.toHaveBeenCalled(); expect(traps).not.toHaveBeenCalled();
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('rejects inherited and nonplain principal data', () => {
    expect(() => signer().sign({ ...facts, principal: Object.create(facts.principal) }, bounds)).toThrow(CoreRetainedPrincipalInvalidError);
    expect(() => signer().sign(Object.assign(new Date(), facts), bounds)).toThrow(CoreRetainedPrincipalInvalidError);
  });
  it.each([
    ['tenantId', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'], ['actorId', 'not-a-uuid'],
    ['clerkUserId', ''], ['clerkUserId', 'x'.repeat(257)], ['clerkUserId', 'not whitespace-free'], ['clerkUserId', '\ud800'],
  ])('rejects malformed canonical principal %s', (key, value) => {
    expect(() => signer().sign({ ...facts, principal: { ...facts.principal, [key]: value } }, bounds)).toThrow(CoreRetainedPrincipalInvalidError);
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it.each(['identityRevision', 'resourceRevision', 'rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256'])(
    'rejects malformed digest %s', (key) => {
      expect(() => signer().sign({ ...facts, [key]: 'A'.repeat(64) }, bounds)).toThrow(CoreRetainedPrincipalInvalidError);
      expect(neverCanonicalize).not.toHaveBeenCalled();
    },
  );
  it.each(['', 'not json', '\ud800', JSON.stringify('x'.repeat(4095)), '"' + '界'.repeat(CORE_RETAINED_PRINCIPAL_MAX_BYTES) + '"'])(
    'rejects missing/malformed/oversized opaque Core JSON without interpreting business policy', (currentAuthority) => {
      expect(() => signer().sign({ ...facts, currentAuthority }, bounds)).toThrow(CoreRetainedPrincipalInvalidError);
      expect(neverCanonicalize).not.toHaveBeenCalled();
    },
  );
  it.each([
    { issuedAtMs: nowMs + 1 }, { issuedAtMs: -1 }, { issuedAtMs: -0 }, { issuedAtMs: NaN }, { issuedAtMs: Infinity },
    { originalExpiresAtMs: nowMs }, { originalExpiresAtMs: nowMs - 1 },
    { originalExpiresAtMs: nowMs + 30_001 }, { originalExpiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { originalExpiresAtMs: nowMs + 0.5 },
  ])('rejects invalid/expired/future/overlong time facts %j', (change) => {
    expect(() => signer().sign({ ...facts, ...change }, bounds)).toThrow(CoreRetainedPrincipalInvalidError);
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('enforces the original caller deadline and closed trusted time input', () => {
    for (const value of [{ nowMs, deadlineMs: deadlineMs - 1 }, { nowMs, deadlineMs: nowMs },
      { nowMs: NaN, deadlineMs }, { ...bounds, extra: 1 }]) {
      expect(() => signer().sign(facts, value)).toThrow(CoreRetainedPrincipalInvalidError);
    }
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'Bearer abc', 'capiroretained abc', ' CapiroRetained abc', 'CapiroRetained  abc',
    'CapiroRetained abc\n', 'CapiroRetained abc=', 'CapiroRetained +/==', ['CapiroRetained abc'],
    'CapiroRetained ' + 'a'.repeat(12_000)])('rejects alternate authorization encoding %j', (header) => {
    expect(() => verifier().verifyCryptographically(header, verification)).toThrow(CoreRetainedPrincipalInvalidError);
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('rejects invalid UTF-8 and noncanonical base64url padding bits', () => {
    for (const encoded of [Buffer.from([0xff]).toString('base64url'), 'Zh']) {
      expect(() => verifier().verifyCryptographically('CapiroRetained ' + encoded, verification)).toThrow(CoreRetainedPrincipalInvalidError);
    }
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('rejects malformed envelope/expected-digest data before JCS or crypto', () => {
    // JSON.stringify creates deliberately UNTRUSTED test wire, never a JCS provider.
    const full = { schemaVersion: 1, purpose: 'capiro-retained-read-principal', algorithm: 'Ed25519',
      keyId: pins.keyId, issuer: pins.issuer, audienceOrigin: pins.audienceOrigin,
      recipientPath: pins.recipientPath, operation: pins.operation, ...facts, signature: 'A'.repeat(86) };
    const wire = (value: unknown) => 'CapiroRetained ' + Buffer.from(JSON.stringify(value)).toString('base64url');
    const { resourceRevision: _required, ...missing } = full;
    for (const value of [missing, { ...full, extra: true }, { ...full, algorithm: 'HS256' },
      { ...full, signature: 'A'.repeat(85) + 'B' }, { ...full, keyId: 'another' }]) {
      expect(() => verifier().verifyCryptographically(wire(value), verification)).toThrow(CoreRetainedPrincipalInvalidError);
    }
    for (const expected of [{ ...expectedDigests, extra: true }, { ...expectedDigests, rawRequestSha256: '9'.repeat(64) }, null]) {
      expect(() => verifier().verifyCryptographically(wire(full), { ...verification, expectedDigests: expected } as never)).toThrow(CoreRetainedPrincipalInvalidError);
    }
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('does not invoke trusted-bound/config getters or proxy traps', () => {
    const getter = jest.fn(() => nowMs);
    const value = { ...bounds };
    Object.defineProperty(value, 'nowMs', { get: getter, enumerable: true });
    expect(() => signer().sign(facts, value)).toThrow(CoreRetainedPrincipalInvalidError);
    const option = { ...pins, privateKey, canonicalize: neverCanonicalize };
    Object.defineProperty(option, 'keyId', { get: getter, enumerable: true });
    expect(() => createCoreRetainedPrincipalSigner(option as never)).toThrow(CoreRetainedPrincipalUnavailableError);
    const traps = jest.fn(() => { throw new Error('proxy touched'); });
    expect(() => signer().sign(facts, new Proxy(bounds, { ownKeys: traps }))).toThrow(CoreRetainedPrincipalInvalidError);
    expect(getter).not.toHaveBeenCalled(); expect(traps).not.toHaveBeenCalled();
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('fails unavailable when the installed JCS provider throws or changes facts', () => {
    expect(() => signer().sign(facts, bounds)).toThrow(CoreRetainedPrincipalUnavailableError);
    const wrong = createCoreRetainedPrincipalSigner({ ...pins, privateKey, canonicalize: () => '{}' });
    expect(() => wrong.sign(facts, bounds)).toThrow(CoreRetainedPrincipalUnavailableError);
  });
  it('admits agreed 256-character identifiers and a 4096-byte Core JSON boundary before JCS', () => {
    const bounded = createCoreRetainedPrincipalSigner({ ...pins, keyId: 'k'.repeat(256), issuer: 'i'.repeat(256), privateKey, canonicalize: neverCanonicalize });
    const input = { ...facts, principal: { ...facts.principal, clerkUserId: 'x'.repeat(256) }, currentAuthority: JSON.stringify('x'.repeat(4094)) };
    expect(Buffer.byteLength(input.currentAuthority)).toBe(4096);
    expect(() => bounded.sign(input, bounds)).toThrow(CoreRetainedPrincipalUnavailableError);
    expect(neverCanonicalize).toHaveBeenCalledTimes(1);
    expect(() => createCoreRetainedPrincipalSigner({ ...pins, keyId: 'k'.repeat(257), privateKey, canonicalize: neverCanonicalize })).toThrow(CoreRetainedPrincipalUnavailableError);
  });
});

// No hand-written JCS clone and no JSON.stringify fallback. The positive crypto
// suite is explicitly skipped unless an actual canonicalize package is supplied
// by the test owner. Skips must be reported; they are not qualification passes.
let realJcs: CoreRetainedPrincipalCanonicalizer | undefined;
try {
  const installed = require('canonicalize');
  if (typeof installed === 'function') realJcs = installed;
  else if (typeof installed?.default === 'function') realJcs = installed.default;
} catch { /* Missing provider is an explicit test integration gap. */ }
const withJcs = realJcs ? describe : describe.skip;
withJcs('retained principal real-JCS Ed25519 interoperability (requires canonicalize)', () => {
  const canonicalize = (value: unknown) => realJcs!(value);
  const issue = (operation = pins.operation) => createCoreRetainedPrincipalSigner({ ...pins, operation, privateKey, canonicalize });
  const check = (operation = pins.operation) => createCoreRetainedPrincipalCryptographicVerifier({ ...pins, operation, publicKey, canonicalize });
  const decode = (header: string): Record<string, any> => JSON.parse(Buffer.from(header.slice('CapiroRetained '.length), 'base64url').toString('utf8'));
  const encode = (value: unknown) => 'CapiroRetained ' + Buffer.from(canonicalize(value), 'utf8').toString('base64url');
  it.each(['get_research_portfolio', 'get_research_portfolio_changes', 'get_florida_budget_project'] as CoreRetainedReadOperation[])(
    'round-trips only the constructor-pinned operation %s', (operation) => {
      const header = issue(operation).sign(facts, bounds);
      const result = check(operation).verifyCryptographically(header, verification);
      expect(result).toMatchObject({ ...facts, operation, purpose: 'capiro-retained-read-principal', algorithm: 'Ed25519' });
      expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.principal)).toBe(true);
      expect(Buffer.from(header.slice('CapiroRetained '.length), 'base64url').length).toBeLessThanOrEqual(8192);
      expect('verify' in check(operation)).toBe(false);
    },
  );
  it('signs the actual newline domain plus canonical unsigned bytes', () => {
    const { signature, ...unsigned } = decode(issue().sign(facts, bounds));
    const sig = Buffer.from(signature, 'base64url');
    expect(sig.length).toBe(64);
    expect(verifySignature(null, Buffer.from('capiro-retained-read-principal-v1\n' + canonicalize(unsigned)), publicKey, sig)).toBe(true);
    expect(verifySignature(null, Buffer.from('capiro-retained-read-principal-v1\\n' + canonicalize(unsigned)), publicKey, sig)).toBe(false);
  });
  it.each([
    { principal: { ...facts.principal, actorId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' } },
    { identityRevision: '6'.repeat(64) }, { resourceRevision: '7'.repeat(64) },
    { currentAuthority: '{"observation":"different"}' }, { issuedAtMs: nowMs - 1 },
    { originalExpiresAtMs: deadlineMs - 1 }, { keyId: 'different-key' },
    { issuer: 'other-core' }, { audienceOrigin: 'https://other.invalid' },
    { recipientPath: '/other' }, { operation: 'get_research_portfolio' },
    { purpose: 'other-purpose' }, { algorithm: 'HS256' }, { extra: 'field' },
  ])('denies signed tuple or pinned trust tampering %j', (change) => {
    const changed = { ...decode(issue().sign(facts, bounds)), ...change };
    expect(() => check().verifyCryptographically(encode(changed), verification)).toThrow(CoreRetainedPrincipalInvalidError);
  });
  it.each(['rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256'] as const)(
    'requires the actual expected %s', (key) => {
      const header = issue().sign(facts, bounds);
      expect(() => check().verifyCryptographically(header, { ...verification, expectedDigests: { ...expectedDigests, [key]: '8'.repeat(64) } })).toThrow(CoreRetainedPrincipalInvalidError);
    },
  );
  it('rejects wrong public key, malformed signature, duplicate JSON keys and non-JCS wire', () => {
    const header = issue().sign(facts, bounds), full = decode(header);
    const other = generateKeyPairSync('ed25519');
    expect(() => createCoreRetainedPrincipalCryptographicVerifier({ ...pins, publicKey: other.publicKey, canonicalize }).verifyCryptographically(header, verification)).toThrow(CoreRetainedPrincipalInvalidError);
    expect(() => check().verifyCryptographically(encode({ ...full, signature: full.signature + '=' }), verification)).toThrow(CoreRetainedPrincipalInvalidError);
    const canonical = canonicalize(full);
    const duplicate = '{"schemaVersion":1,' + canonical.slice(1);
    expect(() => check().verifyCryptographically('CapiroRetained ' + Buffer.from(duplicate).toString('base64url'), verification)).toThrow(CoreRetainedPrincipalInvalidError);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(full).reverse()));
    expect(() => check().verifyCryptographically('CapiroRetained ' + Buffer.from(reordered).toString('base64url'), verification)).toThrow(CoreRetainedPrincipalInvalidError);
  });
  it('accepts the 30-second boundary only while unexpired and never renews on verification', () => {
    const header = issue().sign(facts, bounds);
    expect(check().verifyCryptographically(header, { ...verification, nowMs: deadlineMs - 1 }).originalExpiresAtMs).toBe(deadlineMs);
    expect(() => check().verifyCryptographically(header, { ...verification, nowMs: deadlineMs })).toThrow(CoreRetainedPrincipalInvalidError);
    expect(() => check().verifyCryptographically(header, { ...verification, deadlineMs: deadlineMs - 1 })).toThrow(CoreRetainedPrincipalInvalidError);
  });
});
