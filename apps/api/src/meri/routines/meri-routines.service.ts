import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { ApplicationMembershipService } from '../../auth/application-membership.service.js';
import type { CoreEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { nativeCanonicalSha256, type NativeScope } from '../native-approvals/native-approval.contract.js';
import { meriExecutionClientsVisible, meriExecutionDbNow } from '../execution-capability/meri-execution-authority.js';
import { decideRoutinePolicy, readRoutinePolicyLimits, type RoutineLimits, type RoutineMembershipFacts } from './meri-routine-policy.js';
import { parseSelectionRequest } from './meri-routines.contract.js';
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

  /** Wire A: answers Meri `runtime-context.mjs` policy() exactly; records consent at an approved Execute's `before_claim`. */
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
    const event = routineConsentEvent({ selection: parseSelectionRequest(raw).selection, principal, scopes: receipt.scopes, limits, nowMs });
    if (event) await this.recordConsentEvent(ctx, event, nowMs);
    return receipt;
  }

  /**
   * The owner's signed-in consent (≤ 30 days; a new signed-in approval renews
   * it as a new row) or an attended pause/delete revocation. Idempotent: a
   * repeated `before_claim` for the same approval keeps the first row.
   */
  private async recordConsentEvent(ctx: TenantContext, event: NonNullable<ReturnType<typeof routineConsentEvent>>, nowMs: number) {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await lockRoutineSchedule(tx, ctx.tenantId, event.kind === 'consent' ? event.consent.scheduleId : event.scheduleId);
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
  private async currentMembership(req: Request, ctx: TenantContext): Promise<RoutineMembershipFacts> {
    const deadlineMs = Date.now() + MEMBERSHIP_READ_MS;
    const receipt = await this.membership.read(req, ctx, {
      deadlineMs,
      assertActive() { if (Date.now() >= deadlineMs) throw new ServiceUnavailableException('Current membership unavailable'); },
    });
    return { tenantId: receipt.tenantId, actorId: receipt.actorId, clientIds: receipt.clientIds, expiresAtMs: receipt.expiresAtMs };
  }
}

/** Serializes consent recording, revocation and grant issuance for one schedule. */
async function lockRoutineSchedule(tx: Prisma.TransactionClient, tenantId: string, scheduleId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(
    hashtextextended('capiro-meri-routine:' || ${tenantId}::text || ':' || ${scheduleId}::text, 0::bigint))::text AS locked`;
}
