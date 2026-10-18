import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EngagementService } from '../../engagement/engagement.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import type { CoreEd25519KeyConfig } from '../../auth/core-ed25519-key-config.js';
import type { MeriExecutionRequestIdentity } from '../../auth/meri-execution-request.js';
import { UUID, nativeCanonicalSha256, sameJson } from '../native-approvals/native-approval.contract.js';
import { nativeDecisionOf } from '../native-approvals/native-approval.service.js';
import {
  MERI_EXECUTION_KEY_CONFIG,
  lockMeriExecutionProposal,
  meriExecutionClientsVisible,
  meriExecutionTrust,
} from './meri-execution-authority.js';
import { readMeriAdmittedRun } from './meri-admitted-run.reader.js';
import {
  taskCreateArgumentsFromBody,
  verifyMeriExecutionCapability,
  type VerifiedMeriExecution,
} from './meri-execution-capability.js';

/** The one tool a Meri execution capability may run (`task.create`). */
export const MERI_EXECUTION_TOOL = 'create_task';
/** `engagement_tasks.source_type` of an approved execution's task; with
 * `source_id = <proposalId>|<idempotencyKey>` it hits the existing partial
 * UNIQUE (tenant_id, source_type, source_id), a second effect identity. */
export const MERI_EXECUTION_TASK_SOURCE = 'meri_approved_execution';

const forbidden = () => new ForbiddenException('Execution capability refused');
const conflict = (reason: string) => new ConflictException(reason);

/**
 * Core's receiver for Meri's approved `create_task` (D016 #9). The tenant
 * middleware admitted the capability's signature and the actor's active
 * membership; this receiver re-verifies the whole capability and, under the
 * proposal's lock, compares it with Core's own state before any effect:
 *
 *  - ledger: the capability is Core's issuance row for exactly this request,
 *    binding, budgets, allocation, qualification, window and signer, and is
 *    the newest issuance for the proposal (no later attempt or fence);
 *  - run: Meri's run owner still holds the same admitted allocation and the
 *    same attempt, worker, fence and policy revision, before its deadline;
 *  - decision: the current stored decision hashes to the signed
 *    `decisionSha256`, is approved, unexpired, for this run and at the signed
 *    policy revision;
 *  - membership: active tenant, active membership, at least `standard_user`;
 *  - clients: every client in the scopes and the arguments is visible now;
 *  - body: exactly the signed `sourceBodySha256`, and Meri's null-omitting
 *    projection maps back to the signed arguments.
 *
 * The durable effect identity is (tenant, proposal, idempotency key), shared
 * by every capability for that proposal. The checks, the claim, the task
 * write and the completion with its JSON result are ONE transaction: either
 * all commit or none does, so a retry after any failure is safe and the task
 * is created at most once. A completed identity answers its stored result. A
 * claimed identity without a result cannot commit in this design; if one is
 * ever read it is UNKNOWN and is never dispatched again.
 *
 * The result has the exact shape of `MeriToolsService` `create_task`.
 */
@Injectable()
export class MeriExecutionReceiverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    @Optional() @Inject(MERI_EXECUTION_KEY_CONFIG) private readonly config: CoreEd25519KeyConfig | null = null,
  ) {}

  async receive(
    req: Request,
    ctx: TenantContext,
    name: string,
    body: unknown,
    identity: MeriExecutionRequestIdentity,
  ): Promise<Prisma.JsonValue> {
    const config = this.config;
    if (!config) throw new ServiceUnavailableException('Execution capabilities are not enabled');
    if (name !== MERI_EXECUTION_TOOL || !hasVerifiedToolServiceIdentity(req)) throw forbidden();
    let verified: VerifiedMeriExecution;
    try {
      verified = verifyMeriExecutionCapability(identity.token, meriExecutionTrust(config, Date.now()));
    } catch {
      throw new UnauthorizedException('Invalid execution capability');
    }
    const { claims, execution } = verified;
    if (claims.capabilityId !== identity.jti || claims.binding.tenantId !== ctx.tenantId || claims.binding.actorId !== ctx.userId ||
        identity.tenantId !== ctx.tenantId || identity.actorId !== ctx.userId) throw forbidden();
    let args: ReturnType<typeof taskCreateArgumentsFromBody>;
    try {
      args = taskCreateArgumentsFromBody(body);
    } catch {
      throw conflict('Execution body is not the approved command projection');
    }
    if (nativeCanonicalSha256(body) !== execution.sourceBodySha256 || nativeCanonicalSha256(args) !== execution.argumentsSha256) {
      throw conflict('Execution body differs from the approved command');
    }
    if (args.clientId !== null && !UUID.test(args.clientId)) throw conflict('Execution client is not a resolved client id');

    const key = { tenantId: ctx.tenantId, proposalId: execution.proposalId, idempotencyKey: execution.idempotencyKey };
    return this.prisma.withTenant(ctx.tenantId, async (tx): Promise<Prisma.JsonValue> => {
      await lockMeriExecutionProposal(tx, ctx.tenantId, execution.proposalId);
      const nowMs = Date.now();
      // Ledger.
      const issuance = await tx.clioMeriExecutionIssuance.findUnique({ where: { jti: claims.capabilityId } });
      if (!issuance || issuance.tenantId !== ctx.tenantId || issuance.proposalId !== execution.proposalId ||
          issuance.requestId !== execution.requestId || issuance.requestSha256 !== execution.requestSha256 ||
          issuance.commandSha256 !== execution.commandSha256 || issuance.decisionSha256 !== execution.decisionSha256 ||
          issuance.argumentsSha256 !== execution.argumentsSha256 || issuance.idempotencyKey !== execution.idempotencyKey ||
          issuance.runId !== claims.binding.runId || issuance.attemptId !== claims.binding.attemptId ||
          !sameJson(issuance.executorBinding, claims.binding) || !sameJson(issuance.budgets, claims.budgets) ||
          issuance.allocationSha256 !== execution.allocationSha256 || !sameJson(issuance.qualification, execution.qualification) ||
          issuance.signerIssuer !== claims.issuer || issuance.signerKeyId !== config.kid ||
          Number(issuance.iatSeconds) * 1000 !== Date.parse(claims.issuedAt) ||
          Number(issuance.expSeconds) * 1000 !== Date.parse(claims.expiresAt)) throw forbidden();
      const newest = await tx.clioMeriExecutionIssuance.findFirst({
        where: { tenantId: ctx.tenantId, proposalId: execution.proposalId },
        orderBy: [{ iatSeconds: 'desc' }, { recordedAt: 'desc' }],
      });
      if (!newest || newest.jti !== issuance.jti) throw conflict('Execution attempt superseded');
      // Current decision.
      const row = await tx.clioMeriApprovalDecision.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: execution.proposalId } },
      });
      if (!row) throw conflict('Approval decision is not current');
      const decision = nativeDecisionOf(row);
      if (nativeCanonicalSha256(decision) !== execution.decisionSha256 || decision.decision !== 'approved' ||
          row.expiresAt.getTime() <= nowMs || decision.policyRevision !== claims.policyRevision ||
          row.approverUserId !== ctx.userId || row.bindingActorUserId !== claims.binding.actorId ||
          row.conversationId !== claims.binding.conversationId || row.runId !== claims.binding.runId) {
        throw conflict('Approval decision is not current');
      }
      // Current run (Meri's owner): same allocation, attempt, worker, fence, policy.
      const admitted = await readMeriAdmittedRun(tx, claims.binding, claims.policyRevision, nowMs);
      if (admitted.allocationSha256 !== execution.allocationSha256 || !sameJson(admitted.qualification, execution.qualification) ||
          !sameJson(admitted.budgets, claims.budgets)) throw conflict('Execution run is not current');
      // Current membership.
      const membership = await tx.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
        include: { tenant: true },
      });
      if (!membership || membership.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, membership.role) ||
          ROLE_RANK[membership.role as TenantRole] < ROLE_RANK.standard_user) throw forbidden();
      // Current client wall.
      const clients = [...execution.clientIds, ...(args.clientId === null ? [] : [args.clientId])];
      if (!(await meriExecutionClientsVisible(tx, ctx.tenantId, ctx.userId, clients))) throw forbidden();
      // Durable effect identity.
      const existing = await tx.clioMeriExecutionConsumption.findUnique({ where: { tenantId_proposalId_idempotencyKey: key } });
      if (existing) {
        if (existing.commandSha256 !== execution.commandSha256 || existing.argumentsSha256 !== execution.argumentsSha256) {
          throw conflict('Execution identity belongs to another command');
        }
        if (existing.state === 'COMPLETED' && existing.result !== null) return existing.result;
        throw conflict('Execution outcome unknown');
      }
      if (nowMs >= identity.expMs) throw new UnauthorizedException('Invalid execution capability');
      await tx.clioMeriExecutionConsumption.create({
        data: { ...key, commandSha256: execution.commandSha256, argumentsSha256: execution.argumentsSha256, jti: issuance.jti },
      });
      // The effect, on the same transaction.
      const task = await this.engagement.createTask(ctx, {
        title: args.title, clientId: args.clientId ?? undefined, dueDate: args.dueDate ?? undefined,
      }, { tx, sourceType: MERI_EXECUTION_TASK_SOURCE, sourceId: `${execution.proposalId}|${execution.idempotencyKey}` });
      const result = JSON.parse(JSON.stringify({
        tool: MERI_EXECUTION_TOOL, generatedAt: new Date().toISOString(), created: true,
        task: { id: task.id, title: task.title, status: task.status, dueDate: task.dueDate, clientId: task.clientId, createdAt: task.createdAt },
      })) as Prisma.JsonObject;
      const done = await tx.clioMeriExecutionConsumption.updateMany({
        where: { ...key, jti: issuance.jti, state: 'CLAIMED' },
        data: { state: 'COMPLETED', result: result as Prisma.InputJsonObject, completedAt: new Date() },
      });
      if (done.count !== 1) throw new ServiceUnavailableException('Execution outcome unavailable');
      return result;
    });
  }
}
