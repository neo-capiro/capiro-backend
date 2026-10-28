import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { hasInternalServiceIdentity } from '../../auth/internal-service.guard.js';
import type { RetainedReadDispatcher } from '../retained-read-dispatch.js';
import { parseRetainedReadContext, assertRetainedReadSelectors, readRetainedReadDeadline } from '../retained-read-context.js';
import { withMeriToolRequestControl, withMeriToolExecutionControl, meriToolRequestControl, assertMeriToolRequestActive } from '../meri-tool-request-control.js';
import { readRoutineSubject, routineReadRequest, type RoutineReadSelection } from './meri-routine-read-authority.js';
import { parseRoutineConsentObservationRequest, readRoutineConsentObservation, type RoutineConsentObservation } from './meri-routine-consent-observation.js';
import {
  assertRoutineConsentRenewal,
  parseRoutineConsentRenewalRequest,
  readRoutineConsentDecision,
  readRoutineConsentRenewalWindow,
  type RoutineConsentRenewalPins,
} from './meri-routine-consent-renewal.js';
import { isUuid } from '../../auth/read-delegation/read-delegation.contract.js';
import { ApplicationMembershipService } from '../../auth/application-membership.service.js';
import type { CoreEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { nativeCanonicalSha256, type NativeScope } from '../native-approvals/native-approval.contract.js';
import { meriExecutionClientsVisible, meriExecutionDbNow } from '../execution-capability/meri-execution-authority.js';
import { decideRoutinePolicy, readRoutinePolicyLimits, type RoutineLimits } from './meri-routine-policy.js';
import { parseSelectionRequest, parseRoutineManagementScope, parseRoutineManagementSelection } from './meri-routines.contract.js';
import { routineManagementCurrent, decideRoutineManagementPolicy, type RoutineManagementMembership } from './meri-routine-management.js';
import {
  ROUTINE_CONSENT_MAX_SECONDS,
  issueRoutineFiringGrant,
  parseRoutineFireRequest,
  routineConsentEvent,
  routineFireWindow,
  type RoutineFireClaims,
} from './meri-routine-firing.js';
import {
  checkApprovedCancellation,
  issueRoutineCancellationProof,
  routineCancellationWindow,
  routineTargetsSha256,
} from './meri-routine-cancellation-proof.js';

/** Server-owned cancellation signer (in-process or KMS Ed25519); null until the deployment packet supplies one. */
export const MERI_ROUTINE_CANCEL_SIGNER = Symbol('MERI_ROUTINE_CANCEL_SIGNER');
/** Wire C firing-grant signer: its own key and kid (Meri pins the two purposes apart). */
export const MERI_ROUTINE_FIRE_SIGNER = Symbol('MERI_ROUTINE_FIRE_SIGNER');
const MEMBERSHIP_READ_MS = 10_000;
const forbidden = () => new ForbiddenException('Routine authority refused');

/**
 * Item 5 owner (dot #121 6246642210; D016-A item 5). Wires A and B are
 * attended: the native session plus the verified service identity, and the
 * current application membership (identity rechecked, client wall, role
 * floor) as the proof of the routine owner's current rights. Wire A at an
 * approved Execute's `before_claim` also records the owner's signed-in consent
 * (or an attended pause/delete's revocation). Wire C is unattended: the
 * service identity alone, answered from that consent and the owner's current
 * membership and client wall read in the database (meri-routine-firing.ts).
 */
@Injectable()
export class MeriRoutinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: ApplicationMembershipService,
    @Inject(MERI_ROUTINE_CANCEL_SIGNER) private readonly signer: CoreEd25519Signer | null,
    @Optional() @Inject(MERI_ROUTINE_FIRE_SIGNER) private readonly fireSigner: CoreEd25519Signer | null = null,
  ) {}

  /** Native routines use the existing saved consent, never a delegated bearer. */
  async current(raw: unknown, req: Request) {
    if (!hasInternalServiceIdentity(req)) throw forbidden();
    const { lineageSha256: _lineage, ...current } = await this.readSubject(routineReadRequest(raw, false), 'current');
    return current;
  }

  private readSubject(selection: RoutineReadSelection, purpose: 'current' | 'read' = 'read') {
    return this.prisma.withTenant(selection.tenantId, tx => readRoutineSubject(tx, selection, purpose));
  }

  /**
   * MR-04 visibility: a read-only observation of the owner's saved read consent
   * for the current authorized generation (meri-routine-consent-observation.ts).
   * It writes no consent, revocation, approval or grant and changes no refusals;
   * a database or transport failure propagates, so the caller reports an unknown
   * rather than a fabricated absence.
   */
  async consentObservation(raw: unknown, req: Request): Promise<RoutineConsentObservation> {
    if (!hasInternalServiceIdentity(req)) throw forbidden();
    const request = parseRoutineConsentObservationRequest(raw);
    return this.prisma.withTenant(request.tenantId, tx => readRoutineConsentObservation(tx, request));
  }

  async read(raw: unknown, req: Request, reads: RetainedReadDispatcher): Promise<unknown> {
    if (!hasInternalServiceIdentity(req)) throw forbidden();
    const value = routineReadRequest(raw, true), subject = await this.readSubject(value);
    const ctx: TenantContext = { tenantId: subject.tenantId, tenantSlug: subject.tenantSlug, userId: subject.actorId,
      clerkUserId: subject.clerkUserId, role: subject.role };
    const context = parseRetainedReadContext(ctx, value.context, true);
    // Control adds mailbox selectors from the current actor's Core inventory.
    // They are not durable routine grants: the typed Mail owner still requires
    // current tenant + mailbox ownership for every selected ID and returned row.
    const mail = ['mail.list_messages', 'mail.search_messages', 'mail.read_thread'].includes(String(value.operation));
    if (!isDeepStrictEqual(context.binding, subject.binding) || context.policyRevision !== subject.policyRevision ||
        context.subject.scopes.some(scope => !subject.scopes.some(saved => isDeepStrictEqual(scope, saved)) &&
          !(mail && scope.kind === 'mailbox' && isUuid(scope.resourceId)))) throw forbidden();
    assertRetainedReadSelectors(value.input, context);
    const deadlineMs = Math.min(readRetainedReadDeadline(req), subject.effectExpiresAtMs);
    return withMeriToolRequestControl(req, () => withMeriToolExecutionControl(
      { signal: meriToolRequestControl()?.signal, deadlineAt: deadlineMs }, async () => {
        const result = await reads.execute(ctx, value.operation as string, value.input, context, deadlineMs, req);
        if (value.operation === 'job.resolveClientReference') {
          const reference = result as { ok?: unknown; clientId?: unknown } | null;
          if (reference?.ok === true && (typeof reference.clientId !== 'string' || !subject.clientIds.includes(reference.clientId))) throw forbidden();
        }
        const fresh = await this.readSubject(value);
        // Mutable run progress is checked by the authority reader, while the
        // consent, identity, scopes and original deadline must remain stable.
        if (!isDeepStrictEqual({ ...fresh, checkedAtMs: 0 }, { ...subject, checkedAtMs: 0 })) throw forbidden();
        assertMeriToolRequestActive();
        return result;
      }));
  }

  /** Current signed-in management scope, independent of conversation/model admission. */
  async managementCurrent(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    parseRoutineManagementScope(raw);
    const membership = await this.currentMembership(req, ctx);
    return routineManagementCurrent({ body: raw, principal: { tenantId: ctx.tenantId, actorId: ctx.userId }, membership, nowMs: Date.now() });
  }

  async managementPolicyCheck(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    // Reject execution operations before reading membership, model configuration or recording an event.
    const selected = parseRoutineManagementSelection(parseSelectionRequest(raw).selection);
    const membership = await this.currentMembership(req, ctx), principal = { tenantId: ctx.tenantId, actorId: ctx.userId }, nowMs = Date.now();
    const receipt = decideRoutineManagementPolicy({ body: raw, principal, membership, nowMs });
    // Policy just reauthorized the original complete projection scope set. The
    // session's single selected-client anchor never becomes execution authority.
    const eventInput = { selection: parseSelectionRequest(raw).selection, principal, scopes: selected.proposal?.scopes ?? receipt.current.scopes, limits: null };
    const event = routineConsentEvent({ ...eventInput, nowMs });
    if (event) await this.recordConsentEvent(ctx, event, eventInput, receipt.expiresAtMs);
    return receipt;
  }

  /** Execution policy keeps its existing configured maxima and run-bound wire. */
  async policyCheck(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    let limits: RoutineLimits | null;
    try {
      limits = readRoutinePolicyLimits(process.env);
    } catch {
      throw new ServiceUnavailableException('Routine limits are misconfigured');
    }
    const membership = await this.currentMembership(req, ctx);
    const principal = { tenantId: ctx.tenantId, actorId: ctx.userId };
    const nowMs = Date.now();
    const receipt = decideRoutinePolicy({ body: raw, principal, membership, nowMs, limits });
    const eventInput = { selection: parseSelectionRequest(raw).selection, principal, scopes: receipt.scopes, limits };
    const event = routineConsentEvent({ ...eventInput, nowMs });
    if (event) await this.recordConsentEvent(ctx, event, eventInput, receipt.expiresAtMs);
    return receipt;
  }

  /**
   * MR-04 renewal (W5-02 MR-04): a NEW explicit attended approval of the routine's
   * CURRENT unchanged approved intent re-issues the owner's saved consent. The
   * caller (the trusted control service, under the verified service identity and
   * the current signed-in tenant context) supplies the immutable intent bytes it
   * holds in custody plus the fresh approval; nothing is reconstructed from
   * digests. The intent, approval, projection digests, complete scope set and
   * limits are decided by `routineConsentEvent`, and the write goes through the
   * SAME `writeConsentEvent` the attended `before_claim` uses (same schedule
   * lock, database clock, 30-day window and unique-decision idempotency), so an
   * exact replay keeps the first row and extends nothing. Before any mutation the
   * stored canonical consent must still pin exactly this intent, generation,
   * projection, policy revision, complete scope set and limits, must not be
   * revoked, and the owner must still hold an active membership and every
   * original client scope. It signs no firing grant, issues no first consent,
   * resumes no paused/deleted routine and widens nothing.
   */
  async consentRenew(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const renewal = parseRoutineConsentRenewalRequest(raw);
    let limits: RoutineLimits | null;
    try {
      limits = readRoutinePolicyLimits(process.env);
    } catch {
      throw new ServiceUnavailableException('Routine limits are misconfigured');
    }
    // The current configured maxima stay the ceiling: a renewal cannot raise them.
    if (!limits) throw new ServiceUnavailableException('Routine limits are not configured');
    const membership = await this.currentMembership(req, ctx);
    const principal = { tenantId: ctx.tenantId, actorId: ctx.userId };
    if (membership.tenantId !== principal.tenantId || membership.actorId !== principal.actorId) throw forbidden();
    // The scopes are the intent projection's own raw array, not an already-parsed
    // copy: `routineConsentEvent` (the canonical owner) parses them and refuses
    // unless they match the intent exactly, and the stored consent is the second
    // anchor. Nothing here trusts the caller's reading of them.
    const eventInput = { selection: renewal.selection, principal, scopes: renewal.projectionScopes as unknown as readonly NativeScope[], limits };
    const event = routineConsentEvent({ ...eventInput, nowMs: Date.now() });
    // A paused/deleted projection is a revocation, never a renewal.
    if (!event || event.kind !== 'consent') throw forbidden();
    const c = event.consent;
    // The owner's validated reading of the caller's own bytes must agree with what
    // this request read closed from them, and the routine must be the same one.
    if (c.scheduleId !== renewal.scheduleId || c.intentId !== renewal.intentId || c.generation !== renewal.generation ||
        c.intentSha256 !== renewal.intentSha256 || c.projectionSha256 !== renewal.projectionSha256) throw forbidden();
    const pins: RoutineConsentRenewalPins = {
      tenantId: principal.tenantId, ownerActorId: principal.actorId, scheduleId: c.scheduleId, intentId: c.intentId,
      generation: c.generation, intentSha256: c.intentSha256, projectionSha256: c.projectionSha256,
      policyRevision: c.policyRevision, scopes: c.scopes, limits: c.limits,
    };
    const [facts, window, idempotent] = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const stored = await assertRoutineConsentRenewal(tx, pins);
      const replay = await readRoutineConsentDecision(tx, ctx.tenantId, c.intentId, c.decisionSha256);
      await this.writeConsentEvent(tx, ctx, event, eventInput, renewal.approvalExpiresAtMs);
      return [stored, await readRoutineConsentRenewalWindow(tx, pins, c.decisionSha256), replay] as const;
    });
    // The window that this exact approval now holds is read back from the stored
    // row: an exact replay keeps the first row's timestamps, so repeating an
    // approval never extends the consent.
    return {
      schemaVersion: 1 as const, state: window.expiresAtMs > facts.observedAtMs ? 'active' as const : 'expired' as const,
      generation: c.generation, policyRevision: c.policyRevision, issuedAtMs: window.issuedAtMs, expiresAtMs: window.expiresAtMs,
      observedAtMs: facts.observedAtMs, idempotent,
    };
  }

  /**
   * The owner's signed-in consent (≤ 30 days; a new signed-in approval renews
   * it as a new row) or an attended pause/delete revocation. Idempotent: a
   * repeated `before_claim` for the same approval keeps the first row.
   */
  private async recordConsentEvent(
    ctx: TenantContext,
    event: NonNullable<ReturnType<typeof routineConsentEvent>>,
    eventInput: Omit<Parameters<typeof routineConsentEvent>[0], 'nowMs'>,
    receiptExpiresAtMs: number,
  ) {
    await this.prisma.withTenant(ctx.tenantId, (tx) => this.writeConsentEvent(tx, ctx, event, eventInput, receiptExpiresAtMs));
  }

  /**
   * The transaction-local canonical consent/revocation writer, shared by the
   * attended `before_claim` path and the renewal. The renewal calls it inside
   * its own transaction, after the same schedule lock is already held, so the
   * pinned-consent check and the write are one atomic unit (an advisory
   * transaction lock is re-entrant, so this never nests a lock or deadlocks).
   */
  private async writeConsentEvent(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    event: NonNullable<ReturnType<typeof routineConsentEvent>>,
    eventInput: Omit<Parameters<typeof routineConsentEvent>[0], 'nowMs'>,
    receiptExpiresAtMs: number,
  ) {
    await lockRoutineSchedule(tx, ctx.tenantId, event.kind === 'consent' ? event.consent.scheduleId : event.scheduleId);
    // The grant path reads consent and revocation under this same schedule lock
    // using the database clock. Recheck the attended approval at that instant,
    // then order and expire its durable event on the same clock.
    const nowMs = await meriExecutionDbNow(tx);
    if (nowMs >= receiptExpiresAtMs) throw forbidden();
    const currentEvent = routineConsentEvent({ ...eventInput, nowMs });
    if (!currentEvent || nativeCanonicalSha256(currentEvent) !== nativeCanonicalSha256(event)) throw forbidden();
    if (event.kind === 'revoke') {
      await tx.clioMeriRoutineConsentRevocation.createMany({
        data: [{ tenantId: ctx.tenantId, intentId: event.intentId, scheduleId: event.scheduleId, revokedByUserId: ctx.userId,
          reason: event.reason, revokedAt: new Date(nowMs) }],
        skipDuplicates: true,
      });
      return;
    }
    const c = event.consent;
    await tx.clioMeriRoutineConsent.createMany({
      data: [{
        consentId: randomUUID(), tenantId: ctx.tenantId, ownerUserId: ctx.userId, scheduleId: c.scheduleId, intentId: c.intentId,
        generation: c.generation, intentSha256: c.intentSha256, projectionSha256: c.projectionSha256, decisionSha256: c.decisionSha256,
        scopes: c.scopes as unknown as Prisma.InputJsonArray, limits: { ...c.limits }, policyRevision: c.policyRevision,
        issuedAt: new Date(nowMs), expiresAt: new Date(nowMs + ROUTINE_CONSENT_MAX_SECONDS * 1000),
      }],
      skipDuplicates: true,
    });
  }

  /**
   * Wire C (D016-A item 5): the unattended firing grant for one occurrence and
   * phase, under the verified service identity alone. Answered only from the
   * newest unexpired consent for exactly this owner, schedule, generation,
   * intent and projection. For `before_admission` and `before_start` the
   * consent must not be revoked by a later pause/delete, the owner must still
   * be an active member (at least `standard_user`) of an active tenant, and
   * every client scope must still be visible to the owner. `before_stop` is the
   * safe direction (stopping the occurrence's own run) and needs only the
   * consent window. The ledger row is written before signing.
   */
  async unattendedGrant(req: Request, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const signer = this.fireSigner;
    if (!signer) throw new ServiceUnavailableException('Routine firing grants are not enabled');
    const r = parseRoutineFireRequest(raw);
    const jti = randomUUID();
    const planned = await this.prisma.withTenant(r.tenantId, async (tx) => {
      await lockRoutineSchedule(tx, r.tenantId, r.scheduleId);
      const nowMs = await meriExecutionDbNow(tx);
      const consent = await tx.clioMeriRoutineConsent.findFirst({
        where: {
          tenantId: r.tenantId, ownerUserId: r.ownerActorId, scheduleId: r.scheduleId, generation: r.generation,
          intentSha256: r.intentSha256, projectionSha256: r.projectionSha256, expiresAt: { gt: new Date(nowMs) },
        },
        orderBy: { issuedAt: 'desc' },
      });
      if (!consent) throw forbidden();
      const scopes = consent.scopes as unknown as NativeScope[];
      let membershipRevision: string;
      if (r.phase === 'before_stop') {
        membershipRevision = nativeCanonicalSha256({ purpose: 'routine-stop', consentId: consent.consentId });
      } else {
        const revoked = await tx.clioMeriRoutineConsentRevocation.findFirst({
          where: { tenantId: r.tenantId, scheduleId: r.scheduleId, revokedAt: { gte: consent.issuedAt } },
        });
        if (revoked) throw forbidden();
        const member = await tx.tenantMembership.findFirst({
          where: { tenantId: r.tenantId, userId: r.ownerActorId, status: 'active' }, include: { tenant: true },
        });
        if (!member || member.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, member.role) ||
            ROLE_RANK[member.role as TenantRole] < ROLE_RANK.standard_user) throw forbidden();
        const clients = scopes.filter((s) => s.kind === 'client').map((s) => s.resourceId.toLowerCase());
        if (!(await meriExecutionClientsVisible(tx, r.tenantId, r.ownerActorId, clients))) throw forbidden();
        membershipRevision = nativeCanonicalSha256({ membershipId: member.id, role: member.role, status: member.status,
          tenantStatus: member.tenant.status, clients: [...new Set(clients)].sort() });
      }
      const consentIssuedAtS = Math.floor(consent.issuedAt.getTime() / 1000);
      const consentExpiresAtS = Math.floor(consent.expiresAt.getTime() / 1000);
      const { iat, exp } = routineFireWindow(nowMs, consentExpiresAtS);
      await tx.clioMeriRoutineFireGrant.create({
        data: {
          jti, tenantId: r.tenantId, consentId: consent.consentId, scheduleId: r.scheduleId, generation: r.generation,
          occurrenceKey: r.occurrenceKey, phase: r.phase, signerIssuer: signer.issuer, signerKeyId: signer.kid,
          iatSeconds: BigInt(iat), expSeconds: BigInt(exp),
        },
      });
      const claims: RoutineFireClaims = {
        tenantId: r.tenantId, ownerActorId: r.ownerActorId, scheduleId: r.scheduleId, generation: r.generation,
        intentSha256: r.intentSha256, projectionSha256: r.projectionSha256, occurrenceKey: r.occurrenceKey, phase: r.phase,
        scopes, membershipRevision, consentId: consent.consentId, consentIssuedAtS, consentExpiresAtS,
        limits: consent.limits as unknown as RoutineFireClaims['limits'],
      };
      return { claims, nowMs, exp };
    });
    const issued = await issueRoutineFiringGrant({ claims: planned.claims, jti, nowMs: planned.nowMs }, signer)
      .catch(() => { throw new ServiceUnavailableException('Routine firing grant unavailable'); });
    if (issued.exp !== planned.exp) throw new ServiceUnavailableException('Routine firing grant unavailable');
    return { grant: issued.grant, jti, expiresAtMs: issued.exp * 1000 };
  }

  /**
   * Wire B: records the owner's approval of the exact cancel intent and the
   * proof's jti before signing, so every released proof has a ledger row. A
   * recorded-but-unsigned jti is harmless; a signed-but-unrecorded proof cannot
   * happen.
   */
  async cancellationProof(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const signer = this.signer;
    if (!signer) throw new ServiceUnavailableException('Routine cancellation proofs are not enabled');
    const membership = await this.currentMembership(req, ctx);
    const nowMs = Date.now();
    const approved = checkApprovedCancellation({ body: raw, principal: { tenantId: ctx.tenantId, actorId: ctx.userId }, membership, nowMs });
    const { iat, exp } = routineCancellationWindow(approved, nowMs);
    const jti = randomUUID();
    const { claims } = approved;
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      // The consent row is immutable and keyed by (tenant, intent): an exact
      // replay reuses it, a different intent or decision for the same id conflicts.
      await tx.clioMeriRoutineApproval.createMany({
        data: [{
          tenantId: claims.tenantId, intentId: claims.intentId, ownerUserId: claims.ownerActorId, scheduleId: claims.scheduleId,
          operation: 'cancel_scheduled_task', intentSha256: claims.intentSha256, decisionSha256: claims.decisionSha256,
          policyRevision: approved.policyRevision, decidedAt: new Date(approved.decidedAtMs), decisionExpiresAt: new Date(approved.decisionExpiresAtMs),
        }],
        skipDuplicates: true,
      });
      const stored = await tx.clioMeriRoutineApproval.findUnique({ where: { tenantId_intentId: { tenantId: claims.tenantId, intentId: claims.intentId } } });
      if (!stored || stored.intentSha256 !== claims.intentSha256 || stored.decisionSha256 !== claims.decisionSha256 ||
          stored.ownerUserId !== claims.ownerActorId || stored.unattendedEnabled !== false) {
        throw new ConflictException('Routine intent already recorded with different content');
      }
      await tx.clioMeriRoutineCancelProof.create({
        data: {
          jti, tenantId: claims.tenantId, intentId: claims.intentId, intentSha256: claims.intentSha256,
          targetsSha256: routineTargetsSha256(claims.targets), runsSha256: nativeCanonicalSha256(claims.runs),
          signerIssuer: signer.issuer, signerKeyId: signer.kid, iatSeconds: BigInt(iat), expSeconds: BigInt(exp),
        },
      });
    });
    const issued = await issueRoutineCancellationProof({ approved, jti, nowMs }, signer);
    return { proof: issued.proof, jti, expiresAtMs: issued.exp * 1000 };
  }

  /** The canonical current-membership receipt is the owner's current rights. */
  private async currentMembership(req: Request, ctx: TenantContext): Promise<RoutineManagementMembership> {
    const deadlineMs = Date.now() + MEMBERSHIP_READ_MS;
    const receipt = await this.membership.read(req, ctx, {
      deadlineMs,
      assertActive() { if (Date.now() >= deadlineMs) throw new ServiceUnavailableException('Current membership unavailable'); },
    });
    return { tenantId: receipt.tenantId, actorId: receipt.actorId, clientIds: receipt.clientIds, membershipRevision: receipt.membershipRevision, expiresAtMs: receipt.expiresAtMs };
  }
}

/** Serializes consent recording, revocation and grant issuance for one schedule. */
async function lockRoutineSchedule(tx: Prisma.TransactionClient, tenantId: string, scheduleId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(
    hashtextextended('capiro-meri-routine:' || ${tenantId}::text || ':' || ${scheduleId}::text, 0::bigint))::text AS locked`;
}
