import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { MeriContextPlaneService } from '../meri-context-plane.service.js';
import { ContextPlaneRecallPort } from './meri-hermes-recall.ports.js';

function record(recordId: string, clientId: string | null) {
  return {
    domain: 'institutional_knowledge',
    recordId,
    payload: {
      key: recordId,
      scope: clientId ? 'client' : 'firm',
      clientId,
      value: `value-${recordId}`,
    },
    provenance: {},
    updatedAt: new Date('2026-09-20T12:00:00.000Z'),
  };
}

describe('ContextPlaneRecallPort authorization-envelope ceiling', () => {
  const ctx: TenantContext = {
    tenantId: randomUUID(),
    tenantSlug: 'recall-envelope-spec',
    userId: randomUUID(),
    clerkUserId: randomUUID(),
    role: 'standard_user',
  };

  test('refuses an explicitly requested client outside the run envelope even when Context Plane would authorize it', async () => {
    const outsideClientId = randomUUID();
    const searchToolData = jest.fn().mockResolvedValue({
      records: [record('outside-record', outsideClientId)],
      coverage: {
        complete: true,
        sources: [{ sourceStatus: 'healthy', total: 1, stopReason: 'complete' }],
      },
    });
    const port = new ContextPlaneRecallPort({ searchToolData } as unknown as MeriContextPlaneService);

    let caught: unknown;
    try {
      await port.recall(ctx, {
        query: 'outside',
        clientId: outsideClientId,
        limit: 10,
        authorizedClientIds: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 404 });
    expect(searchToolData).not.toHaveBeenCalled();
  });

  test('post-filters an unscoped Context Plane response to the run envelope without dropping firm-scope rows', async () => {
    const allowedClientId = randomUUID();
    const outsideClientId = randomUUID();
    const searchToolData = jest.fn().mockResolvedValue({
      records: [
        record('allowed-record', allowedClientId),
        record('outside-record', outsideClientId),
        record('firm-record', null),
      ],
      coverage: {
        complete: true,
        sources: [{ sourceStatus: 'healthy', total: 3, stopReason: 'complete' }],
      },
    });
    const port = new ContextPlaneRecallPort({ searchToolData } as unknown as MeriContextPlaneService);

    const result = await port.recall(ctx, {
      query: 'record',
      limit: 10,
      authorizedClientIds: [allowedClientId],
    });

    expect(result.items.map((item) => item.sourceId)).toEqual(['allowed-record', 'firm-record']);
    expect(result.items.map((item) => item.clientId)).toEqual([allowedClientId, null]);
    expect(result.coverage.returned).toBe(2);
    expect(result.coverage.total).toBe(2);
  });
});
