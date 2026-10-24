import { types as nodeTypes } from 'node:util';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { MeriPendingMemoryProposalRead } from '@capiro/shared/meri-read-outcome';
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

/** Exact normalized selection for the existing own-proposals reader. */
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

/** Recheck the current memory wall before and after the canonical own-proposals reader. */
export async function readTaskBoundMemoryProposalPage(
  ctx: TenantContext,
  raw: unknown,
  deadlineMs: number,
  prisma: Pick<PrismaService, 'withTenantUser'>,
  owner: Pick<GovernedMemoryCandidateService, 'listOwnProposals'>,
  now: () => number = Date.now,
): Promise<MeriPendingMemoryProposalRead> {
  const selection = parseTaskBoundMemoryProposalSelection(raw);
  if (!Number.isSafeInteger(deadlineMs) || now() >= deadlineMs) throw denied();
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
  if (now() >= deadlineMs || page.scope.tenantId !== ctx.tenantId ||
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
