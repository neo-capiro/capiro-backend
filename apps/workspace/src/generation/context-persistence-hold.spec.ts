import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';
import {
  assertContextPersistenceReleased,
  clearContextPersistenceHold,
  markContextPersistenceHold,
  runWithContextPersistenceBoundary,
  workspaceDraftWriteTarget,
} from './context-persistence-hold.js';

function middlewareParams(value: object): Prisma.MiddlewareParams {
  return value as unknown as Prisma.MiddlewareParams;
}

describe('Workspace context persistence hold', () => {
  const tenantId = 'tenant-1';
  const draftId = 'draft-1';

  it('holds and consumes the exact request after required packet persistence fails', async () => {
    await runWithContextPersistenceBoundary(tenantId, draftId, async () => {
      markContextPersistenceHold(tenantId, draftId, 'context_packet_error');

      expect(() => assertContextPersistenceReleased(tenantId, draftId)).toThrow(
        ServiceUnavailableException,
      );
      expect(() => assertContextPersistenceReleased(tenantId, draftId)).not.toThrow();
    });
  });

  it('never blocks a different tenant or draft', async () => {
    await runWithContextPersistenceBoundary(tenantId, draftId, async () => {
      markContextPersistenceHold(tenantId, draftId, 'context_packet_error');

      expect(() => assertContextPersistenceReleased(tenantId, 'draft-2')).not.toThrow();
      expect(() => assertContextPersistenceReleased('tenant-2', draftId)).not.toThrow();
      expect(() => assertContextPersistenceReleased(tenantId, draftId)).toThrow(
        ServiceUnavailableException,
      );
    });
  });

  it('isolates concurrent requests for the same tenant and draft', async () => {
    let releaseHeldRequest!: () => void;
    const waitForCleanRequest = new Promise<void>((resolve) => {
      releaseHeldRequest = resolve;
    });
    let heldMarked!: () => void;
    const waitForHeldMark = new Promise<void>((resolve) => {
      heldMarked = resolve;
    });

    const heldRequest = runWithContextPersistenceBoundary(tenantId, draftId, async () => {
      markContextPersistenceHold(tenantId, draftId, 'context_packet_error');
      heldMarked();
      await waitForCleanRequest;
      expect(() => assertContextPersistenceReleased(tenantId, draftId)).toThrow(
        ServiceUnavailableException,
      );
    });

    const cleanRequest = runWithContextPersistenceBoundary(tenantId, draftId, async () => {
      await waitForHeldMark;
      // This clear occurs after the other request marked its hold. Request-local
      // storage means it cannot clear the other request's failure state.
      clearContextPersistenceHold(tenantId, draftId);
      expect(() => assertContextPersistenceReleased(tenantId, draftId)).not.toThrow();
      releaseHeldRequest();
    });

    await Promise.all([heldRequest, cleanRequest]);
  });

  it('identifies only tenant-scoped ws_draft writes', () => {
    expect(
      workspaceDraftWriteTarget(
        middlewareParams({
          model: 'WsDraft',
          action: 'updateMany',
          args: { where: { tenantId, id: draftId } },
        }),
      ),
    ).toEqual({ tenantId, draftId });
    expect(
      workspaceDraftWriteTarget(
        middlewareParams({
          model: 'WsDraft',
          action: 'findFirst',
          args: { where: { tenantId, id: draftId } },
        }),
      ),
    ).toBeNull();
    expect(
      workspaceDraftWriteTarget(
        middlewareParams({
          model: 'WsSection',
          action: 'updateMany',
          args: { where: { tenantId, id: draftId } },
        }),
      ),
    ).toBeNull();
  });
});
