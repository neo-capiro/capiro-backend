import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';
import {
  assertContextPersistenceReleased,
  clearContextPersistenceHold,
  markContextPersistenceHold,
  workspaceDraftWriteTarget,
} from './context-persistence-hold.js';

describe('Workspace context persistence hold', () => {
  const tenantId = 'tenant-1';
  const draftId = 'draft-1';

  afterEach(() => clearContextPersistenceHold(tenantId, draftId));

  it('holds and consumes the exact draft after required packet persistence fails', () => {
    markContextPersistenceHold(tenantId, draftId, 'context_packet_error');

    expect(() => assertContextPersistenceReleased(tenantId, draftId)).toThrow(
      ServiceUnavailableException,
    );
    // The hold is one-shot; a later clean compile starts from a cleared state.
    expect(() => assertContextPersistenceReleased(tenantId, draftId)).not.toThrow();
  });

  it('never blocks a different tenant or draft', () => {
    markContextPersistenceHold(tenantId, draftId, 'context_packet_error');

    expect(() => assertContextPersistenceReleased(tenantId, 'draft-2')).not.toThrow();
    expect(() => assertContextPersistenceReleased('tenant-2', draftId)).not.toThrow();
  });

  it('identifies only tenant-scoped ws_draft writes', () => {
    expect(
      workspaceDraftWriteTarget({
        model: 'WsDraft',
        action: 'updateMany',
        args: { where: { tenantId, id: draftId } },
      } as Prisma.MiddlewareParams),
    ).toEqual({ tenantId, draftId });
    expect(
      workspaceDraftWriteTarget({
        model: 'WsDraft',
        action: 'findFirst',
        args: { where: { tenantId, id: draftId } },
      } as Prisma.MiddlewareParams),
    ).toBeNull();
    expect(
      workspaceDraftWriteTarget({
        model: 'WsSection',
        action: 'updateMany',
        args: { where: { tenantId, id: draftId } },
      } as Prisma.MiddlewareParams),
    ).toBeNull();
  });
});
