import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  ConflictException, ForbiddenException, GoneException, HttpException, ServiceUnavailableException,
  UnauthorizedException, UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { json, type Request, type RequestHandler } from 'express';
import { ROLE_RANK, TENANT_HEADER, type TenantContext, type TenantRole } from '@capiro/shared';
import { readCoreEd25519KeyConfig } from '../core-ed25519-key-config.js';
import { applicationAuthorityRevision, type ApplicationAuthorityIdentityEvidence, type ApplicationAuthorityIdentityProof } from '../application-authority.js';
import { fetchAccessibleClientRevisionsForClerkActor } from '../../memory/memory-wall.helpers.js';
import {
  READ_DELEGATION_LIMITS, READ_DELEGATION_ROUTES, READ_TOKEN_SCHEME, canonicalSha256, delegationPath, isSha, sha256Hex, toolPath,
  type OperationRef, type ReadTokenKind,
} from './read-delegation.contract.js';
import { assertDelegationFacts, assertToolReservation, readRunFacts, type DelegationFacts } from './read-delegation-facts.js';
import { readTokenFromAuthorization, readTokenSha256, verifyReadToken, type ReadTokenClaims } from './read-delegation-token.js';
import type { DocumentTextOnlyAllocation } from './read-delegation-document-pricing.js';
import { isSignedMemoryPageOperation, isSignedMemoryProposalOperation } from './signed-memory-http-gate.js';

/**
 * Tenant-middleware support for run-bound read delegation (RC1 option B,
 * D016-A item 4). Pure of SDKs and of Meri runtime code: the tenant
 * middleware's authority closure imports this file (VM harness maps list it).
 *
 *  - `isMeriReadTokenRequest`: any request whose Authorization scheme is
 *    `CapiroMeriRead`. The middleware sends every such request to
 *    `admitMeriReadToken`, which admits it ONLY on the token's own target;
 *    a read token never falls through to Clerk verification or to another route.
 *  - `isMeriReadDelegationServicePost`: the exact bearer-less service-identity
 *    POSTs (unattended create, tokens, revocations, consent narrowing).
 */
type Tx = Prisma.TransactionClient;
interface SystemPrisma { withSystem<T>(fn: (tx: Tx) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> }

const BASE = '/clio/application-authority';
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SERVICE_POSTS = [
  new RegExp(`^${BASE}/read-delegations$`),
  new RegExp(`^${BASE}/read-delegations/${UUID_PART}/(?:tokens|revocations)$`),
  new RegExp(`^${BASE}/read-delegation-consents/${UUID_PART}/state$`),
];

/** Parsed target equal to the original, no query, normalized without `/api`. */
function exactPath(req: Request): string | null {
  const parsed = req.path;
  const original = req.originalUrl ?? req.url ?? '';
  if (typeof parsed !== 'string' || original.includes('?') || original.includes('#') || parsed !== original) return null;
  return parsed.startsWith('/api/') ? parsed.slice(4) : parsed;
}

export function isMeriReadDelegationServicePost(req: Request): boolean {
  if (req.method !== 'POST' || req.headers.authorization !== undefined) return false;
  const path = exactPath(req);
  return path !== null && SERVICE_POSTS.some((pattern) => pattern.test(path));
}

export function isMeriReadTokenRequest(req: Request): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.slice(0, READ_TOKEN_SCHEME.length + 1).toLowerCase() === `${READ_TOKEN_SCHEME.toLowerCase()} `;
}

/** Verified service identity, the same constant-time comparison the guard uses.
 * Unset `INTERNAL_SERVICE_SECRET` refuses in every environment (contract §6). */
export function meriReadServiceIdentityMatches(req: Request, env: NodeJS.ProcessEnv): boolean {
  const expected = env.INTERNAL_SERVICE_SECRET;
  const provided = req.headers['x-internal-service-secret'];
  if (typeof expected !== 'string' || expected.length === 0 || typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Raw entity bytes. The `CapiroMeriRead` body hash covers the exact bytes Meri
// sent (`JSON.stringify(body)`), so Core hashes the entity, never a re-encoding.
// ---------------------------------------------------------------------------
const rawBodies = new WeakMap<Request, Buffer>();
const JSON_UTF8 = /^[ \t]*application\/json[ \t]*(?:;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|utf8|"utf-8"|"utf8")[ \t]*)?$/i;

/** Installed before the default JSON parser (configure-api-http-app). Only
 * `CapiroMeriRead` requests are captured; they are parsed with a 16 KiB limit,
 * no inflation and UTF-8 JSON only. Everything else passes untouched. */
export function meriReadDelegationRawBody(): RequestHandler {
  const parse = json({
    limit: READ_DELEGATION_LIMITS.maxBodyBytes, inflate: false, strict: true, type: () => true,
    verify(request, _response, entity) { rawBodies.set(request as Request, Buffer.from(entity)); },
  });
  return (request, response, next) => {
    if (!isMeriReadTokenRequest(request)) { next(); return; }
    try {
      const type = request.headers['content-type'];
      const encoding = request.headers['content-encoding'];
      if (typeof type !== 'string' || !JSON_UTF8.test(type)) throw new UnsupportedMediaTypeException('Read delegation bodies must be UTF-8 JSON');
      if (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity') throw new UnsupportedMediaTypeException('Encoded bodies are unsupported');
      parse(request, response, next);
    } catch (error) { next(error); }
  };
}
export const meriReadDelegationRawBodyOf = (req: Request): Buffer | undefined => rawBodies.get(req);

// ---------------------------------------------------------------------------
// Admission (the middleware branch) and the request-local grant.
// ---------------------------------------------------------------------------
export interface MeriReadDelegationGrant {
  delegationId: string;
  mode: 'attended' | 'unattended';
  tenantId: string;
  actorId: string;
  clientId: string;
  conversationId: string;
  runId: string;
  /** Core-verified Meri run binding, read from the locked delegation row. */
  binding: { tenantId: string; actorId: string; conversationId: string; runId: string; attemptId: string; writerFence: number };
  /** Exact seven-field original ADMITTED binding under the snapshot lock. */
  admittedBinding: { tenantId: string; actorId: string; conversationId: string; runId: string; attemptId: string; workerId: string; writerFence: number };
  /** Document tariff from the original locked allocation; not a token claim. */
  documentTextOnlyAllocation?: DocumentTextOnlyAllocation | null;
  policyRevision: string;
  /** Digest of a separately authenticated retained-source correlation header. */
  correlationSha256: string | null;
  /** Tool reservation argument hash read from the consumed token row. */
  argumentsSha256: string | null;
  /** Exact emitted HTTP body bytes, checked against the signed token and
   * consumed row before this request-local grant is created. */
  bodySha256?: string;
  callKey: string;
  kind: ReadTokenKind;
  operation: OperationRef | null;
  toolRequestSha256: string | null;
  referenceSha256: string | null;
  jti: string;
  hardExpiryMs: number;
}
const grants = new WeakMap<Request, MeriReadDelegationGrant>();
export const meriReadDelegationOf = (req: Request): MeriReadDelegationGrant | undefined => grants.get(req);
const retainedCorrelations = new WeakMap<Request, unknown>();
export const meriRetainedCorrelationOf = (req: Request): unknown => retainedCorrelations.get(req);

/** The exact canonical JSON header is part of the Core-signed, one-use token.
 * Decode before consuming its JTI so malformed transport cannot burn a slot. */
function readRetainedCorrelation(req: Request, digest: string | undefined): unknown {
  const header = req.headers['x-meri-read-correlation'];
  if (digest === undefined) {
    if (header !== undefined) throw denied();
    return undefined;
  }
  if (typeof header !== 'string' || header.length > 11_000 || !/^[A-Za-z0-9_-]+$/.test(header)) throw denied();
  const bytes = Buffer.from(header, 'base64url');
  if (bytes.length > 8192 || bytes.toString('base64url') !== header) throw denied();
  const json = bytes.toString('utf8');
  if (!Buffer.from(json, 'utf8').equals(bytes)) throw denied();
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw denied(); }
  try { if (canonicalizeCoreRetainedJson(value) !== json) throw denied(); } catch { throw denied(); }
  if (sha256Hex(bytes) !== digest) throw denied();
  return value;
}

const denied = () => new ForbiddenException('Read delegation refused');
const changed = () => new ConflictException('Read delegation changed');
const credential = () => new UnauthorizedException('Read delegation credential refused');

/** The kind's target path, from the token's own claims (contract §3). */
function targetOf(claims: ReadTokenClaims): string | null {
  switch (claims.kind) {
    case 'current': return claims.operation === null ? delegationPath(claims.sub, 'current') : null;
    case 'tool': return claims.operation ? toolPath(claims.operation.id) : null;
    case 'mode': return claims.operation ? READ_DELEGATION_ROUTES.mode : null;
    case 'reference': return claims.operation === null ? READ_DELEGATION_ROUTES.reference : null;
    default: return null;
  }
}

interface DelegationRow extends DelegationFacts {
  revision: number;
  supersedes: string | null;
  consentId: string | null;
  membershipId: string;
}

export async function lockDelegation(tx: Tx, tenantId: string, delegationId: string, lock: 'share' | 'update'): Promise<DelegationRow | null> {
  const rows = lock === 'update'
    ? await tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM meri_read_delegations WHERE id = ${delegationId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`
    : await tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM meri_read_delegations WHERE id = ${delegationId}::uuid AND tenant_id = ${tenantId}::uuid FOR SHARE`;
  if (rows.length !== 1) return null;
  return delegationRowOf(rows[0]!);
}

export function delegationRowOf(r: Record<string, unknown>): DelegationRow {
  const at = (v: unknown) => (v instanceof Date ? v : new Date(Number.NaN));
  return {
    id: r.id as string, mode: r.mode as string, tenantId: r.tenant_id as string, userId: r.user_id as string, actorId: r.user_id as string,
    membershipId: r.membership_id as string, clientId: r.client_id as string, conversationId: r.conversation_id as string, runId: r.run_id as string,
    attemptId: r.attempt_id as string, writerFence: Number(r.writer_fence), budgetAttempt: Number(r.budget_attempt), budgetFence: Number(r.budget_fence),
    budgetPolicyRev: String(r.budget_policy_revision), allocationSha256: String(r.allocation_sha256), operationsDigest: String(r.operations_digest),
    policyRevision: String(r.policy_revision), state: r.state as string, expiresAt: at(r.expires_at), revision: Number(r.revision),
    supersedes: (r.supersedes as string | null) ?? null, consentId: (r.consent_id as string | null) ?? null,
  };
}

/** An unattended delegation lives only while its consent is active and unexpired (pause or revoke ends authority). */
export async function assertConsentCurrent(tx: Tx, d: DelegationRow): Promise<number> {
  if (d.mode !== 'unattended') return Number.MAX_SAFE_INTEGER;
  const rows = await tx.$queryRaw<{ state: string; expires_ms: string; live: boolean }[]>`
    SELECT state, floor(extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_ms, expires_at > clock_timestamp() AS live
      FROM meri_read_delegation_consents WHERE id = ${d.consentId}::uuid AND tenant_id = ${d.tenantId}::uuid FOR SHARE`;
  if (rows.length !== 1 || rows[0]!.state !== 'active' || rows[0]!.live !== true) throw changed();
  return Number(rows[0]!.expires_ms);
}

/** The local actor, membership and tenant: read only, never provisioned, rebound or written. */
export async function readDelegatedMember(tx: Tx, d: Pick<DelegationRow, 'tenantId' | 'userId' | 'membershipId'>) {
  const user = await tx.user.findUnique({ where: { id: d.userId }, select: { id: true, clerkUserId: true } });
  const membership = await tx.tenantMembership.findFirst({
    where: { id: d.membershipId, tenantId: d.tenantId, userId: d.userId, status: 'active' }, include: { tenant: true },
  });
  if (!user || !user.clerkUserId || !membership || membership.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, membership.role) ||
      ROLE_RANK[membership.role as TenantRole] < ROLE_RANK.standard_user) throw denied();
  return { user: { id: user.id, clerkUserId: user.clerkUserId }, membership };
}

/** The delegated client is still visible to the actor (the membership snapshot's own owner). */
export async function assertDelegatedClientVisible(tx: Tx, tenantId: string, clerkUserId: string, clientId: string): Promise<void> {
  const rows = await fetchAccessibleClientRevisionsForClerkActor(tx, tenantId, clerkUserId, 4097);
  if (rows.length > 4096) throw new ServiceUnavailableException('Read delegation facts unavailable');
  if (!rows.some((row) => row.id === clientId)) throw denied();
}

/**
 * The `CapiroMeriRead` branch: signature, kid, audience and time; POST on the
 * token's exact target with an empty query; the exact entity bytes' hash;
 * verified service identity; no impersonation or tenant-selection header.
 * Then, in ONE transaction: the delegation `FOR SHARE`, the atomic `jti`
 * consumption, every §4 run fact, the consent (unattended), the tool
 * reservation (`tool`), the member and the client's visibility. The returned
 * context comes from the delegation: nothing is provisioned, rebound or
 * written besides the token's `consumed_at`.
 */
export async function admitMeriReadToken(req: Request, deps: { prisma: SystemPrisma; env: NodeJS.ProcessEnv; nowMs: number }): Promise<TenantContext> {
  let config: ReturnType<typeof readCoreEd25519KeyConfig>;
  try { config = readCoreEd25519KeyConfig(deps.env, 'MERI_READ_DELEGATION_SIGNER'); } catch { config = null; }
  if (!config) throw new ServiceUnavailableException('Read delegation is not enabled');
  if (!meriReadServiceIdentityMatches(req, deps.env)) throw denied();
  const token = readTokenFromAuthorization(req.headers.authorization);
  const claims = token ? verifyReadToken(token, config, deps.nowMs) : null;
  if (!token || !claims) throw credential();
  const retainedCorrelation = readRetainedCorrelation(req, claims.correlationSha256);
  if (req.header('x-capiro-impersonate-tenant') !== undefined || req.header(TENANT_HEADER) !== undefined) throw denied();
  const path = exactPath(req);
  const target = targetOf(claims);
  if (req.method !== 'POST' || path === null || target === null || claims.path !== target || `/api${path}` !== target) throw denied();
  const raw = rawBodies.get(req);
  if (!raw || raw.length > READ_DELEGATION_LIMITS.maxBodyBytes || sha256Hex(raw) !== claims.bodySha256) throw denied();

  const admitted = await (async () => {
    try {
      return await deps.prisma.withSystem(async (tx) => {
        const d = await lockDelegation(tx, claims.tenantId, claims.sub, 'share');
        if (!d) throw credential();
        if (d.userId !== claims.actorId || d.clientId !== claims.clientId || d.conversationId !== claims.conversationId || d.runId !== claims.runId) throw denied();
        const used = await tx.$queryRaw<{ kind: string; target_path: string; body_sha256: string; call_key: string; arguments_sha256: string | null }[]>`
          UPDATE meri_read_tokens SET consumed_at = clock_timestamp()
           WHERE jti = ${claims.jti}::uuid AND token_sha256 = ${readTokenSha256(token)} AND delegation_id = ${d.id}::uuid
             AND tenant_id = ${d.tenantId}::uuid AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > clock_timestamp()
          RETURNING kind, target_path, body_sha256::text AS body_sha256, call_key, arguments_sha256::text AS arguments_sha256`;
        if (used.length !== 1) throw credential();
        const u = used[0]!;
        if (u.kind !== claims.kind || u.target_path !== claims.path || u.body_sha256 !== claims.bodySha256 || u.call_key !== claims.callKey) throw denied();
        const facts = await readRunFacts(tx, d.tenantId, d.runId);
        let hardExpiryMs = assertDelegationFacts(facts, d, claims.operation ? { operation: claims.operation } : {});
        hardExpiryMs = Math.min(hardExpiryMs, await assertConsentCurrent(tx, d), claims.exp * 1000);
        if (claims.kind === 'tool') {
          if (!claims.operation || !u.arguments_sha256) throw denied();
          await assertToolReservation(tx, d.runId, claims.callKey, claims.operation, u.arguments_sha256);
        }
        const member = await readDelegatedMember(tx, d);
        await assertDelegatedClientVisible(tx, d.tenantId, member.user.clerkUserId, d.clientId);
        if (!facts.admittedBinding) throw denied();
        return { d, member, hardExpiryMs, argumentsSha256: u.arguments_sha256, admittedBinding: facts.admittedBinding,
          documentTextOnlyAllocation: facts.documentTextOnlyAllocation ?? null };
      }, { timeoutMs: 5000 });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Read delegation unavailable');
    }
  })();
  const ctx: TenantContext = {
    tenantId: admitted.d.tenantId, tenantSlug: admitted.member.membership.tenant.slug, userId: admitted.member.user.id,
    clerkUserId: admitted.member.user.clerkUserId, role: admitted.member.membership.role as TenantRole,
  };
  grants.set(req, Object.freeze({
    delegationId: admitted.d.id, mode: admitted.d.mode as 'attended' | 'unattended', tenantId: ctx.tenantId, actorId: ctx.userId,
    clientId: admitted.d.clientId, conversationId: admitted.d.conversationId, runId: admitted.d.runId, callKey: claims.callKey,
    binding: Object.freeze({ tenantId: admitted.d.tenantId, actorId: admitted.d.actorId,
      conversationId: admitted.d.conversationId, runId: admitted.d.runId, attemptId: admitted.d.attemptId,
      writerFence: admitted.d.writerFence }), policyRevision: admitted.d.policyRevision,
    admittedBinding: Object.freeze({ ...admitted.admittedBinding }),
    ...(claims.operation?.id === 'read_client_documents'
      ? { documentTextOnlyAllocation: admitted.documentTextOnlyAllocation } : {}),
    correlationSha256: claims.correlationSha256 ?? null, argumentsSha256: admitted.argumentsSha256,
    bodySha256: claims.bodySha256,
    kind: claims.kind, operation: claims.operation ? Object.freeze({ ...claims.operation }) : null, toolRequestSha256: claims.toolRequestSha256,
    referenceSha256: claims.referenceSha256, jti: claims.jti, hardExpiryMs: admitted.hardExpiryMs,
  }));
  if (retainedCorrelation !== undefined) retainedCorrelations.set(req, retainedCorrelation);
  return ctx;
}

/**
 * Before any byte of a delegated result is written (contract §7): the
 * delegation is active and unexpired, every run fact still holds, the consent
 * is current (unattended), the member is active and the client is visible.
 * Any change refuses (409/410) and the result is withheld.
 */
/** The memory page and proposal alias depend on the same original UNKNOWN
 * reservation at release. Keep this in the current facts transaction, not a
 * body-supplied receipt or a second unlocked check. Other read operations keep
 * their existing release behavior. */
export async function assertSignedMemoryReservationAtRelease(
  tx: Tx,
  grant: Pick<MeriReadDelegationGrant, 'kind' | 'operation' | 'runId' | 'callKey' | 'argumentsSha256'>,
): Promise<void> {
  if (!isSignedMemoryPageOperation(grant.operation) && !isSignedMemoryProposalOperation(grant.operation)) return;
  if (grant.kind !== 'tool' || !isSha(grant.argumentsSha256)) throw changed();
  await assertToolReservation(tx, grant.runId, grant.callKey, grant.operation!, grant.argumentsSha256);
}

export async function assertMeriReadDelegationReleasable(prisma: SystemPrisma, req: Request): Promise<void> {
  const grant = grants.get(req);
  if (!grant) return;
  try {
    await prisma.withSystem(async (tx) => {
      const d = await lockDelegation(tx, grant.tenantId, grant.delegationId, 'share');
      if (!d) throw changed();
      const facts = await readRunFacts(tx, d.tenantId, d.runId);
      if (grant.operation?.id === 'read_client_documents' &&
          canonicalSha256(facts.documentTextOnlyAllocation ?? null) !== canonicalSha256(grant.documentTextOnlyAllocation ?? null))
        throw changed();
      const hard = Math.min(assertDelegationFacts(facts, d, grant.operation ? { operation: grant.operation } : {}), await assertConsentCurrent(tx, d));
      if (facts.dbNowMs >= Math.min(hard, grant.hardExpiryMs)) throw new GoneException('Read delegation expired');
      await assertSignedMemoryReservationAtRelease(tx, grant);
      const member = await readDelegatedMember(tx, d);
      if (member.user.id !== grant.actorId) throw changed();
      await assertDelegatedClientVisible(tx, d.tenantId, member.user.clerkUserId, d.clientId);
    }, { timeoutMs: 5000 });
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('Read delegation unavailable');
  }
}

/**
 * `DelegatedIdentitySource` (contract §3): the identity evidence for
 * `ApplicationMembershipService.readDelegated`, read in one transaction from
 * the user row, the delegation row and Meri's run facts. `identityRevision`
 * covers the user, membership, tenant, delegation (id and revision) and the
 * consent; it omits `users.updated_at`, which `lastSeenAt` writes move on every
 * ordinary request (there is no user status column).
 */
export async function readDelegatedIdentity(prisma: SystemPrisma, req: Request, ctx: TenantContext): Promise<ApplicationAuthorityIdentityProof> {
  const grant = grants.get(req);
  if (!grant || grant.tenantId !== ctx.tenantId || grant.actorId !== ctx.userId) throw denied();
  const read = async (): Promise<ApplicationAuthorityIdentityEvidence> => {
    try {
      return await prisma.withSystem(async (tx) => {
        const d = await lockDelegation(tx, grant.tenantId, grant.delegationId, 'share');
        if (!d) throw changed();
        const facts = await readRunFacts(tx, d.tenantId, d.runId);
        const consentExpiry = await assertConsentCurrent(tx, d);
        const hard = Math.min(assertDelegationFacts(facts, d), consentExpiry, grant.hardExpiryMs);
        const { user, membership } = await readDelegatedMember(tx, d);
        if (user.id !== ctx.userId || user.clerkUserId !== ctx.clerkUserId || membership.role !== ctx.role ||
            membership.tenant.slug !== ctx.tenantSlug) throw changed();
        if (facts.dbNowMs >= hard) throw new GoneException('Read delegation expired');
        return {
          principal: { tenantId: ctx.tenantId, actorId: user.id },
          identityRevision: applicationAuthorityRevision('identity', [
            ['capiro-meri-read-delegation-v1'],
            [user.id, user.clerkUserId],
            [membership.id, membership.tenantId, membership.userId, membership.role, membership.status, membership.updatedAt.getTime()],
            [membership.tenant.id, membership.tenant.status, membership.tenant.clerkOrgId],
            [d.id, d.revision, d.mode, d.supersedes, d.consentId, d.expiresAt.getTime()],
          ]),
          expiresAtMs: hard,
        };
      }, { timeoutMs: 5000 });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Read delegation unavailable');
    }
  };
  const evidence = await read();
  return { ...evidence, recheckCurrent: read };
}

/** Request body checks the delegated targets share. */
export function assertDelegatedTarget(req: Request, kind: ReadTokenKind): MeriReadDelegationGrant {
  const grant = grants.get(req);
  if (!grant || grant.kind !== kind) throw denied();
  return grant;
}
