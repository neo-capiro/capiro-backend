import { types as nodeTypes } from 'node:util';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { MeriPendingMemoryProposalRead } from '@capiro/shared/meri-read-outcome';
import { canonicalSha256 } from '../../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../../auth/read-delegation/read-delegation-request.js';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import type { GovernedMemoryCandidateService } from '../../memory/governed-memory-candidate.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { readOwnPendingMemoryProposals } from '../meri-memory-proposal-read.js';

const denied = () => new ForbiddenException('Memory proposal page refused');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MemoryProposalSelection {
  clientId: string;
  cursor: string | null;
  limit: number;
}

/** Meri memory.list_own_proposals@0.2.0 sends exactly its normalized selection.
 * It cannot use Core's ordinary /list_memory_proposals target with a token for
 * another operation until the shared owner signs that alias explicitly. */
export function parseTaskBoundMemoryProposalSelection(raw: unknown): MemoryProposalSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) throw denied();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 3 || keys.some((key) => typeof key !== 'string' ||
      !['clientId', 'cursor', 'limit'].includes(key) ||
      !Object.getOwnPropertyDescriptor(raw, key)?.enumerable ||
      !('value' in Object.getOwnPropertyDescriptor(raw, key)!))) throw denied();
  const r = raw as Record<string, unknown>;
  if (typeof r.clientId !== 'string' || !UUID.test(r.clientId) ||
      !(r.cursor === null || typeof r.cursor === 'string' &&
      r.cursor.length >= 1 && r.cursor.length <= 2048) ||
      !Number.isSafeInteger(r.limit) || (r.limit as number) < 1 || (r.limit as number) > 10) throw denied();
  return Object.freeze({ clientId: r.clientId, cursor: r.cursor, limit: r.limit }) as MemoryProposalSelection;
}

function assertTaskGrant(ctx: TenantContext, selection: MemoryProposalSelection,
  grant: MeriReadDelegationGrant | undefined, nowMs: number): void {
  if (!grant || grant.kind !== 'tool' || grant.operation?.id !== 'memory.list_own_proposals' ||
      grant.operation.version !== '0.2.0' || grant.tenantId !== ctx.tenantId || grant.actorId !== ctx.userId ||
      grant.clientId !== selection.clientId || !Number.isSafeInteger(nowMs) || nowMs >= grant.hardExpiryMs ||
      grant.argumentsSha256 !== canonicalSha256(selection) ||
      grant.binding.tenantId !== grant.tenantId || grant.binding.actorId !== grant.actorId ||
      grant.binding.conversationId !== grant.conversationId || grant.binding.runId !== grant.runId ||
      grant.binding.attemptId !== grant.admittedBinding.attemptId ||
      grant.binding.writerFence !== grant.admittedBinding.writerFence) throw denied();
}

/** Source-only selected-client producer. Token admission must have verified the
 * original ADMITTED grant, UNKNOWN reservation, consent/member/current client
 * under the Core budget lock. This function rechecks the live memory wall on
 * both sides of the canonical owner read, including an empty page. The future
 * HTTP owner must still run the delegated pre-byte release check. */
export async function readTaskBoundMemoryProposalPage(
  ctx: TenantContext,
  raw: unknown,
  grant: MeriReadDelegationGrant | undefined,
  prisma: Pick<PrismaService, 'withTenantUser'>,
  owner: Pick<GovernedMemoryCandidateService, 'listOwnProposals'>,
  now: () => number = Date.now,
): Promise<MeriPendingMemoryProposalRead> {
  const selection = parseTaskBoundMemoryProposalSelection(raw);
  assertTaskGrant(ctx, selection, grant, now());
  const wall = async () => {
    const allowed = await prisma.withTenantUser(ctx.tenantId, ctx.userId,
      (tx) => clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, selection.clientId));
    if (!allowed) throw denied();
  };
  await wall();
  const page = await readOwnPendingMemoryProposals(ctx,
    { clientId: selection.clientId, cursor: selection.cursor, limit: selection.limit }, owner);
  await wall();
  const complete = page.enabled && selection.cursor === null && page.nextCursor === null &&
    page.candidates.every((row) => !row.restricted && !row.contentTruncated && row.proposedText !== null);
  const reason = !page.enabled ? 'review_disabled' : complete
    ? 'own_pending_proposals_complete' : 'unread_pages_restricted_or_truncated_content';
  if (now() >= grant!.hardExpiryMs || page.scope.tenantId !== ctx.tenantId ||
      page.scope.userId !== ctx.userId || page.scope.clientId !== selection.clientId ||
      page.candidates.length > selection.limit ||
      page.nextCursor !== null && page.nextCursor === selection.cursor ||
      page.nextCursor !== null && page.candidates.length === 0 ||
      page.coverage.firstPage !== (selection.cursor === null) ||
      page.coverage.complete !== complete || page.coverage.reason !== reason ||
      page.candidates.some((row) => row.status !== 'pending' || row.approvedFact !== false) ||
      page.candidates.some((row) => row.clientId !== null && row.clientId !== selection.clientId)) throw denied();
  return page;
}
