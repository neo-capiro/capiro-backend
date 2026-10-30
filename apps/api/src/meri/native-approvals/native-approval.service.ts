import { authorizeNativeMemory } from './native-memory-command.js';
import { parseNativeMailArguments } from '../execution-capability/native-mail-command.js';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import {
  BROWSER_RECEIPT_SCHEMA,
  BROWSER_STATUS_SCHEMA,
  browserConsumptionId,
  browserConsumptionKey,
  browserProposalId,
  parseApprovalDecisionInput,
  parseApprovalRecordInput,
  parseApprovalRevokeInput,
  parseArtifactFileArguments,
  parseArtifactFileAttachments,
  parseBrowserDecisionRequest,
  parseBrowserProposalRequest,
  parseBrowserResultRequest,
  sameJson,
  type NativeApprovalDecision,
  type NativeApprovalReceipt,
  type NativeBrowserApprovalReadback,
  type NativeBrowserApprovalReceipt,
  type NativeBrowserPrepared,
  type NativeRunBinding,
  type NativeScope,
  UUID,
} from './native-approval.contract.js';
import { NativeApprovalMetadataVerifier } from './native-approval-metadata.js';
import {
  lockMeriExecutionProposal,
  meriExecutionClientsVisible,
  meriExecutionDbNow,
} from '../execution-capability/meri-execution-authority.js';
import { readMeriAdmittedRun } from '../execution-capability/meri-admitted-run.reader.js';
import { ApplicationCurrentService } from '../../auth/application-current.service.js';
import type { NativeApprovalProposal } from './native-approval.contract.js';

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

export interface NativePreparedAuthority {
  selectedClientId: string | null;
  policyRevision: string;
  expiresAtMs: number;
}

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
    @Optional() private readonly current?: ApplicationCurrentService,
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
    const now = Date.now();
    const createdAtMs = Date.parse(proposal.createdAt);
    const expiresAtMs = Date.parse(proposal.expiresAt);
    if (expiresAtMs <= now) throw new ConflictException('Approval proposal expired');
    if (createdAtMs > now + CREATED_AT_SKEW_MS) throw new ConflictException('Approval proposal is not yet valid');
    const { policyRevision } = await this.verifyPrepared(req, ctx, proposal);
    if (Date.parse(proposal.expiresAt) <= Date.now()) throw new ConflictException('Approval proposal expired');

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

  /** Shared preflight for approval and the existing effect/receipt receiver.
   * The original preparation binding stays immutable, even after its run ends.
   * Liveness is intentionally checked by the mutation caller, not historical
   * receipt reads. Current attended identity and retained metadata are required. */
  async verifyPrepared(req: Request, ctx: TenantContext, proposal: NativeApprovalProposal): Promise<NativePreparedAuthority> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const { binding } = proposal.command;
    if (binding.tenantId !== ctx.tenantId || binding.actorId !== ctx.userId ||
        proposal.requiredApprover.tenantId !== ctx.tenantId || proposal.requiredApprover.actorId !== ctx.userId) throw forbidden();
    if (!['task.create', 'task.update', 'document.draft', 'artifact.file', 'mail.send', 'memory.propose'].includes(proposal.command.action))
      throw new ConflictException('Approval action is not supported');
    const policyRevision = singlePolicyRevision(proposal.command.scopes, binding.tenantId);
    await this.currentPrepared(req, ctx, proposal);
    await this.metadata.verify(proposal);
    const observed = await this.currentPrepared(req, ctx, proposal);
    return { selectedClientId: observed.selectedClientId, policyRevision, expiresAtMs: observed.expiresAtMs };
  }

  private async currentPrepared(req: Request, ctx: TenantContext, proposal: NativeApprovalProposal) {
    if (!this.current) throw new ServiceUnavailableException('Current approval authority unavailable');
    const { binding, scopes } = proposal.command;
    const clients = scopes.filter(scope => scope.kind === 'client');
    if (clients.length > 1) throw forbidden();
    const clientId = clients[0]?.resourceId ?? null;
    if (clientId !== null && !UUID.test(clientId)) throw forbidden();
    if (clientId === null && (scopes.length !== 1 || scopes[0]!.kind !== 'private-user' ||
        scopes[0]!.resourceId !== binding.actorId)) throw forbidden();
    if (proposal.command.action === 'artifact.file') {
      const destination = parseArtifactFileArguments(proposal.command.arguments);
      const objects = parseArtifactFileAttachments(proposal.command.attachments);
      // Native filing is bounded to the conversation's selected client. Object
      // scopes are exact preparation correlations, never grants of access.
      if (clientId === null || scopes.length !== 1 || destination.clientId !== clientId ||
          destination.conversationId !== binding.conversationId || objects.some(object => !sameJson(object.scopes, scopes)))
        throw forbidden();
    }
    // The selector is checked against the persisted owned conversation by the
    // canonical current owner; a proposal scope is never an authorization grant.
    const observed = await this.current.read(ctx, req, { conversationId: binding.conversationId, clientId });
    if (observed.principal.tenantId !== ctx.tenantId || observed.principal.actorId !== ctx.userId ||
        observed.conversationId !== binding.conversationId || observed.selectedClientId !== clientId ||
        observed.expiresAtMs <= Date.now()) throw forbidden();
    if (proposal.command.action === 'memory.propose') {
      const member = await this.prisma.withTenant(ctx.tenantId, tx => tx.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' }, select: { role: true },
      }));
      if (!member) throw forbidden();
      authorizeNativeMemory(proposal, clientId, member.role as import('@capiro/shared').TenantRole);
    }
    if (proposal.command.action === 'task.create' || proposal.command.action === 'mail.send') {
      const destination = proposal.command.arguments.clientId;
      if (destination !== null && (typeof destination !== 'string' || !UUID.test(destination) ||
          (clientId !== null && destination !== clientId))) throw forbidden();
      // General may explicitly select an accessible destination. Omitted
      // clientId remains personal even in a client conversation.
      if (clientId === null && typeof destination === 'string' &&
          !await this.prisma.withTenant(ctx.tenantId, tx => meriExecutionClientsVisible(tx, ctx.tenantId, ctx.userId, [destination])))
        throw forbidden();
    }
    if (proposal.command.action === 'mail.send') {
      const args = parseNativeMailArguments(proposal.command.arguments);
      if (scopes.length !== 1 || !await this.prisma.withTenant(ctx.tenantId, tx => tx.integrationConnection.findFirst({
        where: { id: args.senderConnectionId, tenantId: ctx.tenantId, createdByUserId: ctx.userId }, select: { id: true },
      }))) throw forbidden();
    }
    return observed;
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

  /**
   * Browser consequential-action decision (SCRUM-222). Proves the proposal
   * against Meri's REAL retained preparation (internal readback) and its actual
   * current run custody before anything is written: the subject is never taken
   * from this request, and the four digests are each recomputed here.
   */
  async recordBrowser(req: Request, ctx: TenantContext, raw: unknown): Promise<NativeApprovalReceipt> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const input = parseBrowserDecisionRequest(raw);
    if (input.approver.tenantId !== ctx.tenantId || input.approver.actorId !== ctx.userId) throw forbidden();
    if (input.binding.tenantId !== ctx.tenantId || input.binding.actorId !== ctx.userId) throw forbidden();
    if (!sameJson(input.approver, { tenantId: ctx.tenantId, actorId: ctx.userId })) throw forbidden();
    const prepared = await this.browserPrepared(req, ctx, input);
    const requestedAtMs = prepared.preparation.requestedAtMs;
    // The decision lives inside the request window, capped by the retained proposal expiry.
    const expiresAtMs = Math.min(prepared.preparation.expiresAtMs, Date.parse(prepared.record.expiresAt));
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx): Promise<DecisionRow> => {
      await lockMeriExecutionProposal(tx, ctx.tenantId, input.proposalId);
      // Canonical CURRENT admission: attempt, worker, fence, qualification revision,
      // declared grants and deadline, all from Meri's own authority function.
      const admitted = await readMeriAdmittedRun(tx, input.binding, prepared.run.policyRevision, { tenantId: ctx.tenantId });
      const nowMs = admitted.dbNowMs;
      if (requestedAtMs > nowMs + CREATED_AT_SKEW_MS) throw new ConflictException('Approval request is not yet valid');
      if (expiresAtMs <= nowMs) throw new ConflictException('Approval proposal expired');
      const existing = await tx.clioMeriApprovalDecision.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: input.proposalId } },
      }) as DecisionRow | null;
      if (existing) {
        if (existing.commandSha256 !== input.subjectSha256) throw new ConflictException('Approval proposal already decided for another subject');
        return existing;
      }
      const create: DecisionRow = {
        tenantId: ctx.tenantId,
        proposalId: input.proposalId,
        // ONLY the subject digest is Core's decision identity (never C or A).
        commandSha256: input.subjectSha256,
        decision: input.decision,
        decidedAt: new Date(Math.max(nowMs, requestedAtMs)),
        expiresAt: new Date(expiresAtMs),
        approverUserId: ctx.userId,
        // The run's qualification/scopes revision, not the browser-policy digest.
        policyRevision: prepared.run.policyRevision,
        bindingActorUserId: input.binding.actorId,
        conversationId: input.binding.conversationId,
        runId: input.binding.runId,
      };
      return await tx.clioMeriApprovalDecision.create({ data: create }) as DecisionRow;
    });
    return receipt(row, await this.revoked(row.tenantId, row.proposalId));
  }

  /**
   * One-time consumption (SCRUM-222). ONLY the transaction that inserts the
   * fresh CLAIMED row answers a permissive receipt; a repeat, a restarted host,
   * a lost acknowledgement or any ambiguous state answers a NON-permissive
   * readback, because the earlier claim may already have produced a website
   * effect. Settlement never grants again.
   */
  async consumeBrowser(req: Request, ctx: TenantContext, raw: unknown):
    Promise<NativeBrowserApprovalReceipt | NativeBrowserApprovalReadback> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const input = parseBrowserProposalRequest(raw);
    if (input.binding.tenantId !== ctx.tenantId || input.binding.actorId !== ctx.userId) throw forbidden();
    const prepared = await this.browserPrepared(req, ctx, input);
    const toolUseId = prepared.preparation.subject.toolUseId;
    const key = { tenantId: ctx.tenantId, proposalId: input.proposalId, idempotencyKey: browserConsumptionKey(toolUseId) };
    return this.prisma.withTenant(ctx.tenantId, async (tx): Promise<NativeBrowserApprovalReceipt | NativeBrowserApprovalReadback> => {
      await lockMeriExecutionProposal(tx, ctx.tenantId, input.proposalId);
      const admitted = await readMeriAdmittedRun(tx, input.binding, prepared.run.policyRevision, { tenantId: ctx.tenantId });
      const nowMs = admitted.dbNowMs;
      const row = await this.currentBrowserDecision(tx, ctx, input);
      const revocation = await tx.clioMeriApprovalRevocation.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: input.proposalId } },
      });
      if (revocation) throw new ConflictException('Approval decision is revoked');
      if (row.expiresAt.getTime() <= nowMs) throw new ConflictException('Approval decision is not current');
      const existing = await tx.clioMeriExecutionConsumption.findUnique({ where: { tenantId_proposalId_idempotencyKey: key } });
      if (existing) {
        if (existing.commandSha256 !== input.subjectSha256) throw new ConflictException('Approval consumption belongs to another subject');
        return browserReadback(input.proposalId, input.subjectSha256, toolUseId, existing);
      }
      const created = await tx.clioMeriExecutionConsumption.create({
        data: {
          ...key, commandSha256: input.subjectSha256, argumentsSha256: prepared.record.inputSha256, jti: null,
          // A consumption can never precede the decision it consumes.
          claimedAt: new Date(Math.max(nowMs, row.decidedAt.getTime())),
        },
      });
      return {
        schema: BROWSER_RECEIPT_SCHEMA,
        subjectSha256: input.subjectSha256,
        proposalId: input.proposalId,
        toolUseId,
        decision: nativeDecisionOf(row),
        consumption: {
          consumed: true,
          consumptionId: browserConsumptionId(ctx.tenantId, input.proposalId, toolUseId),
          consumedAtMs: created.claimedAt.getTime(),
        },
      };
    });
  }

  /** Status readback: never a grant, always the same retained identity. */
  async statusBrowser(req: Request, ctx: TenantContext, raw: unknown): Promise<NativeBrowserApprovalReadback> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const input = parseBrowserProposalRequest(raw);
    if (input.binding.tenantId !== ctx.tenantId || input.binding.actorId !== ctx.userId) throw forbidden();
    const prepared = await this.browserPrepared(req, ctx, input);
    const toolUseId = prepared.preparation.subject.toolUseId;
    const key = { tenantId: ctx.tenantId, proposalId: input.proposalId, idempotencyKey: browserConsumptionKey(toolUseId) };
    return this.prisma.withTenant(ctx.tenantId, async (tx): Promise<NativeBrowserApprovalReadback> => {
      // A read: no proposal lock, no admission claim, no write.
      const row = await tx.clioMeriApprovalDecision.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: input.proposalId } },
      }) as DecisionRow | null;
      if (row && (row.commandSha256 !== input.subjectSha256 || row.approverUserId !== ctx.userId ||
          row.bindingActorUserId !== input.binding.actorId || row.conversationId !== input.binding.conversationId ||
          row.runId !== input.binding.runId)) throw forbidden();
      const revocation = await tx.clioMeriApprovalRevocation.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: input.proposalId } },
      });
      const existing = await tx.clioMeriExecutionConsumption.findUnique({ where: { tenantId_proposalId_idempotencyKey: key } });
      return browserReadback(input.proposalId, input.subjectSha256, toolUseId, existing, { revoked: revocation !== null, decision: row ? nativeDecisionOf(row) : null });
    });
  }

  /**
   * Effect settlement (SCRUM-222): the browser owner reports what actually
   * happened. One CLAIMED row transitions once to COMPLETED; a differing
   * repeat is refused, and settlement never re-authorizes execution.
   */
  async resultBrowser(req: Request, ctx: TenantContext, raw: unknown): Promise<NativeBrowserApprovalReadback> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const input = parseBrowserResultRequest(raw);
    if (input.binding.tenantId !== ctx.tenantId || input.binding.actorId !== ctx.userId) throw forbidden();
    const prepared = await this.browserPrepared(req, ctx, input);
    const toolUseId = prepared.preparation.subject.toolUseId;
    const key = { tenantId: ctx.tenantId, proposalId: input.proposalId, idempotencyKey: browserConsumptionKey(toolUseId) };
    const settlement = { outcome: input.outcome, result: input.result };
    return this.prisma.withTenant(ctx.tenantId, async (tx): Promise<NativeBrowserApprovalReadback> => {
      await lockMeriExecutionProposal(tx, ctx.tenantId, input.proposalId);
      // The decision identifies who may settle this exact subject.
      await this.currentBrowserDecision(tx, ctx, input);
      const existing = await tx.clioMeriExecutionConsumption.findUnique({ where: { tenantId_proposalId_idempotencyKey: key } });
      if (!existing) throw new ConflictException('No consumption to settle');
      if (existing.commandSha256 !== input.subjectSha256) throw new ConflictException('Approval consumption belongs to another subject');
      if (existing.state === 'COMPLETED') {
        if (!sameJson(existing.result, settlement)) throw new ConflictException('Consumption already settled with another result');
        return browserReadback(input.proposalId, input.subjectSha256, toolUseId, existing);
      }
      const completedAt = new Date(await meriExecutionDbNow(tx));
      const done = await tx.clioMeriExecutionConsumption.updateMany({
        where: { ...key, state: 'CLAIMED' },
        data: { state: 'COMPLETED', result: settlement as Prisma.InputJsonObject, completedAt },
      });
      if (done.count !== 1) throw new ConflictException('Consumption settlement is not current');
      return browserReadback(input.proposalId, input.subjectSha256, toolUseId,
        { ...existing, state: 'COMPLETED', result: settlement, completedAt });
    });
  }

  /**
   * The retained preparation is the ONLY source of the subject, the complete
   * binding, the scopes and the current run custody. Absent, unavailable or
   * mismatched preparation refuses here, before any decision or consumption.
   */
  private async browserPrepared(req: Request, ctx: TenantContext, input: {
    proposalId: string; subjectSha256: string; binding: NativeRunBinding;
  }): Promise<NativeBrowserPrepared> {
    if (!this.current) throw new ServiceUnavailableException('Current approval authority unavailable');
    const prepared = await this.metadata.verifyBrowser({
      proposalId: input.proposalId, binding: input.binding, subjectSha256: input.subjectSha256,
    });
    if (prepared.record.proposalId !== browserProposalId(input.binding, prepared.preparation.subject.toolUseId)) {
      throw new ConflictException('Approval proposal is not this attempt and tool use');
    }
    if (!sameJson(prepared.record.requiredApprover, { tenantId: ctx.tenantId, actorId: ctx.userId })) throw forbidden();
    // Selected context: the canonical scopes plus Core's existing current authority.
    const clients = prepared.record.scopes.filter((scope) => scope.kind === 'client');
    if (clients.length > 1) throw forbidden();
    const clientId = clients[0]?.resourceId ?? null;
    if (clientId === null && (prepared.record.scopes.length !== 1 ||
        prepared.record.scopes[0]!.kind !== 'private-user' || prepared.record.scopes[0]!.resourceId !== ctx.userId)) throw forbidden();
    if (clientId !== null && !UUID.test(clientId)) throw forbidden();
    const observed = await this.current.read(ctx, req, { conversationId: input.binding.conversationId, clientId });
    if (observed.principal.tenantId !== ctx.tenantId || observed.principal.actorId !== ctx.userId ||
        observed.conversationId !== input.binding.conversationId || observed.selectedClientId !== clientId ||
        observed.expiresAtMs <= Date.now()) throw forbidden();
    return prepared;
  }

  /** The stored decision for this exact subject and run, or a refusal. */
  private async currentBrowserDecision(tx: Prisma.TransactionClient, ctx: TenantContext, input: {
    proposalId: string; subjectSha256: string; binding: NativeRunBinding;
  }): Promise<DecisionRow> {
    const row = await tx.clioMeriApprovalDecision.findUnique({
      where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: input.proposalId } },
    }) as DecisionRow | null;
    if (!row || row.decision !== 'approved' || row.commandSha256 !== input.subjectSha256 ||
        row.approverUserId !== ctx.userId || row.bindingActorUserId !== input.binding.actorId ||
        row.conversationId !== input.binding.conversationId || row.runId !== input.binding.runId) {
      throw new ConflictException('Approval decision is not current');
    }
    return row;
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

/**
 * NON-permissive answer to a repeat, a restarted consumer or an ambiguous
 * consumption. It is deliberately NOT the approved receipt shape, so the host's
 * `receiptRefusal` refuses it: the earlier claim may already have produced a
 * website effect, and only a fresh claim may authorize a call.
 */
function browserReadback(
  proposalId: string,
  subjectSha256: string,
  toolUseId: string,
  row: { state: string; claimedAt: Date; completedAt: Date | null; result: unknown } | null,
  extra: { revoked?: boolean; decision?: NativeApprovalDecision | null } = {},
): NativeBrowserApprovalReadback {
  return {
    schema: BROWSER_STATUS_SCHEMA,
    proposalId,
    subjectSha256,
    toolUseId,
    permissive: false,
    unknown: row !== null && row.state === 'CLAIMED',
    consumption: row === null ? null : {
      state: row.state,
      consumedAtMs: row.claimedAt.getTime(),
      completedAtMs: row.completedAt === null ? null : row.completedAt.getTime(),
      result: row.result ?? null,
    },
    ...(Object.hasOwn(extra, 'revoked') ? { revoked: extra.revoked } : {}),
    ...(Object.hasOwn(extra, 'decision') ? { decision: extra.decision } : {}),
  };
}
