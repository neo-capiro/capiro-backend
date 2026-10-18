import { KeyObject, createHash, createPublicKey, sign, verify } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { readerLimits, readerPurposes, readerTokenType } from './objective-reader-v2-contract.js';
import type { CoreEd25519Signer } from '../core-ed25519-signer.js';

/** A distinct Objective-only protocol. These primitives authenticate a bounded
 * request; the issuer and reader still require genuine native/source authority.
 * Historical RS256 and the existing Meri reader gate are intentionally untouched. */
export type ObjectiveReaderV2Purpose = keyof typeof readerPurposes;
export interface ObjectiveReaderV2Selector { readonly generationJobId: string; readonly sourceAdmissionSha256: string }
export interface ObjectiveReaderV2Request extends ObjectiveReaderV2Selector {
  readonly purpose: ObjectiveReaderV2Purpose; readonly method: 'POST'; readonly path: string;
  readonly query: ''; readonly body: Uint8Array;
}
export interface ObjectiveReaderV2Scope extends ObjectiveReaderV2Selector {
  readonly purpose: ObjectiveReaderV2Purpose; readonly operation: string; readonly phase: string;
  readonly method: 'POST'; readonly path: string; readonly query: ''; readonly bodySha256: string;
}
export interface ObjectiveReaderV2Claims {
  readonly iss: string; readonly sub: string; readonly aud: string;
  readonly iat: number; readonly nbf: number; readonly exp: number; readonly jti: string;
  readonly objective: ObjectiveReaderV2Scope;
}
export interface ObjectiveReaderV2Signer {
  readonly purpose: ObjectiveReaderV2Purpose; readonly issuer: string; readonly kid: string; readonly privateKey: KeyObject;
}
export interface ObjectiveReaderV2Decision { readonly jti: string; readonly nowSeconds: number; readonly expiresAtSeconds: number }
export interface ObjectiveReaderV2Trust {
  readonly purpose: ObjectiveReaderV2Purpose; readonly issuer: string; readonly kid: string;
  readonly publicKey: KeyObject; readonly nowSeconds: number;
}
export class ObjectiveReaderV2Unavailable extends Error { constructor() { super('OBJECTIVE_READER_V2_UNAVAILABLE'); } }
function refuse(): never { throw new ObjectiveReaderV2Unavailable(); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const kidPattern = /^[A-Za-z0-9._-]{1,64}$/;
const issuerPattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const segment = /^[A-Za-z0-9_-]+$/;
const exact = (pattern: RegExp, v: unknown): v is string => typeof v === 'string' && pattern.exec(v)?.[0] === v;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const objectiveReaderV2Hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Snapshot data properties once, rejecting executable or changing input. */
function own(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype) refuse();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some(k => typeof k !== 'string' || !fields.includes(k))) refuse();
  return Object.fromEntries(fields.map(k => {
    const d = Object.getOwnPropertyDescriptor(input, k);
    if (!d || !('value' in d)) refuse();
    return [k, d.value];
  }));
}
function purpose(v: unknown): v is ObjectiveReaderV2Purpose { return typeof v === 'string' && Object.hasOwn(readerPurposes, v); }
function edKey(v: unknown, type: 'private' | 'public'): v is KeyObject {
  return !nodeTypes.isProxy(v) && v instanceof KeyObject && v.type === type && v.asymmetricKeyType === 'ed25519';
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const nativeOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
function bytes(raw: unknown): Buffer {
  if (nodeTypes.isProxy(raw) || !(raw instanceof Uint8Array) ||
      ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(raw))) refuse();
  // Native getters plus a pristine local view avoid caller valueOf/length/
  // iterator getters. Integer-indexed views cannot define index accessors.
  const length = nativeLength.call(raw) as number, keys = Reflect.ownKeys(raw);
  if (length < 1 || length > readerLimits.requestBytes || keys.length !== length ||
      keys.some((key, index) => key !== String(index))) refuse();
  return Buffer.from(new Uint8Array(nativeBuffer.call(raw), nativeOffset.call(raw), length));
}

export function createObjectiveReaderV2Request(p: ObjectiveReaderV2Purpose, selector: ObjectiveReaderV2Selector): ObjectiveReaderV2Request {
  try {
    const s = own(selector, ['generationJobId', 'sourceAdmissionSha256']) as unknown as ObjectiveReaderV2Selector;
    if (!purpose(p) || !exact(uuid, s.generationJobId) || !exact(sha, s.sourceAdmissionSha256)) refuse();
    const body = Buffer.from(JSON.stringify({ schemaVersion: 2, purpose: p,
      generationJobId: s.generationJobId, sourceAdmissionSha256: s.sourceAdmissionSha256 }), 'utf8');
    if (body.length > readerLimits.requestBytes) refuse();
    return Object.freeze({ purpose: p, generationJobId: s.generationJobId, sourceAdmissionSha256: s.sourceAdmissionSha256,
      method: 'POST' as const, path: readerPurposes[p].path, query: '' as const, body });
  } catch { return refuse(); }
}
function request(value: ObjectiveReaderV2Request): ObjectiveReaderV2Request {
  const v = own(value, ['purpose', 'generationJobId', 'sourceAdmissionSha256', 'method', 'path', 'query', 'body']) as unknown as ObjectiveReaderV2Request;
  const body = bytes(v.body);
  const expected = createObjectiveReaderV2Request(v.purpose, { generationJobId: v.generationJobId, sourceAdmissionSha256: v.sourceAdmissionSha256 });
  if (v.method !== 'POST' || v.path !== expected.path || v.query !== '' || !body.equals(expected.body)) refuse();
  return expected;
}
function scope(v: ObjectiveReaderV2Request): ObjectiveReaderV2Scope {
  const descriptor = readerPurposes[v.purpose];
  return { purpose: v.purpose, operation: descriptor.operation, phase: descriptor.phase,
    method: 'POST', path: descriptor.path, query: '', bodySha256: objectiveReaderV2Hash(v.body),
    sourceAdmissionSha256: v.sourceAdmissionSha256, generationJobId: v.generationJobId };
}
const headerJson = (kid: string): string => JSON.stringify({ alg: 'EdDSA', typ: readerTokenType, kid });
const claimsJson = (v: ObjectiveReaderV2Claims): string => JSON.stringify({ iss: v.iss, sub: v.sub, aud: v.aud,
  iat: v.iat, nbf: v.nbf, exp: v.exp, jti: v.jti, objective: v.objective });

/** Header and claims segments for one purpose; the caller signs the ASCII input. */
function signingInput(b: ObjectiveReaderV2Request, issuer: string, kid: string, decision: ObjectiveReaderV2Decision): string {
  const d = own(decision, ['jti', 'nowSeconds', 'expiresAtSeconds']) as unknown as ObjectiveReaderV2Decision;
  if (!exact(issuerPattern, issuer) || !exact(kidPattern, kid) ||
      !exact(uuid4, d.jti) || !integer(d.nowSeconds) || !integer(d.expiresAtSeconds)) refuse();
  const exp = Math.min(d.expiresAtSeconds, d.nowSeconds + readerLimits.maxTokenSeconds);
  if (exp <= d.nowSeconds) refuse();
  const claims: ObjectiveReaderV2Claims = { iss: issuer, sub: readerPurposes[b.purpose].subject,
    aud: readerPurposes[b.purpose].audience, iat: d.nowSeconds, nbf: d.nowSeconds, exp, jti: d.jti, objective: scope(b) };
  return `${Buffer.from(headerJson(kid)).toString('base64url')}.${Buffer.from(claimsJson(claims)).toString('base64url')}`;
}

/** Only call after current native/source decisions and durable JTI allocation.
 * This helper neither creates a grant nor renews an original execution expiry. */
export function issueObjectiveReaderV2Jwt(binding: ObjectiveReaderV2Request, signer: ObjectiveReaderV2Signer,
  decision: ObjectiveReaderV2Decision): string {
  try {
    const b = request(binding), s = own(signer, ['purpose', 'issuer', 'kid', 'privateKey']) as unknown as ObjectiveReaderV2Signer;
    if (s.purpose !== b.purpose || !edKey(s.privateKey, 'private')) refuse();
    const input = signingInput(b, s.issuer, s.kid, decision);
    const token = `${input}.${sign(null, Buffer.from(input, 'ascii'), s.privateKey).toString('base64url')}`;
    if (Buffer.byteLength(token) > readerLimits.tokenBytes) refuse();
    return token;
  } catch { return refuse(); }
}

/**
 * D7-2: the same token through the asynchronous pure-Ed25519 signer shape
 * (`core-ed25519-signer.ts`), so the private key can be an AWS KMS
 * `ECC_NIST_EDWARDS25519` key (ED25519_SHA_512 over RAW) or an in-process key.
 * Byte-identical to `issueObjectiveReaderV2Jwt` for the same key and inputs.
 */
export async function issueObjectiveReaderV2JwtAsync(binding: ObjectiveReaderV2Request,
  signer: { readonly purpose: ObjectiveReaderV2Purpose; readonly signer: CoreEd25519Signer },
  decision: ObjectiveReaderV2Decision, options: { signal?: AbortSignal } = {}): Promise<string> {
  let input: string, ed: CoreEd25519Signer;
  try {
    const b = request(binding), s = own(signer, ['purpose', 'signer']);
    ed = s.signer as CoreEd25519Signer;
    if (s.purpose !== b.purpose || !ed || typeof ed.sign !== 'function' || !edKey(ed.publicKey, 'public')) refuse();
    input = signingInput(b, ed.issuer, ed.kid, decision);
  } catch { return refuse(); }
  let signature: Buffer;
  try { signature = await ed.sign(Buffer.from(input, 'ascii'), { signal: options.signal }); } catch { return refuse(); }
  if (!verify(null, Buffer.from(input, 'ascii'), ed.publicKey, signature)) refuse();
  const token = `${input}.${signature.toString('base64url')}`;
  if (Buffer.byteLength(token) > readerLimits.tokenBytes) refuse();
  return token;
}

/** Published per-purpose public JWK pin for Meri's v2 reader gate:
 * `(iss, sub, aud, kid) -> OKP/Ed25519`. No private material. */
export interface ObjectiveReaderV2PublicPin {
  readonly purpose: ObjectiveReaderV2Purpose;
  readonly iss: string; readonly sub: string; readonly aud: string; readonly kid: string;
  readonly jwk: { readonly kty: 'OKP'; readonly crv: 'Ed25519'; readonly x: string;
    readonly kid: string; readonly alg: 'EdDSA'; readonly use: 'sig' };
}

/**
 * Server-owned three-purpose set over the async signer shape. Purposes may not
 * share a key, issuer or kid (same rule as the in-process set). `publicPins`
 * is the exact material Meri pins; it is produced from the signers' pinned
 * public keys (KMS `GetPublicKey` readback), never from request input.
 */
export function createObjectiveReaderV2AsyncSigner(signers: Readonly<Record<ObjectiveReaderV2Purpose, CoreEd25519Signer>>) {
  const values = own(signers, Object.keys(readerPurposes));
  const seenKeys = new Set<string>(), seenIssuers = new Set<string>(), seenKids = new Set<string>();
  const captured = {} as Record<ObjectiveReaderV2Purpose, CoreEd25519Signer>;
  for (const p of Object.keys(readerPurposes) as ObjectiveReaderV2Purpose[]) {
    const s = values[p] as CoreEd25519Signer;
    if (!s || typeof s.sign !== 'function' || !edKey(s.publicKey, 'public') ||
        !exact(issuerPattern, s.issuer) || !exact(kidPattern, s.kid)) refuse();
    const key = createHash('sha256').update(s.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (seenKeys.has(key) || seenIssuers.has(s.issuer) || seenKids.has(s.kid)) refuse();
    seenKeys.add(key); seenIssuers.add(s.issuer); seenKids.add(s.kid); captured[p] = s;
  }
  const publicPins: readonly ObjectiveReaderV2PublicPin[] = Object.freeze((Object.keys(readerPurposes) as ObjectiveReaderV2Purpose[]).map(p => {
    const s = captured[p], x = s.publicKey.export({ format: 'jwk' }).x;
    if (typeof x !== 'string') refuse();
    return Object.freeze({ purpose: p, iss: s.issuer, sub: readerPurposes[p].subject, aud: readerPurposes[p].audience, kid: s.kid,
      jwk: Object.freeze({ kty: 'OKP' as const, crv: 'Ed25519' as const, x: x as string, kid: s.kid, alg: 'EdDSA' as const, use: 'sig' as const }) });
  }));
  return Object.freeze({
    publicPins,
    issue: (b: ObjectiveReaderV2Request, d: ObjectiveReaderV2Decision, options?: { signal?: AbortSignal }): Promise<string> =>
      issueObjectiveReaderV2JwtAsync(b, { purpose: b.purpose, signer: captured[b.purpose] }, d, options),
  });
}
function decode(part: string, maxBytes: number): string {
  if (!exact(segment, part)) refuse();
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.length > maxBytes || bytes.toString('base64url') !== part) refuse();
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export function verifyObjectiveReaderV2Jwt(token: string, binding: ObjectiveReaderV2Request,
  trust: ObjectiveReaderV2Trust): Readonly<ObjectiveReaderV2Claims> {
  try {
    const b = request(binding), t = own(trust, ['purpose', 'issuer', 'kid', 'publicKey', 'nowSeconds']) as unknown as ObjectiveReaderV2Trust;
    if (t.purpose !== b.purpose || !exact(issuerPattern, t.issuer) || !exact(kidPattern, t.kid) || !edKey(t.publicKey, 'public') ||
        !integer(t.nowSeconds) || typeof token !== 'string' || Buffer.byteLength(token) > readerLimits.tokenBytes) refuse();
    const parts = token.split('.');
    if (parts.length !== 3) refuse();
    const h = decode(parts[0]!, 1024), c = decode(parts[1]!, 4096);
    if (h !== headerJson(t.kid)) refuse();
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (!exact(segment, parts[2]!) || signature.toString('base64url') !== parts[2] || signature.length !== 64 ||
        !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), t.publicKey, signature)) refuse();
    const v = own(JSON.parse(c), ['iss', 'sub', 'aud', 'iat', 'nbf', 'exp', 'jti', 'objective']) as unknown as ObjectiveReaderV2Claims;
    own(v.objective, ['purpose', 'operation', 'phase', 'method', 'path', 'query', 'bodySha256', 'sourceAdmissionSha256', 'generationJobId']);
    if (c !== claimsJson(v) || v.iss !== t.issuer || v.sub !== readerPurposes[b.purpose].subject ||
        v.aud !== readerPurposes[b.purpose].audience || !integer(v.iat) || !integer(v.nbf) || !integer(v.exp) ||
        v.nbf < v.iat || v.exp <= v.nbf || v.exp - v.iat > readerLimits.maxTokenSeconds ||
        v.iat > t.nowSeconds || v.nbf > t.nowSeconds || v.exp <= t.nowSeconds || !exact(uuid4, v.jti) ||
        JSON.stringify(v.objective) !== JSON.stringify(scope(b))) refuse();
    return Object.freeze({ ...v, objective: Object.freeze({ ...v.objective }) });
  } catch { return refuse(); }
}

/** A server-owned three-purpose signer set prevents accidental purpose/key
 * reuse at composition. No key is loaded from request JSON or remote metadata. */
export function createObjectiveReaderV2Signer(signers: Readonly<Record<ObjectiveReaderV2Purpose, ObjectiveReaderV2Signer>>) {
  const values = own(signers, Object.keys(readerPurposes));
  const captured = Object.fromEntries(Object.keys(readerPurposes).map(p => [p,
    own(values[p], ['purpose', 'issuer', 'kid', 'privateKey'])])) as unknown as Record<ObjectiveReaderV2Purpose, ObjectiveReaderV2Signer>;
  const seenKeys = new Set<string>(), seenIssuers = new Set<string>(), seenKids = new Set<string>();
  for (const p of Object.keys(readerPurposes) as ObjectiveReaderV2Purpose[]) {
    const s = captured[p];
    if (s.purpose !== p || !edKey(s.privateKey, 'private') || !exact(issuerPattern, s.issuer) || !exact(kidPattern, s.kid)) refuse();
    const key = createHash('sha256').update(createPublicKey(s.privateKey).export({ type: 'spki', format: 'der' })).digest('hex');
    if (seenKeys.has(key) || seenIssuers.has(s.issuer) || seenKids.has(s.kid)) refuse();
    seenKeys.add(key); seenIssuers.add(s.issuer); seenKids.add(s.kid); Object.freeze(s);
  }
  return Object.freeze({ issue: (b: ObjectiveReaderV2Request, d: ObjectiveReaderV2Decision): string =>
    issueObjectiveReaderV2Jwt(b, captured[b.purpose], d) });
}
