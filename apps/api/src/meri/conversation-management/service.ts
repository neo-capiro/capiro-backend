import { ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { retireConversationOfficeDraftsInTx } from '../office-drafts/retention-subject.js';
import { authorizeResearchPortfolioConversation } from '../../research-portfolios/research-portfolio-artifact-authority.js';
import { MANAGEMENT_VERSION, TRASH_MS, managementDigest, parseManagementRequest,
  type ConversationMetadata, type ManagementReceipt, type ManagementRequest, type ResearchConversationCapture } from './contract.js';
export { readConversationRetentionState, type ConversationRetentionIdentity, type ConversationRetentionState } from './retention.js';

/** Private Core response. Meri owns run exclusion and retention transitions;
 * Core owns metadata, the database clock, CAS and durable request receipts. */
export type ManagementReadback = {
  version: typeof MANAGEMENT_VERSION; requestId: string; current: ConversationMetadata;
  receipt: ManagementReceipt | null; releaseRetention: boolean; suppressionRequestId: string | null;
};
type Tx = Prisma.TransactionClient;
const include = { bootstrapReceipt: true } as const;
export type ManagedRow = Prisma.ClioConversationGetPayload<{ include: typeof include }>;
export async function assertManagedMembership(tx: Tx, ctx: TenantContext) {
  const membership = await tx.tenantMembership.findFirst({ where: { tenantId: ctx.tenantId, userId: ctx.userId,
    status: 'active', tenant: { status: 'active' } }, select: { id: true } });
  if (!membership) throw new ForbiddenException('Current conversation access unavailable');
}
export async function visibleBinding(tx: Tx, ctx: TenantContext, row: ManagedRow, { research = false } = {}): Promise<ResearchConversationCapture | undefined> {
  if (!research && row.metadata && typeof row.metadata === 'object' &&
      Object.hasOwn(row.metadata, 'researchPortfolioScope')) throw new NotFoundException('Chat not found');
  // Read-only history explicitly admits the canonical Research capture. Lifecycle
  // mutations retain their bootstrap/retention contract and never infer General.
  if (research) {
    const captured = await authorizeResearchPortfolioConversation(tx, ctx, row, { lock: false });
    if (captured) {
      if (row.bootstrapReceipt || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(captured.researchPortfolioId) ||
          !Number.isSafeInteger(captured.researchPortfolioRevision) || captured.researchPortfolioName.length > 400 ||
          Array.from(captured.researchPortfolioName).length > 200) throw new NotFoundException('Chat not found');
      return Object.freeze({ kind: captured.kind, researchPortfolioId: captured.researchPortfolioId,
        researchPortfolioName: captured.researchPortfolioName, researchPortfolioRevision: captured.researchPortfolioRevision,
        scopeVersion: captured.scopeVersion });
    }
  }
  const b = row.bootstrapReceipt;
  if (row.tenantId !== ctx.tenantId || row.userId !== ctx.userId || !b || b.tenantId !== ctx.tenantId ||
      b.actorUserId !== ctx.userId || b.conversationId !== row.id || b.clientId !== row.clientId ||
      b.scopeKind !== (row.clientId === null ? 'general' : 'client')) throw new NotFoundException('Chat not found');
  if (row.clientId !== null) {
    const client = await tx.client.findFirst({ where: { id: row.clientId, tenantId: ctx.tenantId, status: { not: 'archived' },
      OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { tenantId: ctx.tenantId, userId: ctx.userId } } }] }, select: { id: true } });
    if (!client) throw new NotFoundException('Chat not found');
  }
}
export function metadata(row: ManagedRow, scope?: ResearchConversationCapture): ConversationMetadata {
  if (!['active', 'archived', 'trashed'].includes(row.status)) throw new NotFoundException('Chat not found');
  return { conversationId: row.id, title: row.title, status: row.status as ConversationMetadata['status'],
    revision: row.metadataRevision.toString(), ...(scope ? { scopeKind: 'research_portfolio' as const, clientId: null, scope } :
      { scopeKind: row.bootstrapReceipt!.scopeKind as 'client' | 'general', clientId: row.clientId }),
    updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null,
    trashedAt: row.trashedAt?.toISOString() ?? null, restoreUntil: row.restoreUntil?.toISOString() ?? null };
}

async function commandState(tx: Tx, ctx: TenantContext, request: ManagementRequest, applying: boolean) {
      await assertManagedMembership(tx, ctx);
      // This read chooses lock targets, never authorizes an effect. Match the
      // current client owner: client, member/tenant, grant, then conversation.
      // In particular, do not hold tenant while waiting on a client owner that
      // may itself be queued behind a tenant writer.
      const hint = await tx.clioConversation.findFirst({ where: { id: request.conversationId,
        tenantId: ctx.tenantId, userId: ctx.userId }, select: { clientId: true } });
      if (!hint) throw new NotFoundException('Chat not found');
      if (hint.clientId !== null) await tx.$executeRaw`SELECT id FROM clients
        WHERE tenant_id=${ctx.tenantId}::uuid AND id=${hint.clientId}::uuid FOR SHARE`;
      await tx.$executeRaw`SELECT id FROM tenant_memberships
        WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid ORDER BY id FOR SHARE`;
      await tx.$executeRaw`SELECT id FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
      if (hint.clientId !== null) await tx.$executeRaw`SELECT id FROM client_memory_access
        WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${hint.clientId}::uuid
          AND user_id=${ctx.userId}::uuid ORDER BY id FOR SHARE`;
      // Retain current authority through both metadata and immutable receipt
      // commit/readback. Recheck after all potentially blocking locks above.
      await tx.$executeRaw`SELECT id FROM clio_conversations WHERE id=${request.conversationId}::uuid
        AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid FOR UPDATE`;
      await assertManagedMembership(tx, ctx);
      const row = await tx.clioConversation.findFirst({ where: { id: request.conversationId, tenantId: ctx.tenantId, userId: ctx.userId }, include });
      if (!row || row.clientId !== hint.clientId) throw new NotFoundException('Chat not found');
      await visibleBinding(tx, ctx, row);
      const prior = await tx.clioConversationManagementReceipt.findUnique({ where: {
        tenantId_actorUserId_requestId: { tenantId: ctx.tenantId, actorUserId: ctx.userId, requestId: request.requestId } } });
      if (prior) {
        if (prior.requestSha256 !== managementDigest(request)) throw new ConflictException('REQUEST_ID_CONFLICT');
        if (prior.conversationId !== row.id) throw new GoneException('CONVERSATION_DELETED');
        const stored = prior.receipt as unknown as { receipt: ManagementReceipt; releaseRetention: boolean; suppressionRequestId: string | null };
        const saved = stored.receipt;
        // Reconcile only this exact revision. A later Trash must never be undone by an old retry.
        const release = request.operation === 'restore' && stored.releaseRetention === true && row.status === 'active' &&
          row.metadataRevision.toString() === saved.conversation.revision;
        return { row, receipt: saved, releaseRetention: release, suppressionRequestId: release ? stored.suppressionRequestId : null, now: null };
      }
      // Readback must still distinguish an absent receipt from a committed
      // change after CAS refusal or a lost response. It never authorizes apply.
      if (!applying) return { row, receipt: null, releaseRetention: false, suppressionRequestId: null, now: null };
      if (row.metadataRevision.toString() !== request.expectedRevision) throw new ConflictException('STALE_REVISION');
      const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = clock[0]!.now;
      if (row.status === 'trashed' && (!row.restoreUntil || row.restoreUntil <= now)) throw new GoneException('RESTORE_EXPIRED');
      if (request.operation === 'rename' && row.status === 'trashed') throw new ConflictException('Restore the chat before renaming it');
      if (request.operation === 'archive' && row.status !== 'active') throw new ConflictException('Chat is not active');
      if (request.operation === 'trash' && row.status === 'trashed') throw new ConflictException('Chat is already in Trash');
      if (request.operation === 'restore' && !['archived', 'trashed'].includes(row.status)) throw new ConflictException('Chat is not archived or in Trash');
      const releaseRetention = request.operation === 'restore' && row.status === 'trashed';
      let suppressionRequestId: string | null = null;
      if (releaseRetention) {
        // The immutable Trash receipt identifies exactly which suppression this
        // Restore may release, even after a later request has started but not committed.
        const priorTrash = await tx.clioConversationManagementReceipt.findMany({ where: {
          tenantId: ctx.tenantId, actorUserId: ctx.userId, conversationId: row.id,
          receipt: { path: ['receipt', 'conversation', 'revision'], equals: row.metadataRevision.toString() },
        }, take: 2 });
        const saved = priorTrash[0]?.receipt as unknown as { receipt?: ManagementReceipt; releaseRetention?: boolean };
        if (priorTrash.length !== 1 || saved?.receipt?.conversation.status !== 'trashed' ||
            saved.receipt.conversation.conversationId !== row.id || saved.receipt.requestId !== priorTrash[0]!.requestId ||
            saved.releaseRetention !== false) throw new ConflictException('TRASH_RECEIPT_UNAVAILABLE');
        suppressionRequestId = priorTrash[0]!.requestId;
      }
      return { row, receipt: null, releaseRetention, suppressionRequestId, now };
}

function readback(request: ManagementRequest, state: { row: ManagedRow; receipt: ManagementReceipt | null; releaseRetention: boolean; suppressionRequestId: string | null }): ManagementReadback {
  return { version: MANAGEMENT_VERSION, requestId: request.requestId, current: metadata(state.row),
    receipt: state.receipt, releaseRetention: state.receipt !== null && state.releaseRetention,
    suppressionRequestId: state.receipt !== null && state.releaseRetention ? state.suppressionRequestId : null };
}

/** Exact request readback retains current ownership checks. An absent receipt
 * is not an acknowledgement of a write or authorization to mutate metadata. */
export async function readManagementRequest(prisma: PrismaService, ctx: TenantContext, raw: unknown): Promise<ManagementReadback> {
  const request = parseManagementRequest(raw);
  return prisma.withTenant(ctx.tenantId, async tx => readback(request, await commandState(tx, ctx, request, false)));
}

export async function manageConversation(prisma: PrismaService, ctx: TenantContext, raw: unknown): Promise<ManagementReadback> {
  const request = parseManagementRequest(raw);
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
      const state = await commandState(tx, ctx, request, true);
      if (request.operation === 'trash' && (!state.receipt || state.row.status === 'trashed'))
        await retireConversationOfficeDraftsInTx(tx, ctx.tenantId, ctx.userId, request.conversationId);
      if (state.receipt) return readback(request, state);
      const { row, releaseRetention: release } = state;
      const now = state.now!;
      let data: Prisma.ClioConversationUpdateInput = { metadataRevision: { increment: 1 }, updatedAt: now };
      if (request.operation === 'rename') {
        data.title = request.title;
      } else if (request.operation === 'archive') {
        data = { ...data, status: 'archived', archivedAt: now };
      } else if (request.operation === 'trash') {
        const restoreUntil = new Date(now.getTime() + TRASH_MS);
        data = { ...data, status: 'trashed', archivedAt: row.archivedAt ?? now, trashedAt: now, restoreUntil };
      } else {
        data = { ...data, status: 'active', archivedAt: null, trashedAt: null, restoreUntil: null };
      }
      const updated = await tx.clioConversation.update({ where: { id: row.id }, data, include });
      const result: ManagementReceipt = { version: MANAGEMENT_VERSION, requestId: request.requestId, conversation: metadata(updated) };
      await tx.clioConversationManagementReceipt.create({ data: { tenantId: ctx.tenantId, actorUserId: ctx.userId,
        requestId: request.requestId, conversationId: row.id, requestSha256: managementDigest(request),
        receipt: { receipt: result, releaseRetention: release, suppressionRequestId: state.suppressionRequestId } } });
      return readback(request, { row: updated, receipt: result, releaseRetention: release, suppressionRequestId: state.suppressionRequestId });
  });
}

/** Trusted runtime composition reads this under its already-held canonical
 * conversation lock. This helper never acquires the Meri advisory lock. */
export async function readManagedConversationMetadata(prisma: PrismaService,
  principal: { tenantId: string; actorId: string }, conversationId: string) {
  return prisma.withTenant(principal.tenantId, async tx => {
    await assertManagedMembership(tx, { tenantId: principal.tenantId, userId: principal.actorId } as TenantContext);
    const row = await tx.clioConversation.findFirst({ where: { id: conversationId,
      tenantId: principal.tenantId, userId: principal.actorId }, include });
    if (!row) throw new NotFoundException('Chat not found');
    const scope = await visibleBinding(tx, { tenantId: principal.tenantId, userId: principal.actorId } as TenantContext, row, { research: true });
    return metadata(row, scope);
  });
}

/** Canonical retention ownership adapter. A caller-supplied actor is never proof
 * of ownership. Visibility remains a separate check for reads and mutations. */
export async function readManagedConversationOwner(prisma: PrismaService,
  input: { tenantId: string; conversationId: string }): Promise<string> {
  return prisma.withTenant(input.tenantId, async tx => {
    const row = await tx.clioConversation.findFirst({ where: { id: input.conversationId, tenantId: input.tenantId }, include });
    const b = row?.bootstrapReceipt;
    if (!row || !b || row.tenantId !== input.tenantId || b.tenantId !== input.tenantId ||
        b.conversationId !== row.id || b.actorUserId !== row.userId || b.clientId !== row.clientId ||
        b.scopeKind !== (row.clientId === null ? 'general' : 'client')) throw new NotFoundException('Chat not found');
    return row.userId;
  });
}

export async function assertLegacyManagementAllowed(tx: Tx, tenantId: string, conversationId: string) {
  const bound = await tx.clioConversationBootstrapReceipt.findFirst({
    where: { tenantId, conversationId }, select: { requestId: true } });
  if (bound) throw new ConflictException('VERSIONED_CONVERSATION_MANAGEMENT_REQUIRED');
}
