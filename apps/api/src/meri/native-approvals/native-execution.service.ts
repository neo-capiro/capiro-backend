import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import type { CoreEd25519Signer } from '../../auth/core-ed25519-signer.js';
import {
  nativeCanonicalSha256,
  parseApprovalProposal,
  parseRunBinding,
  sameJson,
  type NativeApprovalDecision,
  type NativeApprovalProposal,
  type NativeRunBinding,
} from './native-approval.contract.js';
import { NativeApprovalMetadataVerifier } from './native-approval-metadata.js';
import { nativeDecisionOf } from './native-approval.service.js';
import {
  MERI_EXECUTION_SIGNER,
  lockMeriExecutionProposal,
  meriExecutionClientsVisible,
} from '../execution-capability/meri-execution-authority.js';
import { readMeriAdmittedRun } from '../execution-capability/meri-admitted-run.reader.js';
import {
  MERI_EXECUTION_ACTIONS,
  clientIdsOf,
  issueMeriExecutionCapability,
  meriExecutionRequestId,
  meriExecutionWindow,
  readMeriExecutionPlatformMaxima,
  taskClientWithinScopes,
  taskCreateSourceBody,
  withinMeriExecutionPlatformMaxima,
  type MeriCommandExecutionRequest,
  type MeriExecutionIssuance,
  type MeriQualificationBinding,
} from '../execution-capability/meri-execution-capability.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const forbidden = () => new ForbiddenException('Execution capability refused');
const conflict = (reason: string) => new ConflictException(reason);
const unavailable = () => new ServiceUnavailableException('Execution capability unavailable');

/** Meri's rev 3 issuance request (meri-greenfield 11b90c7f `execution-issuance.mjs`), closed. */
export interface ExecutionIssueInput {
  proposal: NativeApprovalProposal;
  executorBinding: NativeRunBinding;
  requestId: string;
  allocation: unknown;
  allocationSha256: string;
  qualification: unknown;
  runDeadlineMs: number;
}

export function parseExecutionIssueInput(value: unknown): ExecutionIssueInput {
  const keys = ['proposal', 'executorBinding', 'requestId', 'allocation', 'allocationSha256', 'qualification', 'runDeadlineMs'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new BadRequestException('Invalid execution request');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((k) => typeof k !== 'string' || !keys.includes(k))) throw new BadRequestException('Invalid execution request');
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== 'string' || !UUID.test(v.requestId)) throw new BadRequestException('Invalid execution request: requestId');
  if (typeof v.allocationSha256 !== 'string' || !HEX64.test(v.allocationSha256)) throw new BadRequestException('Invalid execution request: allocationSha256');
  if (!Number.isSafeInteger(v.runDeadlineMs) || (v.runDeadlineMs as number) < 1) throw new BadRequestException('Invalid execution request: runDeadlineMs');
  if (!v.allocation || typeof v.allocation !== 'object' || Array.isArray(v.allocation)) throw new BadRequestException('Invalid execution request: allocation');
  if (!v.qualification || typeof v.qualification !== 'object' || Array.isArray(v.qualification)) throw new BadRequestException('Invalid execution request: qualification');
  return {
    proposal: parseApprovalProposal(v.proposal),
    executorBinding: parseRunBinding(v.executorBinding, 'executorBinding'),
    requestId: v.requestId,
    allocation: v.allocation,
    allocationSha256: v.allocationSha256,
    qualification: v.qualification,
    runDeadlineMs: v.runDeadlineMs as number,
  };
}

interface Planned {
  decision: NativeApprovalDecision;
  capabilityId: string;
  nowMs: number;
  exp: number;
  requestSha256: string;
  allocation: unknown;
  qualification: MeriQualificationBinding;
  runDeadlineMs: number;
}

/**
 * Core's approved-execution issuance (D016 #9; docs/integration/
 * MERI-EXECUTION-CAPABILITY-DRAFT.md §3). Called by Meri's decide route with
 * the attended approver's native bearer and the verified service identity.
 *
 * Preconditions, re-run in full on every call including a replay, all under
 * the proposal lock and Meri's budget lock and against the database clock:
 *  1. caller = the proposal's required approver = the executor binding's actor;
 *  2. the stored decision is approved, unexpired, not revoked, for this command
 *     and run; the proposal equals Meri's prepared approval metadata;
 *  3. the executor binding keeps the proposal's tenant/actor/conversation/run,
 *     is EXACTLY the admitted run's binding (Meri's canonical admission: this
 *     authenticates attempt, worker and fence), and the request id is Meri's
 *     deterministic id for it;
 *  4. the action is `task.create` with closed arguments and no attachments;
 *  5. every scope is this tenant's at the decision's policy revision, the
 *     task's client is inside the approved client scope (or the tenant-level
 *     contract for a null client), and every client is visible now.
 * The request's allocation, allocation hash, qualification and run deadline
 * must equal what Core reads from Meri's admission owner; budgets are derived
 * from that allocation and bounded only by configured platform maxima.
 *
 * The ledger row is written before signing. A live row for the same request is
 * re-signed at its recorded iat (the same capability); a live row for another
 * attempt, or a lower writer fence, is refused.
 */
@Injectable()
export class NativeExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metadata: NativeApprovalMetadataVerifier,
    @Optional() @Inject(MERI_EXECUTION_SIGNER) private readonly signer: CoreEd25519Signer | null = null,
  ) {}

  async issue(req: Request, ctx: TenantContext, raw: unknown): Promise<MeriExecutionIssuance> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const signer = this.signer;
    if (!signer) throw new ServiceUnavailableException('Execution capabilities are not enabled');
    let maxima: ReturnType<typeof readMeriExecutionPlatformMaxima>;
    try {
      maxima = readMeriExecutionPlatformMaxima(process.env);
    } catch {
      throw unavailable();
    }
    const input = parseExecutionIssueInput(raw);
    const { proposal, executorBinding } = input;
    const command = proposal.command;
    // 1.
    if (proposal.requiredApprover.tenantId !== ctx.tenantId || proposal.requiredApprover.actorId !== ctx.userId ||
        executorBinding.tenantId !== ctx.tenantId || executorBinding.actorId !== ctx.userId) throw forbidden();
    // 3. (stable binding, request id)
    if (executorBinding.conversationId !== command.binding.conversationId || executorBinding.runId !== command.binding.runId ||
        command.binding.tenantId !== ctx.tenantId || command.binding.actorId !== ctx.userId) throw conflict('Executor binding differs from the proposal');
    if (input.requestId !== meriExecutionRequestId({ proposalId: proposal.proposalId, commandSha256: proposal.commandSha256, executorBinding })) {
      throw conflict('Execution request id is not the deterministic id for this attempt');
    }
    // 4.
    if (!MERI_EXECUTION_ACTIONS.includes(command.action) || command.attachments.length !== 0) throw conflict('Execution action is not supported');
    let clientId: string | null;
    try {
      clientId = taskCreateSourceBody(command.arguments).clientId ?? null;
    } catch {
      throw conflict('Execution arguments are not closed task arguments');
    }
    // 5. (scope containment)
    if (!taskClientWithinScopes(clientId, command.scopes, ctx.tenantId)) throw conflict('Execution client is outside the approved scope');
    // Native metadata is immutable and read through its owning service. Keep
    // network I/O outside the proposal transaction; persisted admission and
    // decision checks below retain their existing locks and database clock.
    await this.metadata.verify(proposal);
    const planned = await this.prisma.withTenant(ctx.tenantId, async (tx): Promise<Planned> => {
      await lockMeriExecutionProposal(tx, ctx.tenantId, proposal.proposalId);
      // 2. (stored decision, revocation)
      const row = await tx.clioMeriApprovalDecision.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } },
      });
      if (!row || row.decision !== 'approved' || row.commandSha256 !== proposal.commandSha256 || row.approverUserId !== ctx.userId ||
          row.bindingActorUserId !== command.binding.actorId || row.conversationId !== command.binding.conversationId ||
          row.runId !== command.binding.runId) throw conflict('Approval decision is not current');
      const revocation = await tx.clioMeriApprovalRevocation.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } },
      });
      if (revocation) throw conflict('Approval decision is revoked');
      const decision = nativeDecisionOf(row);
      const decisionSha256 = nativeCanonicalSha256(decision);
      // 5.
      if (command.scopes.some((s) => s.tenantId !== ctx.tenantId || s.policyRevision !== decision.policyRevision)) {
        throw conflict('Execution scopes differ from the decision policy');
      }
      const clients = [...clientIdsOf(command.scopes), ...(clientId === null ? [] : [clientId])];
      if (!(await meriExecutionClientsVisible(tx, ctx.tenantId, ctx.userId, clients))) throw forbidden();
      // 3. Meri's admission owner, under its budget lock; the database clock from here on.
      const admitted = await readMeriAdmittedRun(tx, executorBinding, decision.policyRevision, { tenantId: ctx.tenantId });
      const nowMs = admitted.dbNowMs;
      if (row.expiresAt.getTime() <= nowMs) throw conflict('Approval decision is not current');
      if (input.allocationSha256 !== admitted.allocationSha256 || !sameJson(input.allocation, admitted.allocation) ||
          !sameJson(input.qualification, admitted.qualification) || input.runDeadlineMs !== admitted.deadlineMs) {
        throw conflict('Execution request differs from the admitted run');
      }
      if (!withinMeriExecutionPlatformMaxima(admitted.budgets, maxima)) throw conflict('Execution budgets exceed the platform maxima');
      const runDeadlineMs = Math.min(Date.parse(proposal.expiresAt), admitted.deadlineMs);

      // Ledger: fence, other attempts, replay.
      const rows = await tx.clioMeriExecutionIssuance.findMany({
        where: { tenantId: ctx.tenantId, proposalId: proposal.proposalId },
        orderBy: [{ iatSeconds: 'desc' }, { recordedAt: 'desc' }],
        take: 64,
      });
      const nowSeconds = Math.floor(nowMs / 1000);
      for (const r of rows) {
        const fence = (r.executorBinding as { writerFence?: unknown } | null)?.writerFence;
        if (r.runId === executorBinding.runId && (typeof fence !== 'number' || fence > executorBinding.writerFence)) {
          throw conflict('Execution attempt is fenced');
        }
      }
      const live = rows.filter((r) => Number(r.expSeconds) > nowSeconds);
      if (live.some((r) => r.requestId !== input.requestId)) throw conflict('Another execution attempt holds a live capability');
      const replay = live[0];
      if (replay) {
        if (!sameJson(replay.executorBinding, executorBinding) || !sameJson(replay.budgets, admitted.budgets) ||
            replay.allocationSha256 !== admitted.allocationSha256 || !sameJson(replay.qualification, admitted.qualification) ||
            replay.decisionSha256 !== decisionSha256 ||
            replay.commandSha256 !== proposal.commandSha256 || replay.signerIssuer !== signer.issuer || replay.signerKeyId !== signer.kid) {
          throw conflict('Execution request differs from its live capability');
        }
        return {
          decision, capabilityId: replay.jti, nowMs: Number(replay.iatSeconds) * 1000, exp: Number(replay.expSeconds),
          requestSha256: replay.requestSha256, allocation: admitted.allocation, qualification: admitted.qualification, runDeadlineMs,
        };
      }
      const { iat, exp } = meriExecutionWindow({
        nowMs, decisionExpiresAt: decision.expiresAt, proposalExpiresAt: proposal.expiresAt, runDeadlineMs,
      });
      const capabilityId = randomUUID();
      const request: MeriCommandExecutionRequest = {
        contractVersion: '0.1.0', requestId: input.requestId, capabilityId, executorBinding,
        proposalId: proposal.proposalId, commandSha256: proposal.commandSha256, idempotencyKey: command.idempotencyKey,
      };
      const requestSha256 = nativeCanonicalSha256(request);
      await tx.clioMeriExecutionIssuance.create({
        data: {
          jti: capabilityId, tenantId: ctx.tenantId, proposalId: proposal.proposalId,
          runId: executorBinding.runId, attemptId: executorBinding.attemptId, requestId: input.requestId,
          requestSha256, commandSha256: proposal.commandSha256, decisionSha256,
          argumentsSha256: nativeCanonicalSha256(command.arguments), idempotencyKey: command.idempotencyKey,
          executorBinding: { ...executorBinding }, budgets: { ...admitted.budgets }, allocationSha256: admitted.allocationSha256,
          qualification: { ...admitted.qualification },
          signerIssuer: signer.issuer, signerKeyId: signer.kid, iatSeconds: BigInt(iat), expSeconds: BigInt(exp),
        },
      });
      return { decision, capabilityId, nowMs, exp, requestSha256, allocation: admitted.allocation, qualification: admitted.qualification, runDeadlineMs };
    });

    let issued: MeriExecutionIssuance;
    try {
      issued = await issueMeriExecutionCapability({
        proposal, decision: planned.decision, executorBinding, requestId: input.requestId, capabilityId: planned.capabilityId,
        allocation: planned.allocation, qualification: planned.qualification, nowMs: planned.nowMs, runDeadlineMs: planned.runDeadlineMs,
      }, signer);
    } catch {
      throw unavailable();
    }
    // The signed request and window are exactly the ledger row's.
    if (issued.expiresAtMs !== planned.exp * 1000 || nativeCanonicalSha256(issued.execution) !== planned.requestSha256) throw unavailable();
    return { execution: issued.execution, credential: issued.credential, checkedAtMs: Date.now(), expiresAtMs: issued.expiresAtMs };
  }
}
