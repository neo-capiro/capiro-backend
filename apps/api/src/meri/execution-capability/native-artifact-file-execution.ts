import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { NativeApprovalService, nativeDecisionOf } from '../native-approvals/native-approval.service.js';
import { nativeCanonicalSha256 as hash, parseApprovalProposal, parseRunBinding, sameJson, UUID,
  parseObjectReference, parseArtifactFileAttachments, type NativeApprovalProposal, type NativeRunBinding } from '../native-approvals/native-approval.contract.js';
import { MeriClientFilingService, type NativeFileObservation } from '../meri-client-filing.service.js';
import { retainedReadObject, retainedReadSnapshot } from '../retained-read-context.js';
import { meriExecutionDbNow } from './meri-execution-authority.js';
import { prepareNativeArtifactFileAuthority } from './native-artifact-file-authority.js';

type Ports = { prisma: PrismaService; approvals: NativeApprovalService; tenant: TenantContextMiddleware; filing: MeriClientFilingService };
export type NativeArtifactFileOutcome = {
  execution: { kind: 'native-artifact-file'; proposalId: string; commandSha256: string; idempotencyKey: string;
    binding: NativeRunBinding; completedAt: string; approvalDecisionSha256: string };
  result: { commandSha256: string; files: NativeFileObservation[] };
};
const denied = () => new ForbiddenException('Native filing authority refused');
const conflict = () => new ConflictException('Native filing differs from its retained decision or outcome');
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function outcomeOf(raw: unknown, proposal: NativeApprovalProposal, decisionSha: string, decidedAt: Date, completedAt: Date): NativeArtifactFileOutcome {
  const value = retainedReadObject(raw, ['execution', 'result']);
  const execution = retainedReadObject(value.execution, ['kind', 'proposalId', 'commandSha256', 'idempotencyKey', 'binding', 'completedAt', 'approvalDecisionSha256']);
  const result = retainedReadObject(value.result, ['commandSha256', 'files']);
  if (!instant(execution.completedAt) || execution.completedAt !== completedAt.toISOString() ||
      completedAt.getTime() < Math.max(Date.parse(proposal.createdAt), decidedAt.getTime()) ||
      !sameJson(execution, { kind: 'native-artifact-file', proposalId: proposal.proposalId, commandSha256: proposal.commandSha256,
        idempotencyKey: proposal.command.idempotencyKey, binding: proposal.command.binding, completedAt: execution.completedAt, approvalDecisionSha256: decisionSha }) ||
      result.commandSha256 !== proposal.commandSha256 || !Array.isArray(result.files) || result.files.length !== proposal.command.attachments.length) throw conflict();
  const seen = new Set<string>();
  for (const file of result.files) {
    const row = retainedReadObject(file, ['object', 'fileName', 'status', 'documentId', 'location', 'indexingStatus', 'reused',
      ...(file && typeof file === 'object' && Object.hasOwn(file, 'reason') ? ['reason'] : [])]);
    const object = parseObjectReference(row.object), identity = hash(object);
    if (seen.has(identity) || !proposal.command.attachments.some(value => sameJson(value, object)) ||
        typeof row.fileName !== 'string' || typeof row.documentId !== 'string' || !UUID.test(row.documentId) ||
        row.location !== `/clients?clientId=${proposal.command.arguments.clientId}&tab=files&attachmentId=${encodeURIComponent(row.documentId)}` ||
        typeof row.reused !== 'boolean' || !['saved', 'pending', 'failed'].includes(String(row.status)) ||
        (row.status === 'saved' ? !['pending', 'indexed'].includes(String(row.indexingStatus))
          : row.indexingStatus !== 'not_indexed' || typeof row.reason !== 'string') ||
        Object.hasOwn(row, 'reason') && typeof row.reason !== 'string') throw conflict();
    seen.add(identity);
  }
  return value as unknown as NativeArtifactFileOutcome;
}

/** A durable CLAIMED row precedes S3. Only its inserting request dispatches.
 * Existing claims may reconcile exact document provenance, never redispatch. */
export async function receiveNativeArtifactFile(ports: Ports, req: Request, ctx: TenantContext, raw: unknown, mode: 'execute' | 'read') {
  if (!hasVerifiedToolServiceIdentity(req)) throw denied();
  const input = retainedReadSnapshot(retainedReadObject(raw, mode === 'execute' ? ['proposal', 'binding', 'attachments'] : ['proposal', 'binding']), 262144);
  const proposal = parseApprovalProposal(input.proposal), binding = parseRunBinding(input.binding, 'binding');
  const { command } = proposal;
  const approvedObjects = parseArtifactFileAttachments(command.attachments);
  const mappings: { attachmentId: string; object: ReturnType<typeof parseObjectReference> }[] = [];
  if (mode === 'execute') {
    if (!Array.isArray(input.attachments) || input.attachments.length !== command.attachments.length) throw conflict();
    const ids = new Set<string>(), objects = new Set<string>();
    for (const entry of input.attachments) {
      const item = retainedReadObject(entry, ['attachmentId', 'object']), object = parseObjectReference(item.object), identity = hash(object);
      if (typeof item.attachmentId !== 'string' || !UUID.test(item.attachmentId) || ids.has(item.attachmentId) || objects.has(identity) ||
          !command.attachments.some(value => sameJson(value, object))) throw conflict();
      ids.add(item.attachmentId); objects.add(identity); mappings.push({ attachmentId: item.attachmentId, object });
    }
  }
  const { clientId, authorize, readCurrent } = await prepareNativeArtifactFileAuthority(ports, req, ctx, proposal, binding);
  const key = { tenantId: ctx.tenantId, proposalId: proposal.proposalId, idempotencyKey: command.idempotencyKey };
  const argumentsSha256 = hash({ arguments: command.arguments, attachments: command.attachments });

  const receipt = (tx: Prisma.TransactionClient) => tx.clioMeriExecutionConsumption.findUnique({ where: { tenantId_proposalId_idempotencyKey: key } });
  const complete = async (tx: Prisma.TransactionClient, decision: NonNullable<Awaited<ReturnType<typeof authorize>>>, files: NativeFileObservation[]) => {
    const completedAt = new Date(await meriExecutionDbNow(tx)), decisionSha = hash(nativeDecisionOf(decision));
    const outcome = outcomeOf({ execution: { kind: 'native-artifact-file', proposalId: proposal.proposalId, commandSha256: proposal.commandSha256,
      idempotencyKey: command.idempotencyKey, binding, completedAt: completedAt.toISOString(), approvalDecisionSha256: decisionSha },
    result: { commandSha256: proposal.commandSha256, files } }, proposal, decisionSha, decision.decidedAt, completedAt);
    const updated = await tx.clioMeriExecutionConsumption.updateMany({ where: { ...key, state: 'CLAIMED', jti: null },
      data: { state: 'COMPLETED', result: outcome as unknown as Prisma.InputJsonObject, completedAt } });
    if (updated.count !== 1) throw conflict();
    return outcome;
  };
  const readExisting = async (tx: Prisma.TransactionClient, decision: Awaited<ReturnType<typeof authorize>>) => {
    const stored = await receipt(tx);
    if (!stored) return undefined;
    if (!decision || stored.jti !== null || stored.commandSha256 !== proposal.commandSha256 || stored.argumentsSha256 !== argumentsSha256) throw conflict();
    if (stored.state === 'COMPLETED') {
      if (!stored.result || !stored.completedAt) throw conflict();
      const outcome = outcomeOf(stored.result, proposal, hash(nativeDecisionOf(decision)), decision.decidedAt, stored.completedAt);
      await ports.filing.assertNativeOutcomeCurrent(tx, ctx, clientId, outcome.result.files);
      return outcome;
    }
    if (stored.state !== 'CLAIMED') throw conflict();
    const files = await ports.filing.nativeObservations(tx, ctx, clientId, approvedObjects);
    return files ? complete(tx, decision, files) : null;
  };
  const release = async (outcome: NativeArtifactFileOutcome | null | undefined) => {
    const current = await readCurrent();
    await ports.prisma.withTenant(ctx.tenantId, async tx => {
      await authorize(tx, false);
      if (outcome) await ports.filing.assertNativeOutcomeCurrent(tx, ctx, clientId, outcome.result.files);
      if (current.expiresAtMs <= await meriExecutionDbNow(tx)) throw denied();
    });
    if (outcome === undefined) return null;
    return outcome === null ? mode === 'read' ? { state: 'UNKNOWN' as const } : { status: 'indeterminate' as const }
      : mode === 'read' ? { state: 'OUTCOME' as const, outcome } : { status: 'observed' as const, outcome };
  };

  const existing = await ports.prisma.withTenant(ctx.tenantId, async tx => readExisting(tx, await authorize(tx, false)));
  if (existing !== undefined || mode === 'read') return release(existing);
  const sources = await ports.filing.nativeSources(ctx, mappings);
  const acquired = await ports.prisma.withTenant(ctx.tenantId, async tx => {
    const decision = await authorize(tx, true);
    if (!decision) throw conflict();
    const other = await readExisting(tx, decision);
    if (other !== undefined) return { dispatch: false as const, outcome: other };
    await tx.clioMeriExecutionConsumption.create({ data: { ...key, commandSha256: proposal.commandSha256, argumentsSha256, jti: null } });
    return { dispatch: true as const };
  });
  if (!acquired.dispatch) return release(acquired.outcome);
  try {
    const files: NativeFileObservation[] = [];
    for (const source of sources) {
      const afterCommit: Array<() => void> = [];
      const observation = await ports.prisma.withTenant(ctx.tenantId, async tx => {
        const beforeWrite = async () => {
          if (!await authorize(tx, true)) throw conflict();
          const claimed = await receipt(tx);
          if (!claimed || claimed.state !== 'CLAIMED' || claimed.jti !== null ||
              claimed.commandSha256 !== proposal.commandSha256 || claimed.argumentsSha256 !== argumentsSha256) throw conflict();
        };
        await beforeWrite();
        return ports.filing.saveNativeSource(ctx, clientId, source, { tx, beforeWrite, afterCommit });
      }, { timeoutMs: 20_000 });
      files.push(observation);
      for (const effect of afterCommit) effect();
    }
    const outcome = await ports.prisma.withTenant(ctx.tenantId, async tx => {
      const decision = await authorize(tx, false);
      if (!decision) throw conflict();
      const stored = await receipt(tx);
      if (stored?.state === 'COMPLETED') {
        const other = await readExisting(tx, decision);
        if (!other) throw conflict();
        return other;
      }
      if (!stored || stored.state !== 'CLAIMED' || stored.jti !== null ||
          stored.commandSha256 !== proposal.commandSha256 || stored.argumentsSha256 !== argumentsSha256) throw conflict();
      await ports.filing.assertNativeOutcomeCurrent(tx, ctx, clientId, files);
      return complete(tx, decision, files);
    });
    return await release(outcome);
  } catch {
    // The durable claim and any successful document siblings remain. Neither a
    // failed DB transaction nor a timeout proves that an S3 write was undone.
    return { status: 'indeterminate' as const };
  }
}
