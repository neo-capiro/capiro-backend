import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { ApplicationMembershipService } from '../../auth/application-membership.service.js';
import type { CoreEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';
import { decideRoutinePolicy, type RoutineMembershipFacts } from './meri-routine-policy.js';
import {
  checkApprovedCancellation,
  issueRoutineCancellationProof,
  routineCancellationWindow,
  routineTargetsSha256,
} from './meri-routine-cancellation-proof.js';

/** Server-owned cancellation signer (in-process or KMS Ed25519); null until the deployment packet supplies one. */
export const MERI_ROUTINE_CANCEL_SIGNER = Symbol('MERI_ROUTINE_CANCEL_SIGNER');
const MEMBERSHIP_READ_MS = 10_000;
const forbidden = () => new ForbiddenException('Routine authority refused');

/**
 * DRAFT item 5 owner (dot #121 6246642210). Both operations are attended:
 * the native session plus the verified service identity, and the current
 * application membership (identity rechecked, client wall, role floor) as the
 * proof of the routine owner's current rights. Neither grants unattended
 * firing; routine approvals are stored DB-fenced (`unattended_enabled=false`).
 */
@Injectable()
export class MeriRoutinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: ApplicationMembershipService,
    @Inject(MERI_ROUTINE_CANCEL_SIGNER) private readonly signer: CoreEd25519Signer | null,
  ) {}

  /** Wire A: answers Meri `runtime-context.mjs` policy() exactly. */
  async policyCheck(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const membership = await this.currentMembership(req, ctx);
    return decideRoutinePolicy({ body: raw, principal: { tenantId: ctx.tenantId, actorId: ctx.userId }, membership, nowMs: Date.now() });
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
