import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import {
  parseApprovalDecisionInput,
  parseApprovalRecordInput,
  parseApprovalRevokeInput,
  sameJson,
  type NativeApprovalDecision,
  type NativeApprovalReceipt,
  type NativeScope,
} from './native-approval.contract.js';
import { NativeApprovalMetadataVerifier } from './native-approval-metadata.js';
import { lockMeriExecutionProposal } from '../execution-capability/meri-execution-authority.js';

/** Clock allowance for a proposal created by Meri slightly ahead of Core. */
const CREATED_AT_SKEW_MS = 5_000;

interface DecisionRow {
  tenantId: string;
  proposalId: string;
  commandSha256: string;
  decision: string;
  decidedAt: Date;
  expiresAt: Date;
  approverUserId: string;
  policyRevision: string;
  bindingActorUserId: string;
  conversationId: string;
  runId: string;
}

const forbidden = () => new ForbiddenException('Native approval refused');

/**
 * P-INT-10 approval owner (Meri `apps/control/intents/native-approvals.mjs`,
 * `approval.mjs`, lane-3 "Core dependencies" 1-2). Requests arrive with the
 * approver's native session bearer and a verified service identity. Decisions
 * are immutable, keyed on (tenant, proposalId): a repeat answers the stored
 * decision and never records a second or flipped one.
 */
@Injectable()
export class NativeApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metadata: NativeApprovalMetadataVerifier,
  ) {}

  async record(req: Request, ctx: TenantContext, raw: unknown): Promise<NativeApprovalReceipt> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const input = parseApprovalRecordInput(raw);
    const { proposal } = input;
    const binding = proposal.command.binding;
    // The approver is the authenticated Core user, is the proposal's required
    // approver, and owns the conversation (Meri refuses independent approvers).
    if (input.approver.tenantId !== ctx.tenantId || input.approver.actorId !== ctx.userId) throw forbidden();
    if (!sameJson(input.approver, proposal.requiredApprover)) throw forbidden();
    if (binding.tenantId !== ctx.tenantId || binding.actorId !== ctx.userId) throw forbidden();
    if (!sameJson(input.binding, binding)) throw new ConflictException('Approval binding differs from the proposal');
    if (proposal.command.action !== 'task.create') throw new ConflictException('Approval action is not supported');
    const now = Date.now();
    const createdAtMs = Date.parse(proposal.createdAt);
    const expiresAtMs = Date.parse(proposal.expiresAt);
    if (expiresAtMs <= now) throw new ConflictException('Approval proposal expired');
    if (createdAtMs > now + CREATED_AT_SKEW_MS) throw new ConflictException('Approval proposal is not yet valid');
    const policyRevision = singlePolicyRevision(proposal.command.scopes, binding.tenantId);
    await this.metadata.verify(proposal);

    const create: DecisionRow = {
      tenantId: ctx.tenantId,
      proposalId: proposal.proposalId,
      commandSha256: proposal.commandSha256,
      decision: input.decision,
      // Meri requires proposal.createdAt <= decidedAt <= its own now.
      decidedAt: new Date(Math.max(now, createdAtMs)),
      expiresAt: new Date(expiresAtMs),
      approverUserId: ctx.userId,
      policyRevision,
      bindingActorUserId: binding.actorId,
      conversationId: binding.conversationId,
      runId: binding.runId,
    };
    const stored = await this.storeOnce(create);
    if (stored.commandSha256 !== proposal.commandSha256) throw new ConflictException('Approval proposal already decided for another command');
    return receipt(stored, await this.revoked(stored.tenantId, stored.proposalId));
  }

  async decision(req: Request, ctx: TenantContext, raw: unknown): Promise<NativeApprovalReceipt> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const input = parseApprovalDecisionInput(raw);
    if (input.binding.tenantId !== ctx.tenantId || input.binding.actorId !== ctx.userId) throw forbidden();
    const [row, revoked] = await this.prisma.withTenant(ctx.tenantId, async (tx) => [
      await tx.clioMeriApprovalDecision.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: input.proposalId } },
      }) as DecisionRow | null,
      (await tx.clioMeriApprovalRevocation.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: input.proposalId } },
      })) !== null,
    ] as const);
    // Callers pass different bindings (original, fresh executor attempt, current
    // run), so only tenant/actor/conversation/run are compared. Anything else is
    // answered as "no decision" without disclosing another run's state.
    if (
      !row || row.commandSha256 !== input.commandSha256 ||
      row.bindingActorUserId !== input.binding.actorId ||
      row.conversationId !== input.binding.conversationId || row.runId !== input.binding.runId
    ) {
      return { decision: null, checkedAtMs: Date.now(), revoked: false };
    }
    return receipt(row, revoked);
  }

  /**
   * Revocation of an approval by its approver (dot #121 6247742665 item 1).
   * The decision row stays immutable; an append-only revocation fact is
   * written once under the proposal's execution lock, so it serializes with
   * capability issuance and the `create_task` receiver: an effect either
   * committed before the revocation or is refused after it. Idempotent: a
   * repeat answers the same revoked receipt. Meri forwards the decision's
   * proposal/hash/binding with its approver identity; that identity must be
   * the authenticated actor. `approval/decision` retains its own body shape.
   */
  async revoke(req: Request, ctx: TenantContext, raw: unknown): Promise<NativeApprovalReceipt> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const input = parseApprovalRevokeInput(raw);
    if (input.approver.tenantId !== ctx.tenantId || input.approver.actorId !== ctx.userId ||
        input.binding.tenantId !== ctx.tenantId || input.binding.actorId !== ctx.userId) throw forbidden();
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await lockMeriExecutionProposal(tx, ctx.tenantId, input.proposalId);
      const decision = await tx.clioMeriApprovalDecision.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: input.proposalId } },
      }) as DecisionRow | null;
      if (!decision || decision.commandSha256 !== input.commandSha256 || decision.approverUserId !== ctx.userId ||
          decision.bindingActorUserId !== input.binding.actorId || decision.conversationId !== input.binding.conversationId ||
          decision.runId !== input.binding.runId) throw new ConflictException('Approval decision not found');
      await tx.clioMeriApprovalRevocation.createMany({
        data: [{ tenantId: ctx.tenantId, proposalId: input.proposalId, commandSha256: input.commandSha256,
          revokedByUserId: ctx.userId, reason: 'approver_revoked' }],
        skipDuplicates: true,
      });
      return decision;
    });
    return receipt(row, true);
  }

  private async revoked(tenantId: string, proposalId: string): Promise<boolean> {
    return (await this.prisma.withTenant(tenantId, (tx) => tx.clioMeriApprovalRevocation.findUnique({
      where: { tenantId_proposalId: { tenantId, proposalId } },
    }))) !== null;
  }

  private async storeOnce(create: DecisionRow): Promise<DecisionRow> {
    const find = () => this.prisma.withTenant(create.tenantId, (tx) => tx.clioMeriApprovalDecision.findUnique({
      where: { tenantId_proposalId: { tenantId: create.tenantId, proposalId: create.proposalId } },
    })) as Promise<DecisionRow | null>;
    const existing = await find();
    if (existing) return existing;
    try {
      return await this.prisma.withTenant(create.tenantId, (tx) => tx.clioMeriApprovalDecision.create({ data: create })) as DecisionRow;
    } catch (error) {
      // A concurrent first decision won the primary key; answer that one.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await find();
        if (winner) return winner;
      }
      throw error;
    }
  }
}

/** Every scope belongs to the command's tenant and carries one policy revision:
 * the value Meri's executor guard and lifecycle compare with the run's
 * qualification policy revision. Core has no separate Meri command policy. */
function singlePolicyRevision(scopes: readonly NativeScope[], tenantId: string): string {
  const revisions = new Set(scopes.map((scope) => scope.policyRevision));
  if (revisions.size !== 1 || scopes.some((scope) => scope.tenantId !== tenantId)) {
    throw new ConflictException('Approval scopes must share one tenant and policy revision');
  }
  return [...revisions][0]!;
}

/** The exact `ApprovalDecision` Meri reads back for a stored row (and whose
 * RFC 8785 hash an execution capability binds). */
export function nativeDecisionOf(row: Pick<DecisionRow, 'proposalId' | 'commandSha256' | 'decision' | 'decidedAt' |
  'expiresAt' | 'tenantId' | 'approverUserId' | 'policyRevision'>): NativeApprovalDecision {
  return {
    proposalId: row.proposalId,
    commandSha256: row.commandSha256,
    decision: row.decision as 'approved' | 'rejected',
    decidedAt: row.decidedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    approver: { tenantId: row.tenantId, actorId: row.approverUserId },
    policyRevision: row.policyRevision,
  };
}

function receipt(row: DecisionRow, revoked: boolean): NativeApprovalReceipt {
  return { decision: nativeDecisionOf(row), checkedAtMs: Date.now(), revoked };
}
