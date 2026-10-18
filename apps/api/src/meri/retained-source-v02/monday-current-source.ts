import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { mondayBoardScopeFromQuery } from '../../retrieval/adapters/monday-board-scope.js';
import {
  prepareMondayRead,
  projectMondayRead,
  RetainedDocumentsMondayRefusal,
  type CurrentManagedBoardMapping,
  type TrustedClientReadContext,
} from './documents-monday.js';

const fail = (reason: string): never => { throw new RetainedDocumentsMondayRefusal(reason); };
const sha256 = (value: unknown) => createHash('sha256').update(canonicalizeCoreRetainedJson(value)).digest('hex');

/** The same table, scope and row read by MondayManagedMcpAdapter.loadScope. */
export async function currentManagedMondayMapping(
  prisma: PrismaService,
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
  selectedClientId: string,
  boardContext: string | null,
): Promise<CurrentManagedBoardMapping> {
  const scope = mondayBoardScopeFromQuery(boardContext);
  if (scope.invalid || scope.boardIds.length > 20) fail('Invalid explicit Monday board scope');
  const row = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
    tx.meetingPrepMondayMapping.findFirst({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, clientId: selectedClientId },
      select: { id: true, updatedAt: true, boardIds: true },
    }),
  );
  if (!row || !row.boardIds.length || row.boardIds.length > 20 ||
    !row.boardIds.every((id) => /^\d{1,24}$/.test(id)) ||
    new Set(row.boardIds).size !== row.boardIds.length ||
    scope.boardIds.some((id) => !row.boardIds.includes(id)))
    fail('Current managed Monday mapping is unavailable');
  // The row identity, modification instant and exact board set are all read
  // from Core's existing owner. No client/model-provided version is accepted.
  const mappingVersionId = sha256({ id: row.id, updatedAt: row.updatedAt.toISOString(), boardIds: row.boardIds });
  return {
    tenantId: ctx.tenantId, userId: ctx.userId, clientId: selectedClientId,
    mappingVersionId, boardIds: [...row.boardIds],
    ...(scope.explicit ? { requestBoardIds: scope.boardIds } : {}),
  };
}

/**
 * Wrap only the already canonical Core read. It performs fresh mapping reads on
 * either side of that read, while the canonical adapter independently rechecks
 * membership, the client wall, its mapping, and provider access before release.
 */
export async function readWithCurrentMondayMapping(
  prisma: PrismaService,
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
  current: TrustedClientReadContext,
  normalizedInput: Record<string, unknown>,
  readCanonical: (legacyInput: Record<string, unknown>) => Promise<unknown>,
  now: () => number = Date.now,
): Promise<Record<string, unknown>> {
  if (ctx.tenantId !== current.binding.tenantId || ctx.userId !== current.binding.actorId ||
    typeof normalizedInput.boardContext !== 'string' && normalizedInput.boardContext !== null)
    fail('Monday caller or normalized scope differs');
  const boardContext = normalizedInput.boardContext as string | null;
  const before = await currentManagedMondayMapping(prisma, ctx, current.selectedClientId, boardContext);
  const legacyInput = prepareMondayRead(normalizedInput, current, before);
  const raw = await readCanonical(legacyInput);
  // The retrieval response has Date instances. Capture the exact JSON value
  // the HTTP response will return, then hash that same value for the receipt.
  let body: Record<string, unknown>;
  try {
    const bytes = JSON.stringify(raw);
    if (!bytes || Buffer.byteLength(bytes, 'utf8') > 16 * 1024 * 1024) fail('Monday result exceeds source bound');
    body = JSON.parse(bytes) as Record<string, unknown>;
  } catch { fail('Monday result is not JSON'); }
  const after = await currentManagedMondayMapping(prisma, ctx, current.selectedClientId, boardContext);
  if (before.mappingVersionId !== after.mappingVersionId ||
    sha256(before.boardIds) !== sha256(after.boardIds)) fail('Managed board mapping changed during the read');
  const observedAtMs = now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) fail('Invalid source observation time');
  return projectMondayRead(body, normalizedInput, current, after, {
    resultSha256: sha256(body), observedAt: new Date(observedAtMs).toISOString(),
    mappingVersionId: after.mappingVersionId,
  });
}
