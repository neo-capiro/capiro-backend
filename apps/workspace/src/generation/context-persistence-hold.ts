import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';

const HOLD_TTL_MS = 5 * 60 * 1_000;

interface PersistenceHold {
  errorCode: string;
  expiresAt: number;
}

const holds = new Map<string, PersistenceHold>();

function key(tenantId: string, draftId: string): string {
  return `${tenantId}:${draftId}`;
}

/** Start a new compile attempt without inheriting a stale failed-attempt hold. */
export function clearContextPersistenceHold(tenantId: string, draftId: string): void {
  holds.delete(key(tenantId, draftId));
}

/** Record only bounded identity and reason-code metadata. */
export function markContextPersistenceHold(
  tenantId: string,
  draftId: string,
  errorCode: string,
): void {
  holds.set(key(tenantId, draftId), {
    errorCode: errorCode.slice(0, 80),
    expiresAt: Date.now() + HOLD_TTL_MS,
  });
}

export function consumeContextPersistenceHold(
  tenantId: string,
  draftId: string,
): PersistenceHold | null {
  const holdKey = key(tenantId, draftId);
  const hold = holds.get(holdKey);
  if (!hold) return null;
  holds.delete(holdKey);
  if (hold.expiresAt <= Date.now()) return null;
  return hold;
}

export function assertContextPersistenceReleased(tenantId: string, draftId: string): void {
  const hold = consumeContextPersistenceHold(tenantId, draftId);
  if (!hold) return;
  throw new ServiceUnavailableException(
    `Document generation was held because its context provenance could not be saved (${hold.errorCode}).`,
  );
}

/**
 * Identify a generated-draft write without inspecting any section bodies. This is
 * deliberately pure so the Prisma middleware contract is unit-testable.
 */
export function workspaceDraftWriteTarget(
  params: Pick<Prisma.MiddlewareParams, 'model' | 'action' | 'args'>,
): { tenantId: string; draftId: string } | null {
  if (params.model !== 'WsDraft') return null;
  if (!['update', 'updateMany', 'upsert'].includes(params.action)) return null;
  const args = params.args as { where?: { tenantId?: unknown; id?: unknown } } | undefined;
  const tenantId = args?.where?.tenantId;
  const draftId = args?.where?.id;
  return typeof tenantId === 'string' && typeof draftId === 'string'
    ? { tenantId, draftId }
    : null;
}
