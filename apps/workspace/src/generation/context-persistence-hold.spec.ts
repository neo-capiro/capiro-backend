import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';
import {
  assertContextPersistenceReleased,
  clearContextPersistenceHold,
  markContextPersistenceHold,
  workspaceDraftWriteTarget,
} from './context-persistence-hold.js';

function middlewareParams(value: object): Prisma.MiddlewareParams {
  return value as unknown as Prisma.MiddlewareParams;
}

describe('Workspace context persistence hold', () => {
  const tenantId = 'tenant-1';
  const draftId = 'draft-1';

  afterEach(() => clearContextPersistenceHold(tenantId, draftId));

  it('holds and consumes the exact draft after required packet persistence fails', () => {
    markContextPersistenceHold(tenantId, draftId, 'context_packet_error');

    expect(() => assertContextPersistenceReleased(tenantId, draftId)).toThrow(
      ServiceUnavailableException,
    );
    expect(() => assertContextPersistenceReleased(tenantId, draftId)).not.toThrow();
  });

  it('never blocks a different tenant or draft', () => {
    markContextPersistenceHold(tenantId, draftId, 'context_packet_error');

    expect(() => assertContextPersistenceReleased(tenantId, 'draft-2')).not.toThrow();
    expect(() => assertContextPersistenceReleased('tenant-2', draftId)).not.toThrow();
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
