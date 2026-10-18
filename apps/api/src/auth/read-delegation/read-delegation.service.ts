import { randomUUID } from 'node:crypto';
import {
  ConflictException, ForbiddenException, GoneException, HttpException, HttpStatus, Inject, Injectable, Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { ContextSecurityScopeService } from '../../context/context-security-scope.service.js';
import { assertCurrentClientVisible, loadOwnedActiveClioConversation } from '../../context/application-authority-resource.helpers.js';
import { BizDevMeriScopeService } from '../../business-development/bizdev-meri-scope.service.js';
import { authorizeMeriProspectScope } from '../../business-development/bizdev-meri-scope.authorization.js';
import type { CoreEd25519Signer } from '../core-ed25519-signer.js';
import { hasVerifiedToolServiceIdentity } from '../tool-service-secret.guard.js';
import { readApplicationAuthorityContext } from '../application-authority.js';
import type { ApplicationMembershipControl } from '../application-membership.js';
import { ApplicationMembershipService } from '../application-membership.service.js';
import {
  MERI_DELEGATED_READ_TOOLS, READ_DELEGATION_LIMITS, READ_TOKEN_CEILINGS, delegationIdempotencyKey, operationsDigest, parseConsentCreate, parseConsentState,
  parseCurrentBody, parseDelegationCreate, parseRevoke, parseTokenRequest, type DelegationCreateRequest, type ReadTokenKind,
} from './read-delegation.contract.js';
import {
  ACTIVE_RUN_STATES, assertDelegationFacts, assertToolReservation, occurrenceBindsRun, readOccurrence, readRunFacts, readSchedule,
  singleClientScope, type RunFacts,
} from './read-delegation-facts.js';
import {
  assertConsentCurrent, assertDelegatedClientVisible, assertDelegatedTarget, assertMeriReadDelegationReleasable, delegationRowOf,
  lockDelegation, readDelegatedIdentity, readDelegatedMember,
} from './read-delegation-request.js';
import { canonicalSha256 } from './read-delegation.contract.js';
import { READ_TOKEN_MAX_SECONDS, signReadToken } from './read-delegation-token.js';

type Tx = Prisma.TransactionClient;
export const MERI_READ_DELEGATION_SIGNER = Symbol('MERI_READ_DELEGATION_SIGNER');

const denied = () => new ForbiddenException('Read delegation refused');
const changed = () => new ConflictException('Read delegation changed');
const expired = () => new GoneException('Read delegation expired');
const exhausted = () => new HttpException('Read delegation slot or ceiling exhausted', HttpStatus.TOO_MANY_REQUESTS);
const MINUTE = 60_000;
const COUNTER: Record<ReadTokenKind, 'tool_tokens' | 'mode_tokens' | 'reference_tokens' | 'current_tokens'> = {
  tool: 'tool_tokens', mode: 'mode_tokens', reference: 'reference_tokens', current: 'current_tokens',
};
const at = (ms: number) => new Date(ms);
const lockKey = (tx: Tx, key: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

/**
 * Run-bound read delegation, Core owner (RC1 option B, D016-A item 4; contract
 * FABLE-RUN-BOUND-READ-DELEGATION-20261018 rev 3). Neo's bounds: attended at
 * most 30 minutes total from issuance (never past the run), renewed only by a
 * new delegation from a live login; unattended at most 15 minutes per
 * occurrence under an active signed-in consent of at most 30 days; pause or
 * revoke ends authority; never a write. Every route requires the VERIFIED
 * service identity (a guard pass in observe mode is not enough). Times are the
 * database clock. Allowance is never stored: it is read live from Meri's view.
 */
@Injectable()
export class ReadDelegationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextMiddleware,
    private readonly membership: ApplicationMembershipService,
    private readonly securityScope: ContextSecurityScopeService,
    private readonly bizdevScope: BizDevMeriScopeService,
    @Optional() @Inject(MERI_READ_DELEGATION_SIGNER) private readonly signer: CoreEd25519Signer | null = null,
  ) {}

  private service(req: Request): void {
    if (!hasVerifiedToolServiceIdentity(req)) throw denied();
    if (!this.signer) throw new ServiceUnavailableException('Read delegation is not enabled');
  }

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.withSystem(fn, { timeoutMs: 5000 }).catch((error: unknown) => {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Read delegation unavailable');
    });
  }

  /** §4 at issuance: admitted, active, exact binding, one client scope, allocation, operations, budget pins. */
  private issuanceFacts(facts: RunFacts, r: DelegationCreateRequest): void {
    if (!facts.admitted || facts.admittedUntilMs === null || !ACTIVE_RUN_STATES.includes(facts.runState)) throw changed();
    if (facts.conversationId !== r.binding.conversationId || canonicalSha256(facts.runBinding) !== canonicalSha256(r.binding) ||
        !singleClientScope(facts.runScopes, r.clientId, r.policyRevision) || facts.allocationSha256 !== r.allocationSha256 ||
        operationsDigest(facts.allowedOperations) !== r.operationsDigest) throw denied();
    if (facts.dbNowMs >= facts.admittedUntilMs) throw expired();
  }

  private async member(tx: Tx, tenantId: string, userId: string) {
    const membership = await tx.tenantMembership.findFirst({ where: { tenantId, userId, status: 'active' }, select: { id: true } });
    if (!membership) throw denied();
    return readDelegatedMember(tx, { tenantId, userId, membershipId: membership.id });
  }

  private receipt(row: Record<string, unknown>, dbNowMs: number) {
    return { schemaVersion: 1 as const, delegationId: row.id as string, expiresAtMs: (row.expires_at as Date).getTime(), checkedAtMs: dbNowMs };
  }

  /** Create or renew. Attended: the live session (sid path) the caller authenticated with, never the marked control token. */
  async createAttended(req: Request, ctx: TenantContext, raw: unknown) {
    this.service(req);
    const r = parseDelegationCreate(raw);
    if (r.mode !== 'attended' || r.binding.tenantId !== ctx.tenantId || r.binding.actorId !== ctx.userId) throw denied();
    // A fresh online sid read of the authenticated session (contract §10).
    await this.tenant.readApplicationAuthority(req, ctx);
    return this.create(r);
  }

  /** Unattended: service identity plus an active consent and a DISPATCHED occurrence of this run. */
  async createUnattended(req: Request, raw: unknown) {
    this.service(req);
    const r = parseDelegationCreate(raw);
    if (r.mode !== 'unattended') throw denied();
    return this.create(r);
  }

  private create(r: DelegationCreateRequest) {
    const key = delegationIdempotencyKey(r);
    return this.tx(async (tx) => {
      await lockKey(tx, `meri-read-delegation:${key}`);
      const facts = await readRunFacts(tx, r.binding.tenantId, r.binding.runId);
      const now = facts.dbNowMs;
      const existing = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM meri_read_delegations WHERE idempotency_key = ${key} AND state = 'active' FOR UPDATE`;
      const live = existing[0] && (existing[0].expires_at as Date).getTime() > now ? existing[0] : null;
      if (live && r.supersedes === null) {
        // Idempotent repeat: the same row, after the same current checks.
        assertDelegationFacts(facts, delegationRowOf(live));
        return this.receipt(live, now);
      }
      if (r.mode === 'unattended') {
        const prior = await tx.$queryRaw<Record<string, unknown>[]>`
          SELECT * FROM meri_read_delegations WHERE tenant_id = ${r.binding.tenantId}::uuid AND occurrence_key = ${r.occurrenceKey}`;
        if (prior.length) throw changed(); // never renewed: one delegation per occurrence
      }
      this.issuanceFacts(facts, r);
      const { user, membership } = await this.member(tx, r.binding.tenantId, r.binding.actorId);
      await assertDelegatedClientVisible(tx, r.binding.tenantId, user.clerkUserId, r.clientId);
      let expiresAtMs = Math.min(now + READ_DELEGATION_LIMITS.attendedMaxMs, facts.admittedUntilMs!);
      let supersedes: string | null = null;
      if (r.mode === 'attended' && r.supersedes !== null) {
        const old = await lockDelegation(tx, r.binding.tenantId, r.supersedes, 'update');
        if (!old || old.mode !== 'attended' || old.userId !== r.binding.actorId || old.runId !== r.binding.runId ||
            old.clientId !== r.clientId || old.conversationId !== r.binding.conversationId) throw denied();
        if (old.state === 'superseded') {
          // A lost response to this same renewal: return its successor.
          const next = await tx.$queryRaw<Record<string, unknown>[]>`
            SELECT * FROM meri_read_delegations WHERE supersedes = ${old.id}::uuid AND state = 'active' AND idempotency_key = ${key}`;
          if (next.length === 1 && (next[0]!.expires_at as Date).getTime() > now) return this.receipt(next[0]!, now);
          throw changed();
        }
        if ((old.state !== 'active' && old.state !== 'expired') || (existing[0] && existing[0].id !== old.id)) throw changed();
        await tx.$executeRaw`UPDATE meri_read_delegations SET state = 'superseded' WHERE id = ${old.id}::uuid`;
        supersedes = old.id;
      } else if (r.supersedes !== null) {
        throw denied(); // unattended delegations are never renewed
      } else if (existing[0]) {
        // The idempotent row exists but has expired: a fresh create (live login, or a new occurrence) replaces it.
        await tx.$executeRaw`UPDATE meri_read_delegations SET state = 'expired' WHERE id = ${existing[0].id as string}::uuid`;
      }
      if (r.mode === 'unattended') {
        const consent = await tx.$queryRaw<Record<string, unknown>[]>`
          SELECT *, expires_at > clock_timestamp() AS live FROM meri_read_delegation_consents
           WHERE id = ${r.consentId}::uuid AND tenant_id = ${r.binding.tenantId}::uuid FOR SHARE`;
        const c = consent[0];
        if (!c || c.state !== 'active' || c.live !== true) throw changed();
        if (c.user_id !== r.binding.actorId || c.client_id !== r.clientId || c.schedule_id !== r.scheduleId ||
            c.operations_digest !== r.operationsDigest || c.policy_revision !== r.policyRevision) throw denied();
        const schedule = await readSchedule(tx, r.binding.tenantId, r.scheduleId!);
        if (!schedule || schedule.ownerActorId !== r.binding.actorId || schedule.projectionSha256 !== c.schedule_projection_sha256) throw denied();
        const occurrence = await readOccurrence(tx, r.binding.tenantId, r.occurrenceKey!);
        if (!occurrence || occurrence.state !== 'DISPATCHED' || occurrence.scheduleId !== r.scheduleId ||
            !occurrenceBindsRun(occurrence.runBinding, r.binding)) throw denied();
        expiresAtMs = Math.min(now + READ_DELEGATION_LIMITS.occurrenceMaxMs, occurrence.createdAtMs + READ_DELEGATION_LIMITS.occurrenceMaxMs,
          (c.expires_at as Date).getTime(), facts.admittedUntilMs!);
      }
      if (expiresAtMs <= now + 1000) throw expired();
      const id = randomUUID();
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        INSERT INTO meri_read_delegations (id, idempotency_key, mode, tenant_id, user_id, membership_id, client_id, conversation_id, run_id,
          attempt_id, writer_fence, budget_attempt, budget_fence, budget_policy_revision, allocation_sha256, operations_digest, policy_revision,
          consent_id, occurrence_key, state, supersedes, issued_at, expires_at)
        VALUES (${id}::uuid, ${key}, ${r.mode}, ${r.binding.tenantId}::uuid, ${r.binding.actorId}::uuid, ${membership.id}::uuid,
          ${r.clientId}::uuid, ${r.binding.conversationId}::uuid, ${r.binding.runId}::uuid, ${r.binding.attemptId}::uuid, ${r.binding.writerFence},
          ${facts.attempt}, ${facts.fence}, ${facts.policyRevision}, ${r.allocationSha256}, ${r.operationsDigest}, ${r.policyRevision},
          ${r.consentId}::uuid, ${r.occurrenceKey}, 'active', ${supersedes}::uuid, ${at(now)}, ${at(expiresAtMs)})
        RETURNING id, expires_at`;
      return this.receipt(rows[0]!, now);
    });
  }

  /**
   * Token issue (contract §7), atomic: the delegation `FOR UPDATE`, the view,
   * the slot upsert with its ceilings, the lost-response supersession and the
   * token row; any failure rolls the whole transaction back. Core keeps only
   * the token's hash.
   */
  async issueToken(req: Request, delegationId: string, raw: unknown) {
    this.service(req);
    const t = parseTokenRequest(raw, delegationId);
    return this.tx(async (tx) => {
      const found = await tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM meri_read_delegations WHERE id = ${delegationId}::uuid FOR UPDATE`;
      if (found.length !== 1) throw denied();
      const d = delegationRowOf(found[0]!);
      await lockKey(tx, `meri-read-run:${d.runId}`);
      const facts = await readRunFacts(tx, d.tenantId, d.runId);
      const hard = Math.min(assertDelegationFacts(facts, d, t.operation ? { operation: t.operation } : {}), await assertConsentCurrent(tx, d));
      const { user } = await readDelegatedMember(tx, d);
      await assertDelegatedClientVisible(tx, d.tenantId, user.clerkUserId, d.clientId);
      if (t.kind === 'tool') {
        if (!MERI_DELEGATED_READ_TOOLS.has(t.operation!.id)) throw denied();
        await assertToolReservation(tx, d.runId, t.callKey, t.operation!, t.argumentsSha256!);
      }

      await tx.$executeRaw`
        INSERT INTO meri_read_delegation_slots (run_id, call_key, tenant_id, delegation_id)
        VALUES (${d.runId}::uuid, ${t.callKey}, ${d.tenantId}::uuid, ${d.id}::uuid) ON CONFLICT (run_id, call_key) DO NOTHING`;
      const slots = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT tenant_id::text AS tenant_id, tool_tokens, mode_tokens, reference_tokens, current_tokens, reissues,
               NOT EXISTS (SELECT 1 FROM meri_read_tokens k WHERE k.run_id = s.run_id AND k.call_key = s.call_key) AS fresh
          FROM meri_read_delegation_slots s WHERE run_id = ${d.runId}::uuid AND call_key = ${t.callKey} FOR UPDATE`;
      const slot = slots[0];
      if (!slot || slot.tenant_id !== d.tenantId) throw denied();
      if (slot.fresh === true) {
        // Open a slot only while open, unreserved slots stay below the live allowance (§5).
        const open = await tx.$queryRaw<{ n: string }[]>`
          SELECT count(*)::text AS n FROM meri_read_delegation_slots s
           WHERE s.run_id = ${d.runId}::uuid AND s.call_key <> ${t.callKey} AND s.tool_tokens = 0
             AND NOT EXISTS (SELECT 1 FROM meri_read_delegation_facts.reservations_v1 r WHERE r.invocation_id = s.call_key)
             AND EXISTS (SELECT 1 FROM meri_read_tokens k WHERE k.run_id = s.run_id AND k.call_key = s.call_key AND k.expires_at > clock_timestamp())`;
        if (Number(open[0]!.n) >= facts.maxToolCalls - facts.reservedCalls) throw exhausted();
      }

      let reissue = false;
      if (t.retryOf !== null) {
        if (t.retryOf !== t.requestDigest) throw denied();
        // Every token of this request: a consumed one is never re-issued; the
        // single live, unsuperseded one is the lost response to supersede.
        const prior = await tx.$queryRaw<{ jti: string; consumed: boolean; live: boolean; superseded: boolean }[]>`
          SELECT jti::text AS jti, consumed_at IS NOT NULL AS consumed, superseded_at IS NOT NULL AS superseded,
                 expires_at > clock_timestamp() AS live
            FROM meri_read_tokens WHERE run_id = ${d.runId}::uuid AND call_key = ${t.callKey} AND kind = ${t.kind}
             AND request_digest = ${t.requestDigest} LIMIT 16 FOR UPDATE`;
        if (prior.some((row) => row.consumed)) throw changed();
        const p = prior.find((row) => !row.superseded && row.live);
        if (p) {
          const used = await tx.$queryRaw<{ n: string }[]>`
            SELECT count(*)::text AS n FROM meri_read_tokens
             WHERE run_id = ${d.runId}::uuid AND call_key = ${t.callKey} AND kind = ${t.kind} AND superseded_at IS NOT NULL`;
          if (Number(used[0]!.n) >= READ_DELEGATION_LIMITS.maxReissuesPerKind) throw exhausted();
          await tx.$executeRaw`UPDATE meri_read_tokens SET superseded_at = clock_timestamp() WHERE jti = ${p.jti}::uuid`;
          await tx.$executeRaw`UPDATE meri_read_delegation_slots SET reissues = reissues + 1 WHERE run_id = ${d.runId}::uuid AND call_key = ${t.callKey}`;
          reissue = true;
        }
      }
      if (!reissue) {
        const column = COUNTER[t.kind];
        if (Number(slot[column]) >= READ_TOKEN_CEILINGS[t.kind]) throw exhausted();
        const bumped = await tx.$executeRawUnsafe(
          `UPDATE meri_read_delegation_slots SET ${column} = ${column} + 1 WHERE run_id = $1::uuid AND call_key = $2 AND ${column} < $3`,
          d.runId, t.callKey, READ_TOKEN_CEILINGS[t.kind]);
        if (bumped !== 1) throw exhausted();
      }

      const iat = Math.floor(facts.dbNowMs / 1000);
      const exp = Math.min(iat + READ_TOKEN_MAX_SECONDS, Math.floor(hard / 1000));
      if (exp <= iat + 1) throw expired();
      const signal = AbortSignal.timeout(3000);
      const signed = await signReadToken(this.signer!, {
        sub: d.id, iat, nbf: iat, exp, kind: t.kind, callKey: t.callKey, method: 'POST', path: t.path, bodySha256: t.bodySha256,
        operation: t.operation, toolRequestSha256: t.toolRequestSha256, referenceSha256: t.referenceSha256,
        tenantId: d.tenantId, actorId: d.userId, clientId: d.clientId, conversationId: d.conversationId, runId: d.runId,
      }, signal);
      await tx.$executeRaw`
        INSERT INTO meri_read_tokens (jti, token_sha256, tenant_id, delegation_id, run_id, call_key, kind, target_method, target_path,
          body_sha256, arguments_sha256, request_digest, issued_at, expires_at)
        VALUES (${signed.jti}::uuid, ${signed.tokenSha256}, ${d.tenantId}::uuid, ${d.id}::uuid, ${d.runId}::uuid, ${t.callKey}, ${t.kind}, 'POST',
          ${t.path}, ${t.bodySha256}, ${t.argumentsSha256}, ${t.requestDigest}, ${at(iat * 1000)}, ${at(exp * 1000)})`;
      return { schemaVersion: 1 as const, token: signed.token, expiresAtMs: exp * 1000 };
    });
  }

  /** Idempotent terminal revocation; tokens of a revoked delegation never admit (middleware checks state). */
  async revoke(req: Request, delegationId: string, raw: unknown) {
    this.service(req);
    const reason = parseRevoke(raw);
    return this.tx(async (tx) => {
      const found = await tx.$queryRaw<{ id: string; state: string }[]>`
        SELECT id::text AS id, state FROM meri_read_delegations WHERE id = ${delegationId}::uuid FOR UPDATE`;
      if (found.length !== 1) throw denied();
      if (found[0]!.state === 'active') {
        await tx.$executeRaw`UPDATE meri_read_delegations SET state = 'revoked', revoked_reason = ${reason} WHERE id = ${delegationId}::uuid`;
        return { schemaVersion: 1 as const, delegationId, state: 'revoked' };
      }
      return { schemaVersion: 1 as const, delegationId, state: found[0]!.state };
    });
  }

  /** Attended consent (live login). A new consent supersedes the schedule's active one. */
  async createConsent(req: Request, ctx: TenantContext, raw: unknown) {
    this.service(req);
    const r = parseConsentCreate(raw);
    await this.tenant.readApplicationAuthority(req, ctx);
    return this.tx(async (tx) => {
      await lockKey(tx, `meri-read-consent:${ctx.tenantId}:${r.scheduleId}`);
      const clock = await tx.$queryRaw<{ now_ms: string }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms`;
      const now = Number(clock[0]!.now_ms);
      if (r.requestedExpiresAtMs <= now + MINUTE) throw denied();
      const schedule = await readSchedule(tx, ctx.tenantId, r.scheduleId);
      if (!schedule || schedule.ownerActorId !== ctx.userId || schedule.projectionSha256 !== r.scheduleProjectionSha256) throw denied();
      const { user } = await this.member(tx, ctx.tenantId, ctx.userId);
      await assertDelegatedClientVisible(tx, ctx.tenantId, user.clerkUserId, r.clientId);
      const prior = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM meri_read_delegation_consents
         WHERE tenant_id = ${ctx.tenantId}::uuid AND schedule_id = ${r.scheduleId}::uuid AND state = 'active' FOR UPDATE`;
      if (prior[0]) await tx.$executeRaw`UPDATE meri_read_delegation_consents SET state = 'superseded' WHERE id = ${prior[0].id}::uuid`;
      const expiresAtMs = Math.min(r.requestedExpiresAtMs, now + READ_DELEGATION_LIMITS.consentMaxMs);
      const id = randomUUID();
      await tx.$executeRaw`
        INSERT INTO meri_read_delegation_consents (id, tenant_id, user_id, client_id, schedule_id, schedule_projection_sha256,
          operations_digest, policy_revision, state, supersedes, created_at, expires_at)
        VALUES (${id}::uuid, ${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${r.clientId}::uuid, ${r.scheduleId}::uuid, ${r.scheduleProjectionSha256},
          ${r.operationsDigest}, ${r.policyRevision}, 'active', ${prior[0]?.id ?? null}::uuid, ${at(now)}, ${at(expiresAtMs)})`;
      return { schemaVersion: 1 as const, consentId: id, state: 'active' as const, createdAtMs: now, expiresAtMs };
    });
  }

  /**
   * Pause or revoke (service identity alone) ends authority at once: every
   * active occurrence delegation under the consent is revoked in the same
   * transaction. Resume (`active`) widens authority, so it requires the
   * owner's live login and the unchanged schedule projection.
   */
  async setConsentState(req: Request, ctx: TenantContext | undefined, consentId: string, raw: unknown) {
    this.service(req);
    const state = parseConsentState(raw);
    if (state === 'active') {
      if (!ctx) throw denied();
      await this.tenant.readApplicationAuthority(req, ctx);
    }
    return this.tx(async (tx) => {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT *, expires_at > clock_timestamp() AS live FROM meri_read_delegation_consents WHERE id = ${consentId}::uuid FOR UPDATE`;
      const c = rows[0];
      if (!c) throw denied();
      const out = (s: string) => ({ schemaVersion: 1 as const, consentId, state: s, createdAtMs: (c.created_at as Date).getTime(),
        expiresAtMs: (c.expires_at as Date).getTime() });
      if (state === 'active') {
        if (c.tenant_id !== ctx!.tenantId || c.user_id !== ctx!.userId) throw denied();
        if (c.state === 'active') return out('active');
        if (c.state !== 'paused' || c.live !== true) throw changed();
        const schedule = await readSchedule(tx, c.tenant_id as string, c.schedule_id as string);
        if (!schedule || schedule.ownerActorId !== c.user_id || schedule.projectionSha256 !== c.schedule_projection_sha256) throw changed();
        await tx.$executeRaw`UPDATE meri_read_delegation_consents SET state = 'active' WHERE id = ${consentId}::uuid`;
        return out('active');
      }
      if (c.state === 'active' || (c.state === 'paused' && state === 'revoked')) {
        await tx.$executeRaw`UPDATE meri_read_delegation_consents SET state = ${state} WHERE id = ${consentId}::uuid`;
      } else if (c.state !== state) {
        return out(c.state as string);
      }
      await tx.$executeRaw`
        UPDATE meri_read_delegations SET state = 'revoked', revoked_reason = ${`consent_${state}`}
         WHERE consent_id = ${consentId}::uuid AND state = 'active'`;
      return out(state);
    });
  }

  /**
   * The delegation-backed current-authority receipt (contract §3): the
   * membership owner's three-snapshot read with delegated identity evidence;
   * `clientIds` is the delegated client only, while it stays visible; the BD
   * `conversation` block comes from the existing `/context` owners on the
   * delegation's own conversation and client. Checked again before release.
   */
  async current(req: Request, ctx: TenantContext, delegationId: string, raw: unknown, control: ApplicationMembershipControl) {
    const grant = assertDelegatedTarget(req, 'current');
    if (grant.delegationId !== delegationId || !hasVerifiedToolServiceIdentity(req)) throw denied();
    const { conversation } = parseCurrentBody(raw);
    const identity = () => readDelegatedIdentity(this.prisma, req, ctx);
    const initial = await identity();
    control.assertActive();
    const member = await this.membership.readDelegated(req, ctx, control);
    control.assertActive();
    if (member.tenantId !== ctx.tenantId || member.actorId !== ctx.userId || !member.clientIds.includes(grant.clientId)) throw denied();
    await this.securityScope.resolveApplicationAuthorityClient(ctx.tenantId, ctx.userId, grant.clientId);
    let context: Awaited<ReturnType<typeof readApplicationAuthorityContext>> | null = null;
    if (conversation) {
      try {
        context = await readApplicationAuthorityContext(
          { identitySha256: '0'.repeat(64), conversationId: grant.conversationId, clientId: grant.clientId },
          {
            identity,
            conversation: (id) => loadOwnedActiveClioConversation(this.prisma, ctx, id),
            conversationScope: async (row) => {
              const prospect = await authorizeMeriProspectScope(this.bizdevScope, ctx, (row as { metadata?: unknown }).metadata);
              if (prospect && prospect.linkedClientId !== grant.clientId) throw denied();
              return prospect ? [prospect.prospectId, prospect.canonicalOrganizationId, prospect.linkedClientId, prospect.scopeVersion] : null;
            },
            clientVisible: (id) => assertCurrentClientVisible(this.prisma, ctx, id),
            clientAuthority: (id) => this.securityScope.resolveApplicationAuthorityClient(ctx.tenantId, ctx.userId, id),
          },
        );
      } catch {
        throw denied();
      }
      control.assertActive();
    }
    const final = await initial.recheckCurrent();
    control.assertActive();
    if (final.identityRevision !== initial.identityRevision || (context && context.identityRevision !== initial.identityRevision)) throw changed();
    await assertMeriReadDelegationReleasable(this.prisma, req);
    control.assertActive();
    const expiresAtMs = Math.min(initial.expiresAtMs, final.expiresAtMs, member.expiresAtMs, grant.hardExpiryMs, context?.expiresAtMs ?? Infinity);
    if (expiresAtMs <= Date.now()) throw expired();
    return {
      schemaVersion: 1 as const, delegationId: grant.delegationId,
      principal: { tenantId: ctx.tenantId, actorId: ctx.userId }, identityRevision: final.identityRevision,
      actorRole: member.role, membershipRevision: member.membershipRevision, clientIds: [grant.clientId],
      ...(context ? { conversation: { conversationId: context.conversationId, selectedClientId: context.selectedClientId,
        contextRevision: context.contextRevision } } : {}),
      checkedAtMs: Math.min(member.checkedAtMs, Date.now()), expiresAtMs,
    };
  }
}
