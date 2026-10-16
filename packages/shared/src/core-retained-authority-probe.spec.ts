import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import {
  CORE_RETAINED_AUTHORITY_PROBE_OPERATION as operation,
  CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH as recipientPath,
  CoreRetainedAuthorityProbeInvalidError, CoreRetainedAuthorityProbeUnavailableError,
  createCoreRetainedAuthorityProbeSigner, createCoreRetainedAuthorityProbeCryptographicVerifier,
  parseCoreRetainedAuthorityProbeBody, parseCoreRetainedAuthorityProbeSelector,
  coreRetainedAuthorityProbeSelectorSha256, type CoreRetainedAuthorityProbeCanonicalizer,
} from './core-retained-authority-probe.js';
import { createCoreRetainedPrincipalCryptographicVerifier, CoreRetainedPrincipalInvalidError } from './core-retained-principal.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const nowMs = 1_800_000_000_000, deadlineMs = nowMs + 30_000;
const bounds = { nowMs, deadlineMs };
const selector = { schemaVersion: 1 as const, sessionKey: '', folderId: null, clientSelector: null };
const facts = {
  principal: { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', actorId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', clerkUserId: 'clerk-current-subject' },
  identityRevision: '1'.repeat(64), currentAuthority: '{"schemaVersion":1,"synthetic":true}', issuedAtMs: nowMs, originalExpiresAtMs: deadlineMs,
};
const input = { ...facts, selector }, verification = { ...bounds, selector };
const pins = { keyId: 'probe-test', issuer: 'core-test', audienceOrigin: 'https://intel.invalid', recipientPath, operation };
// A throwing provider proves that structural denials precede JCS. It does not
// serialize any value, and is never represented as RFC 8785 qualification.
const neverCanonicalize = jest.fn((_value: unknown): string => { throw new Error('no JCS reached'); });
const signer = () => createCoreRetainedAuthorityProbeSigner({ ...pins, privateKey, canonicalize: neverCanonicalize });
const verifier = () => createCoreRetainedAuthorityProbeCryptographicVerifier({ ...pins, publicKey, canonicalize: neverCanonicalize });
// Deliberately untrusted wire for negative parsing tests, NOT a JCS provider.
const untrustedWire = (value: unknown, prefix = 'CapiroRetainedAuthority ') => prefix + Buffer.from(JSON.stringify(value)).toString('base64url');
const full = () => ({ schemaVersion: 1, purpose: 'capiro-retained-florida-authority', algorithm: 'Ed25519',
  ...pins, ...facts, selectorSha256: '2'.repeat(64), signature: 'A'.repeat(86) });
beforeEach(() => neverCanonicalize.mockClear());

describe('Florida authority probe closed selector and disabled admission', () => {
  it('admits exactly the selector-only body and preserves empty session/nulls', () => {
    const result = parseCoreRetainedAuthorityProbeBody({ schemaVersion: 1, selector });
    expect(result).toEqual({ schemaVersion: 1, selector });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.selector)).toBe(true);
    expect(result.selector).not.toBe(selector);
    const exact = { ...selector, sessionKey: '  preserved session bytes  ', clientSelector: 'Exact Client' };
    expect(parseCoreRetainedAuthorityProbeSelector(exact)).toEqual(exact);
  });
  it.each([
    {}, { schemaVersion: 2, selector }, { schemaVersion: 1, selector, resourceRevision: '2'.repeat(64) },
    { schemaVersion: 1, selector, request: {} }, { schemaVersion: 1, selectorSha256: '2'.repeat(64) },
  ])('rejects authority/data extras or missing fixed body fields %j', (value) => {
    expect(() => parseCoreRetainedAuthorityProbeBody(value)).toThrow(CoreRetainedAuthorityProbeInvalidError);
  });
  it.each([
    { schemaVersion: 2 }, { sessionKey: null }, { sessionKey: 'x'.repeat(257) },
    { sessionKey: '\ud800' }, { folderId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' },
    { folderId: undefined }, { clientSelector: undefined }, { clientSelector: '' },
    { clientSelector: ' client' }, { clientSelector: 'client ' }, { clientSelector: 'x'.repeat(257) },
    { clientSelector: '\ud800' }, { clientId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
  ])('rejects a malformed or nonclosed selector %j', (change) => {
    expect(() => parseCoreRetainedAuthorityProbeSelector({ ...selector, ...change })).toThrow(CoreRetainedAuthorityProbeInvalidError);
  });
  it('admits 256-character session/client boundaries without changing bytes', () => {
    const bounded = { ...selector, sessionKey: 's'.repeat(256), clientSelector: 'c'.repeat(256), folderId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' };
    expect(parseCoreRetainedAuthorityProbeSelector(bounded)).toEqual(bounded);
  });
  it('rejects proxies/getters/nonenumerable/symbol data without invoking it', () => {
    const touched = jest.fn(() => { throw new Error('touched'); });
    const getter = { ...selector };
    Object.defineProperty(getter, 'sessionKey', { get: touched, enumerable: true });
    const hidden = { ...selector };
    Object.defineProperty(hidden, 'sessionKey', { value: '', enumerable: false });
    for (const value of [getter, hidden, new Proxy(selector, { ownKeys: touched }), Object.create(selector), { ...selector, [Symbol('x')]: true }]) {
      expect(() => parseCoreRetainedAuthorityProbeSelector(value)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    }
    expect(touched).not.toHaveBeenCalled();
  });
  it('keeps unconfigured signer/verifier unavailable before touching inputs', () => {
    const touched = jest.fn(() => { throw new Error('touched'); });
    const proxy = new Proxy({}, { ownKeys: touched, get: touched });
    expect(() => createCoreRetainedAuthorityProbeSigner().sign(proxy, bounds)).toThrow(CoreRetainedAuthorityProbeUnavailableError);
    expect(() => createCoreRetainedAuthorityProbeCryptographicVerifier(null).verifyCryptographically(proxy, verification)).toThrow(CoreRetainedAuthorityProbeUnavailableError);
    expect(touched).not.toHaveBeenCalled();
    expect(new CoreRetainedAuthorityProbeUnavailableError()).toMatchObject({ status: 503, code: 'CORE_RETAINED_AUTHORITY_PROBE_UNAVAILABLE' });
    expect(new CoreRetainedAuthorityProbeInvalidError()).toMatchObject({ status: 401, code: 'CORE_RETAINED_AUTHORITY_PROBE_INVALID' });
  });
  it('pins this exact route/operation and requires Ed25519 plus a provider', () => {
    for (const change of [{ recipientPath: '/another' }, { operation: 'get_research_portfolio' }, { privateKey: publicKey },
      { canonicalize: undefined }, { keyId: 'x'.repeat(257) }, { issuer: 'x'.repeat(257) }, { algorithm: 'HS256' }]) {
      expect(() => createCoreRetainedAuthorityProbeSigner({ ...pins, privateKey, canonicalize: neverCanonicalize, ...change } as never)).toThrow(CoreRetainedAuthorityProbeUnavailableError);
    }
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() => createCoreRetainedAuthorityProbeSigner({ ...pins, privateKey: ec.privateKey, canonicalize: neverCanonicalize })).toThrow(CoreRetainedAuthorityProbeUnavailableError);
  });
  it.each(['http://intel.invalid', 'https://intel.invalid/', 'https://user:pass@intel.invalid',
    'https://intel.invalid/path', 'https://intel.invalid?x=1', 'https://INTEL.invalid', 'https://intel.invalid:443'])(
    'rejects noncanonical HTTPS origin %s', (audienceOrigin) => {
      expect(() => createCoreRetainedAuthorityProbeSigner({ ...pins, audienceOrigin, privateKey, canonicalize: neverCanonicalize })).toThrow(CoreRetainedAuthorityProbeUnavailableError);
    },
  );
  it.each([
    { resourceRevision: '2'.repeat(64) }, { rawRequestSha256: '2'.repeat(64) }, { selectorSha256: '2'.repeat(64) },
    { identityRevision: 'A'.repeat(64) }, { currentAuthority: 'not JSON' }, { currentAuthority: JSON.stringify('x'.repeat(4095)) },
    { currentAuthority: JSON.stringify('界'.repeat(1365)) }, { issuedAtMs: nowMs + 1 }, { issuedAtMs: -0 },
    { issuedAtMs: NaN }, { originalExpiresAtMs: nowMs }, { originalExpiresAtMs: deadlineMs + 1 },
  ])('rejects data claims, invalid Core JSON or original lease facts before JCS %j', (change) => {
    expect(() => signer().sign({ ...input, ...change }, bounds)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it.each(['', 'x'.repeat(257), 'has whitespace', 'only\twhitespace', '\ud800'])(
    'rejects malformed mapped Clerk identity %j without a prefix policy', (clerkUserId) => {
      expect(() => signer().sign({ ...input, principal: { ...input.principal, clerkUserId } }, bounds)).toThrow(CoreRetainedAuthorityProbeInvalidError);
      expect(neverCanonicalize).not.toHaveBeenCalled();
    },
  );
  it('admits agreed 256-character identifiers and a 4096 UTF-8-byte Core JSON boundary', () => {
    const bounded = createCoreRetainedAuthorityProbeSigner({ ...pins, keyId: 'k'.repeat(256), issuer: 'i'.repeat(256), privateKey, canonicalize: neverCanonicalize });
    const value = { ...input, principal: { ...input.principal, clerkUserId: 'x'.repeat(256) }, currentAuthority: JSON.stringify('é'.repeat(2047)) };
    expect(Buffer.byteLength(value.currentAuthority)).toBe(4096);
    expect(() => bounded.sign(value, bounds)).toThrow(CoreRetainedAuthorityProbeUnavailableError);
    expect(neverCanonicalize).toHaveBeenCalledTimes(1);
  });
  it('binds the original caller deadline and inert signer inputs', () => {
    expect(() => signer().sign(input, { ...bounds, deadlineMs: deadlineMs - 1 })).toThrow(CoreRetainedAuthorityProbeInvalidError);
    const touched = jest.fn(() => { throw new Error('touched'); });
    const getter = { ...input };
    Object.defineProperty(getter, 'principal', { get: touched, enumerable: true });
    expect(() => signer().sign(getter, bounds)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    expect(() => signer().sign(input, new Proxy(bounds, { ownKeys: touched }))).toThrow(CoreRetainedAuthorityProbeInvalidError);
    expect(touched).not.toHaveBeenCalled(); expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it.each(['Bearer x', 'CapiroRetained x', 'CapiroRetainedAuthority  x', ' capiroRetainedAuthority x',
    'CapiroRetainedAuthority Zg=', 'CapiroRetainedAuthority Zh', 'CapiroRetainedAuthority abc\n',
    'CapiroRetainedAuthority ' + 'a'.repeat(12_000)])('rejects alternate/malformed headers %j', (header) => {
    expect(() => verifier().verifyCryptographically(header, verification)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('rejects changed purpose/route/operation and bad signature syntax before JCS', () => {
    for (const change of [{ purpose: 'capiro-retained-read-principal' }, { operation: 'get_research_portfolio' },
      { recipientPath: '/other' }, { algorithm: 'HS256' }, { keyId: 'other' }, { selectorSha256: 'A'.repeat(64) },
      { signature: 'A'.repeat(85) + 'B' }, { resourceRevision: '2'.repeat(64) }]) {
      expect(() => verifier().verifyCryptographically(untrustedWire({ ...full(), ...change }), verification)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    }
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('rejects cross-purpose envelopes in BOTH directions even if the scheme is relabelled', () => {
    const data = { schemaVersion: 1, purpose: 'capiro-retained-read-principal', algorithm: 'Ed25519', ...pins, ...facts,
      resourceRevision: '2'.repeat(64), rawRequestSha256: '3'.repeat(64), normalizedArgsSha256: '4'.repeat(64),
      normalizationContextSha256: '5'.repeat(64), signature: 'A'.repeat(86) };
    const dataVerifier = createCoreRetainedPrincipalCryptographicVerifier({ ...pins, publicKey, canonicalize: neverCanonicalize });
    const dataBounds = { ...bounds, expectedDigests: { rawRequestSha256: data.rawRequestSha256,
      normalizedArgsSha256: data.normalizedArgsSha256, normalizationContextSha256: data.normalizationContextSha256 } };
    expect(() => verifier().verifyCryptographically(untrustedWire(data, 'CapiroRetained '), verification)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    expect(() => verifier().verifyCryptographically(untrustedWire(data), verification)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    expect(() => dataVerifier.verifyCryptographically(untrustedWire(full()), dataBounds)).toThrow(CoreRetainedPrincipalInvalidError);
    expect(() => dataVerifier.verifyCryptographically(untrustedWire(full(), 'CapiroRetained '), dataBounds)).toThrow(CoreRetainedPrincipalInvalidError);
    expect(neverCanonicalize).not.toHaveBeenCalled();
  });
  it('never substitutes JSON.stringify when the required JCS provider is unavailable', () => {
    expect(() => signer().sign(input, bounds)).toThrow(CoreRetainedAuthorityProbeUnavailableError);
    expect(() => coreRetainedAuthorityProbeSelectorSha256(selector, undefined as never)).toThrow(CoreRetainedAuthorityProbeUnavailableError);
    expect(() => coreRetainedAuthorityProbeSelectorSha256(selector, () => '{}')).toThrow(CoreRetainedAuthorityProbeUnavailableError);
  });
});

// Actual JCS only; skipped cases are an explicit unrun integration gap, not passes.
let realJcs: CoreRetainedAuthorityProbeCanonicalizer | undefined;
try {
  const installed = require('canonicalize');
  if (typeof installed === 'function') realJcs = installed;
  else if (typeof installed?.default === 'function') realJcs = installed.default;
} catch { /* unavailable */ }
(realJcs ? describe : describe.skip)('Florida authority probe real-JCS/Ed25519 interoperability (requires canonicalize)', () => {
  const canonicalize = (value: unknown) => realJcs!(value);
  const issue = () => createCoreRetainedAuthorityProbeSigner({ ...pins, privateKey, canonicalize });
  const check = () => createCoreRetainedAuthorityProbeCryptographicVerifier({ ...pins, publicKey, canonicalize });
  const decode = (header: string): Record<string, any> => JSON.parse(Buffer.from(header.slice('CapiroRetainedAuthority '.length), 'base64url').toString('utf8'));
  const wire = (value: unknown) => 'CapiroRetainedAuthority ' + Buffer.from(canonicalize(value), 'utf8').toString('base64url');
  it('derives SHA from the complete parsed selector and emits no resource/data fields', () => {
    const result = check().verifyCryptographically(issue().sign(input, bounds), verification);
    expect(result.selectorSha256).toBe(createHash('sha256').update(canonicalize(selector), 'utf8').digest('hex'));
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.principal)).toBe(true);
    for (const key of ['resourceRevision', 'rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256', 'selector']) expect(key in result).toBe(false);
    expect('verify' in check()).toBe(false);
  });
  it('signs exactly the distinct actual-newline domain and canonical unsigned envelope', () => {
    const { signature, ...unsigned } = decode(issue().sign(input, bounds));
    const sig = Buffer.from(signature, 'base64url');
    expect(sig.length).toBe(64);
    expect(verifySignature(null, Buffer.from('capiro-retained-florida-authority-v1\n' + canonicalize(unsigned)), publicKey, sig)).toBe(true);
    expect(verifySignature(null, Buffer.from('capiro-retained-read-principal-v1\n' + canonicalize(unsigned)), publicKey, sig)).toBe(false);
    expect(verifySignature(null, Buffer.from('capiro-retained-florida-authority-v1\\n' + canonicalize(unsigned)), publicKey, sig)).toBe(false);
  });
  it.each([{ sessionKey: '2026' }, { folderId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }, { clientSelector: 'Exact Client' }])(
    'denies a different actual selector without requiring a resource revision %j', (change) => {
      const header = issue().sign(input, bounds);
      expect(() => check().verifyCryptographically(header, { ...verification, selector: { ...selector, ...change } })).toThrow(CoreRetainedAuthorityProbeInvalidError);
    },
  );
  it.each([{ identityRevision: '3'.repeat(64) }, { currentAuthority: '{"changed":true}' },
    { principal: { ...facts.principal, actorId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' } },
    { originalExpiresAtMs: deadlineMs - 1 }])('denies validly encoded signed-fact tampering %j', (change) => {
    expect(() => check().verifyCryptographically(wire({ ...decode(issue().sign(input, bounds)), ...change }), verification)).toThrow(CoreRetainedAuthorityProbeInvalidError);
  });
  it('rejects wrong Ed25519 key, duplicate JSON and noncanonical wire; never renews expiry', () => {
    const header = issue().sign(input, bounds), envelope = decode(header);
    const other = generateKeyPairSync('ed25519');
    expect(() => createCoreRetainedAuthorityProbeCryptographicVerifier({ ...pins, publicKey: other.publicKey, canonicalize }).verifyCryptographically(header, verification)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    const duplicate = '{"schemaVersion":1,' + canonicalize(envelope).slice(1);
    expect(() => check().verifyCryptographically('CapiroRetainedAuthority ' + Buffer.from(duplicate).toString('base64url'), verification)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    expect(() => check().verifyCryptographically(untrustedWire(Object.fromEntries(Object.entries(envelope).reverse())), verification)).toThrow(CoreRetainedAuthorityProbeInvalidError);
    expect(check().verifyCryptographically(header, { ...verification, nowMs: deadlineMs - 1 }).originalExpiresAtMs).toBe(deadlineMs);
    expect(() => check().verifyCryptographically(header, { ...verification, nowMs: deadlineMs })).toThrow(CoreRetainedAuthorityProbeInvalidError);
  });
});
