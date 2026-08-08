import type { AuthorizedCapabilityContext } from './capability-context.js';
import { GetClientContextCapability } from './clients/get-client-context.capability.js';
import { GetRecentActivityCapability } from './activity/get-recent-activity.capability.js';
import { GetCapiroRecordCapability } from './records/get-capiro-record.capability.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorUserId = '00000000-0000-4000-8000-000000000002';
const clientId = '00000000-0000-4000-8000-000000000003';
const recordId = '00000000-0000-4000-8000-000000000004';

function context(overrides: Partial<AuthorizedCapabilityContext> = {}): AuthorizedCapabilityContext {
  return {
    actorUserId,
    tenantId,
    role: 'standard_user',
    requestId: 'request-1',
    surface: 'outreach',
    clientScope: null,
    ...overrides,
  };
}

function prismaFor(tx: Record<string, unknown>) {
  return {
    withTenantUser: jest.fn(
      async (
        _tenantId: string,
        _userId: string,
        run: (transaction: Record<string, unknown>) => Promise<unknown>,
      ) => run(tx),
    ),
  };
}

describe('Phase 1 proof capabilities', () => {
  it('get_capiro_record refuses record types outside the strict allowlist', () => {
    const service = new GetCapiroRecordCapability({} as never, {} as never);
    expect(() =>
      service.definition().inputSchema.parse({ recordType: 'memory_item', recordId }),
    ).toThrow('record type is not allowed');
  });

  it('get_capiro_record cannot widen a client-scoped turn to a tenant-wide task', async () => {
    const tx = {
      engagementTask: {
        findFirst: jest.fn().mockResolvedValue({
          id: recordId,
          clientId: null,
          title: 'Tenant task',
          description: null,
          status: 'todo',
          dueDate: null,
          updatedAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
      },
    };
    const authorization = { authorizeClient: jest.fn() };
    const service = new GetCapiroRecordCapability(
      prismaFor(tx) as never,
      authorization as never,
    );

    await expect(
      service.execute(
        context({ clientScope: { clientId, reason: 'campaign' } }),
        { recordType: 'engagement_task', recordId },
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_INVALID_SCOPE' });
    expect(authorization.authorizeClient).not.toHaveBeenCalled();
  });

  it('get_client_context returns bounded metadata and never unrestricted memory bodies', async () => {
    const client = {
      id: clientId,
      name: 'Client',
      website: null,
      description: 'Profile',
      sectorTag: 'defense',
      status: 'active',
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const tx = {
      clientCapability: {
        findMany: jest.fn().mockResolvedValue([{ id: recordId, name: 'Product', type: 'product' }]),
      },
      meeting: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '00000000-0000-4000-8000-000000000005',
            subject: 'Meeting',
            startsAt: new Date('2026-08-03T10:00:00.000Z'),
            endsAt: new Date('2026-08-03T11:00:00.000Z'),
            status: 'confirmed',
            updatedAt: new Date('2026-08-03T11:00:00.000Z'),
          },
        ]),
      },
      engagementTask: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '00000000-0000-4000-8000-000000000006',
            title: 'Follow up',
            status: 'todo',
            dueDate: new Date('2026-08-10T00:00:00.000Z'),
            updatedAt: new Date('2026-08-04T00:00:00.000Z'),
          },
        ]),
      },
    };
    const service = new GetClientContextCapability(
      prismaFor(tx) as never,
      { authorizeClient: jest.fn().mockResolvedValue(client) } as never,
    );

    const result = await service.execute(context(), { clientId });

    expect(result.data.memoryReferences).toEqual([]);
    expect(result.data.capabilities).toHaveLength(1);
    expect(result.data.recentMeetings).toHaveLength(1);
    expect(result.data.openCommitments).toHaveLength(1);
    expect(JSON.stringify(result.data)).not.toContain('memory body');
    expect(result.scope).toEqual({ tenantId, clientId });
    expect(result.provenance.map((entry) => entry.recordType)).toEqual([
      'client',
      'client_capability',
      'meeting',
      'engagement_task',
    ]);
  });

  it('get_recent_activity orders deterministically and reports truncation', async () => {
    const sameTime = new Date('2026-08-03T10:00:00.000Z');
    const tx = {
      meeting: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '00000000-0000-4000-8000-000000000005',
            subject: 'Meeting',
            startsAt: sameTime,
            status: 'confirmed',
            updatedAt: sameTime,
          },
        ]),
      },
      engagementTask: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '00000000-0000-4000-8000-000000000006',
            title: 'Task',
            status: 'todo',
            updatedAt: sameTime,
          },
        ]),
      },
    };
    const service = new GetRecentActivityCapability(
      prismaFor(tx) as never,
      { authorizeClient: jest.fn().mockResolvedValue({ id: clientId }) } as never,
    );

    const result = await service.execute(context(), { clientId, limit: 1 });

    expect(result.data.items).toEqual([
      expect.objectContaining({ recordType: 'engagement_task', title: 'Task' }),
    ]);
    expect(result.data.totalReturned).toBe(1);
    expect(result.data.truncated).toBe(true);
  });
});
