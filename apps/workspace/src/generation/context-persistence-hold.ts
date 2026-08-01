import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';

interface PersistenceHold {
  errorCode: string;
}

interface PersistenceBoundary {
  tenantId: string;
  draftId: string;
  hold: PersistenceHold | null;
}

const boundaries = new AsyncLocalStorage<PersistenceBoundary>();

/**
 * Run one generation request inside its own persistence boundary.
 *
 * The previous process-global tenant:draft map allowed two concurrent requests
 * for the same draft to clear or consume each other's hold. Async-local state is
 * inherited only by this request's awaited compiler, provider, and Prisma work.
 */
export function runWithContextPersistenceBoundary<T>(
  tenantId: string,
  draftId: string,
  work: () => T,
): T {
  return boundaries.run({ tenantId, draftId, hold: null }, work);
}

function activeBoundary(tenantId: string, draftId: string): PersistenceBoundary | null {
  const boundary = boundaries.getStore();
  if (!boundary) return null;
  if (boundary.tenantId !== tenantId || boundary.draftId !== draftId) return null;
  return boundary;
}

/** Start a new compile attempt without inheriting an earlier attempt's hold. */
export function clearContextPersistenceHold(tenantId: string, draftId: string): void {
  const boundary = activeBoundary(tenantId, draftId);
  if (boundary) boundary.hold = null;
}

/** Record only bounded identity and reason-code metadata. */
export function markContextPersistenceHold(
  tenantId: string,
  draftId: string,
  errorCode: string,
): void {
  const boundary = activeBoundary(tenantId, draftId);
  if (!boundary) return;
  boundary.hold = { errorCode: errorCode.slice(0, 80) };
}

export function consumeContextPersistenceHold(
  tenantId: string,
  draftId: string,
): PersistenceHold | null {
  const boundary = activeBoundary(tenantId, draftId);
  if (!boundary?.hold) return null;
  const hold = boundary.hold;
  boundary.hold = null;
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
  return typeof tenantId === 'string' && typeof draftId === 'string' ? { tenantId, draftId } : null;
}
