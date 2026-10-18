import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import { types as nodeTypes } from 'node:util';
import type { ClerkSessionClaims } from './clerk.service.js';
import type { ApplicationAuthorityIdentityEvidence } from './application-authority.js';
import type { RetainedFloridaSelector } from './retained-read-authority.js';

/** Core-internal delegation material. It is never an identity/context receipt. */
export interface RetainedNativeAuthorityCapture {
  readonly principal: Readonly<{ tenantId: string; actorId: string; clerkUserId: string }>;
  readonly identityRevision: string;
  readonly currentAuthority: string;
  readonly originalExpiresAtMs: number;
}
/** Runtime acceptance additionally requires the receiving codec closure below. */
export interface VerifiedRetainedNativeAuthority extends RetainedNativeAuthorityCapture {}
export interface RetainedNativeAuthorityCurrent {
  readonly context: Readonly<TenantContext>;
  readonly identity: Readonly<ApplicationAuthorityIdentityEvidence>;
}
export interface RetainedNativeAuthorityVerificationBounds {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly expectedDigests: Readonly<{
    rawRequestSha256: string;
    normalizedArgsSha256: string;
    normalizationContextSha256: string;
  }>;
}
/** The signed codec owns trust and actual request digests; this adapter owns no keys. */
export interface RetainedNativeAuthorityCryptographicVerifier {
  verifyCryptographically(authorization: unknown, bounds: RetainedNativeAuthorityVerificationBounds): RetainedNativeAuthorityCapture;
}
export interface RetainedNativeAuthorityReceiver {
  verifyCryptographically(authorization: unknown, bounds: RetainedNativeAuthorityVerificationBounds): VerifiedRetainedNativeAuthority;
}
export interface RetainedNativeAuthorityProbeBounds {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly selector: Readonly<RetainedFloridaSelector>;
}
export interface RetainedNativeAuthorityProbeCryptographicVerifier {
  verifyCryptographically(authorization: unknown, bounds: RetainedNativeAuthorityProbeBounds): RetainedNativeAuthorityCapture;
}
export interface RetainedNativeAuthorityProbeReceiver {
  verifyCryptographically(authorization: unknown, bounds: RetainedNativeAuthorityProbeBounds): VerifiedRetainedNativeAuthority;
}

interface NativeProvenance {
  context: TenantContext;
  claims: ClerkSessionClaims;
  membershipId: string;
  membershipTenantId: string;
  requestedSlug: string | undefined;
  impersonationId: string | null;
}
interface NativeFrame {
  schemaVersion: 1;
  context: TenantContext;
  claims: {
    sub: string; sid: string; exp: number; iss: string;
    org_id: string | null; capiro_tenant_id: string | null; capiro_tenant_slug: string | null;
  };
  membershipId: string;
  membershipTenantId: string;
  requestedSlug: string | null;
  impersonationId: string | null;
  authorityExpiresAtMs: number;
}

const MAX_FRAME_BYTES = 4096;
const HASH = /^[0-9a-f]{64}$/;
const CLERK_ID = /^[A-Za-z0-9_-]{1,256}$/;
const verifiedByReceivingCodec = new WeakSet<object>();
const invalid = () => new UnauthorizedException('Retained native authority unavailable');
const denied = () => new ForbiddenException('Application authority unavailable');
const changed = () => new ConflictException('Retained authority changed; reload');

/** Only this closure can mark the result, and it calls the trusted codec itself.
 * A copied/body projection or a verifier-shaped object passed to recheck is not proof. */
export function createRetainedNativeAuthorityReceiver(
  codec: RetainedNativeAuthorityCryptographicVerifier,
): RetainedNativeAuthorityReceiver {
  const verify = ownValue(codec, 'verifyCryptographically');
  if (typeof verify !== 'function' || nodeTypes.isProxy(verify)) throw invalid();
  return Object.freeze({
    verifyCryptographically(authorization: unknown, bounds: RetainedNativeAuthorityVerificationBounds) {
      const value = closed(bounds, ['nowMs', 'deadlineMs', 'expectedDigests']);
      const digests = closed(value.expectedDigests, ['rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256']);
      if (!safeTime(value.nowMs) || !safeTime(value.deadlineMs) || value.deadlineMs <= value.nowMs ||
          !Object.values(digests).every(isHash)) throw invalid();
      return verifiedProjection(verify.call(codec, authorization, bounds), value.nowMs, value.deadlineMs);
    },
  });
}

/** Fixed-purpose probe codec only: actual selector binding, never data/dummy digests.
 * The separate native-current endpoint can recheck identity without resource recursion. */
export function createRetainedNativeAuthorityProbeReceiver(
  codec: RetainedNativeAuthorityProbeCryptographicVerifier,
): RetainedNativeAuthorityProbeReceiver {
  const verify = ownValue(codec, 'verifyCryptographically');
  if (typeof verify !== 'function' || nodeTypes.isProxy(verify)) throw invalid();
  return Object.freeze({
    verifyCryptographically(authorization: unknown, bounds: RetainedNativeAuthorityProbeBounds) {
      const value = closed(bounds, ['nowMs', 'deadlineMs', 'selector']);
      if (!safeTime(value.nowMs) || !safeTime(value.deadlineMs) || value.deadlineMs <= value.nowMs) throw invalid();
      closed(value.selector, ['schemaVersion', 'sessionKey', 'folderId', 'clientSelector']);
      return verifiedProjection(verify.call(codec, authorization, bounds), value.nowMs, value.deadlineMs);
    },
  });
}

function verifiedProjection(envelope: unknown, nowMs: number, deadlineMs: number): VerifiedRetainedNativeAuthority {
  // The codec envelope has other signed fields; retain only this closed projection.
  const projection = snapshotCapture({
    principal: ownValue(envelope, 'principal'), identityRevision: ownValue(envelope, 'identityRevision'),
    currentAuthority: ownValue(envelope, 'currentAuthority'), originalExpiresAtMs: ownValue(envelope, 'originalExpiresAtMs'),
  });
  if (projection.originalExpiresAtMs <= nowMs || projection.originalExpiresAtMs > deadlineMs) throw invalid();
  verifiedByReceivingCodec.add(projection);
  return projection;
}

/** Serialization only, called after the native middleware's actual WeakMap check.
 * No request, bearer, raw JWT, session object, callback or extra claim is serialized. */
export function captureRetainedNativeAuthority(
  provenance: NativeProvenance,
  evidence: ApplicationAuthorityIdentityEvidence,
): RetainedNativeAuthorityCapture {
  const frame = snapshotFrame({
    schemaVersion: 1,
    context: provenance.context,
    claims: {
      sub: ownValue(provenance.claims, 'sub'), sid: ownValue(provenance.claims, 'sid'),
      exp: ownValue(provenance.claims, 'exp'), iss: ownValue(provenance.claims, 'iss'),
      org_id: optionalClaim(provenance.claims, 'org_id'),
      capiro_tenant_id: optionalClaim(provenance.claims, 'capiro_tenant_id'),
      capiro_tenant_slug: optionalClaim(provenance.claims, 'capiro_tenant_slug'),
    },
    membershipId: provenance.membershipId, membershipTenantId: provenance.membershipTenantId,
    requestedSlug: provenance.requestedSlug ?? null, impersonationId: provenance.impersonationId,
    authorityExpiresAtMs: evidence.expiresAtMs,
  });
  if (frame.context.clerkUserId !== frame.claims.sub || frame.context.tenantId !== evidence.principal.tenantId ||
      frame.context.userId !== evidence.principal.actorId || frame.authorityExpiresAtMs <= Date.now()) throw denied();
  return snapshotCapture({
    principal: { tenantId: frame.context.tenantId, actorId: frame.context.userId, clerkUserId: frame.context.clerkUserId },
    identityRevision: evidence.identityRevision, currentAuthority: JSON.stringify(frame), originalExpiresAtMs: frame.authorityExpiresAtMs,
  });
}

/** The caller supplies only the same existing canonical current-owner callback.
 * This never populates native request provenance or reconstructs an HTTP request. */
export async function requiresVerifiedRetainedNativeAuthority(
  verified: VerifiedRetainedNativeAuthority,
  readCurrent: (provenance: NativeProvenance) => Promise<ApplicationAuthorityIdentityEvidence>,
): Promise<RetainedNativeAuthorityCurrent> {
  if (!verified || typeof verified !== 'object' || nodeTypes.isProxy(verified) || !verifiedByReceivingCodec.has(verified)) throw invalid();
  const frame = parseFrame(verified.currentAuthority);
  if (frame.context.tenantId !== verified.principal.tenantId || frame.context.userId !== verified.principal.actorId ||
      frame.context.clerkUserId !== verified.principal.clerkUserId || frame.claims.sub !== verified.principal.clerkUserId ||
      verified.originalExpiresAtMs > frame.authorityExpiresAtMs || verified.originalExpiresAtMs <= Date.now()) throw invalid();
  const claims: ClerkSessionClaims = Object.freeze({
    sub: frame.claims.sub, sid: frame.claims.sid, exp: frame.claims.exp, iss: frame.claims.iss,
    ...(frame.claims.org_id === null ? {} : { org_id: frame.claims.org_id }),
    ...(frame.claims.capiro_tenant_id === null ? {} : { capiro_tenant_id: frame.claims.capiro_tenant_id }),
    ...(frame.claims.capiro_tenant_slug === null ? {} : { capiro_tenant_slug: frame.claims.capiro_tenant_slug }),
  });
  const context = Object.freeze({ ...frame.context });
  const provenance = Object.freeze({ context, claims, membershipId: frame.membershipId,
    membershipTenantId: frame.membershipTenantId, requestedSlug: frame.requestedSlug ?? undefined, impersonationId: frame.impersonationId });
  // Canonical 401/403 removals and session refusals propagate unchanged.
  const current = await readCurrent(provenance);
  if (verified.originalExpiresAtMs <= Date.now()) throw invalid();
  if (current.principal.tenantId !== verified.principal.tenantId || current.principal.actorId !== verified.principal.actorId ||
      current.identityRevision !== verified.identityRevision || !safeTime(current.expiresAtMs) ||
      current.expiresAtMs < verified.originalExpiresAtMs) throw changed();
  return Object.freeze({ context, identity: Object.freeze({
    principal: Object.freeze({ tenantId: current.principal.tenantId, actorId: current.principal.actorId }),
    identityRevision: current.identityRevision, expiresAtMs: verified.originalExpiresAtMs,
  }) });
}

// The Core-only frame schema/parser is intentionally private to this module.
function parseFrame(text: string): NativeFrame {
  if (!validFrameText(text)) throw invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  const frame = snapshotFrame(value);
  // Native capture emits this exact closed encoding: reject duplicate keys and aliases.
  if (JSON.stringify(frame) !== text) throw invalid();
  return frame;
}

function snapshotFrame(input: unknown): NativeFrame {
  const value = closed(input, ['schemaVersion', 'context', 'claims', 'membershipId', 'membershipTenantId', 'requestedSlug', 'impersonationId', 'authorityExpiresAtMs']);
  const ctx = closed(value.context, ['tenantId', 'tenantSlug', 'userId', 'clerkUserId', 'role']);
  const claims = closed(value.claims, ['sub', 'sid', 'exp', 'iss', 'org_id', 'capiro_tenant_id', 'capiro_tenant_slug']);
  if (value.schemaVersion !== 1 || !['tenantId', 'tenantSlug', 'userId', 'clerkUserId'].every(key => boundedText(ctx[key], 256)) ||
      typeof ctx.role !== 'string' || !Object.hasOwn(ROLE_RANK, ctx.role) ||
      typeof claims.sub !== 'string' || !CLERK_ID.test(claims.sub) || typeof claims.sid !== 'string' || !CLERK_ID.test(claims.sid) ||
      !boundedText(claims.iss, 2048) || !safeTime(claims.exp) || !Number.isSafeInteger(claims.exp * 1000) ||
      !['org_id', 'capiro_tenant_id', 'capiro_tenant_slug'].every(key => claims[key] === null || boundedText(claims[key], 256, true)) ||
      !boundedText(value.membershipId, 256) || !boundedText(value.membershipTenantId, 256) ||
      !(value.requestedSlug === null || boundedText(value.requestedSlug, 256)) ||
      !(value.impersonationId === null || boundedText(value.impersonationId, 256)) ||
      !safeTime(value.authorityExpiresAtMs) || value.authorityExpiresAtMs > claims.exp * 1000) throw invalid();
  return {
    schemaVersion: 1,
    context: { tenantId: ctx.tenantId as string, tenantSlug: ctx.tenantSlug as string, userId: ctx.userId as string,
      clerkUserId: ctx.clerkUserId as string, role: ctx.role as TenantRole },
    claims: { sub: claims.sub, sid: claims.sid, exp: claims.exp, iss: claims.iss,
      org_id: claims.org_id as string | null, capiro_tenant_id: claims.capiro_tenant_id as string | null,
      capiro_tenant_slug: claims.capiro_tenant_slug as string | null },
    membershipId: value.membershipId, membershipTenantId: value.membershipTenantId,
    requestedSlug: value.requestedSlug as string | null, impersonationId: value.impersonationId as string | null,
    authorityExpiresAtMs: value.authorityExpiresAtMs,
  };
}

function snapshotCapture(input: unknown): RetainedNativeAuthorityCapture {
  const value = closed(input, ['principal', 'identityRevision', 'currentAuthority', 'originalExpiresAtMs']);
  const principal = closed(value.principal, ['tenantId', 'actorId', 'clerkUserId']);
  if (!Object.values(principal).every(id => boundedText(id, 256)) || !isHash(value.identityRevision) ||
      !validFrameText(value.currentAuthority) || !safeTime(value.originalExpiresAtMs)) throw invalid();
  return Object.freeze({ principal: Object.freeze({ tenantId: principal.tenantId as string, actorId: principal.actorId as string,
    clerkUserId: principal.clerkUserId as string }), identityRevision: value.identityRevision,
    currentAuthority: value.currentAuthority, originalExpiresAtMs: value.originalExpiresAtMs });
}
function closed(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw invalid();
  const actual = Reflect.ownKeys(input);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) result[key] = ownValue(input, key);
  return result;
}
function ownValue(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalid();
  return descriptor.value;
}
function optionalClaim(input: ClerkSessionClaims, key: 'org_id' | 'capiro_tenant_id' | 'capiro_tenant_slug'): unknown {
  if (nodeTypes.isProxy(input)) throw invalid();
  if (!Object.hasOwn(input, key)) return null;
  const value = ownValue(input, key);
  return value === undefined ? null : value;
}
function boundedText(value: unknown, limit: number, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= limit &&
    Buffer.from(value, 'utf8').toString('utf8') === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isHash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function validFrameText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_FRAME_BYTES &&
    Buffer.from(value, 'utf8').toString('utf8') === value;
}
