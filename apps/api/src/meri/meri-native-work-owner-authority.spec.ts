import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../engagement/engagement.service';
import { ActionRecommendationReadService } from '../intelligence/actions/action-recommendation-read.service';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

function taskRow(
  updatedAt = new Date('2026-09-21T00:00:00.000Z'),
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'task-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    meetingId: null,
    contactId: null,
    mailThreadId: null,
    title: 'Demo follow-up',
    description: 'Send demo',
    ownerUserId: null,
    dueDate: null,
    status: 'todo',
    sourceType: 'meeting',
    sourceId: 'm-1',
    createdByUserId: 'user-1',
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    updatedAt,
    client: { id: 'client-1', name: 'Aster' },
    meeting: null,
    ...overrides,
  };
}

function actionRow(updatedAt = new Date('2026-09-21T00:00:00.000Z')) {
  return {
    id: 'action-1',
    districtKey: null,
    clientId: 'client-1',
    peCode: null,
    programId: null,
    deltaId: null,
    actionType: 'monitor',
    issueTitle: 'Review change',
    whatChanged: 'Changed',
    whyItMatters: 'Impact',
    recommendedAction: 'Review',
    targetAudience: [],
    suggestedArtifactType: null,
    deadline: null,
    deadlineSource: null,
    ownerUserId: null,
    priority: 1,
    confidence: {},
    uncertainty: null,
    evidence: [] as Array<Record<string, unknown>>,
    status: 'new',
    dismissalReason: null,
    outcome: null,
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    updatedAt,
    client: { name: 'Aster' },
  };
}

function meetingRow() {
  return {
    id: 'meeting-1',
    clientId: 'client-1',
    subject: 'Aster review',
    isInternal: false,
    visibility: 'private',
    status: 'scheduled',
    updatedAt: new Date('2026-09-21T00:00:00.000Z'),
  };
}

function sourceDocumentRow() {
  return {
    id: 'document-1',
    sourceKey: 'public-r2',
    fiscalYear: 2027,
    budgetCycle: 'pb',
    component: 'AF',
    documentType: 'r2',
    title: 'Public R-2',
    sourceUrl: 'https://example.gov/r2.pdf',
    sha256: 'a'.repeat(64),
    extractionMethod: 'deterministic_pdf',
    extractionToolVersion: '1',
    ingestedAt: new Date('2026-09-20T00:00:00.000Z'),
    supersededByDocumentId: null,
  };
}

describe('native work canonical owner authorization', () => {
  it('checks the current client/wall before task query and after each awaited row', async () => {
    const row = taskRow();
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: false }]),
      engagementTask: {
        findMany: jest.fn().mockResolvedValue([row]),
        findFirst: jest.fn().mockResolvedValue(row),
        count: jest.fn().mockResolvedValue(1),
      },
      meeting: { findFirst: jest.fn() },
    };
    const service = Object.assign(Object.create(EngagementService.prototype), {
      prisma: {
        withTenant: jest.fn(async (_tenant: string, fn: (arg: typeof tx) => unknown) => fn(tx)),
      },
    }) as EngagementService;
    const query = {
      clientId: 'client-1',
      taskId: null,
      status: null,
      openOnly: false,
      dueBefore: null,
      offset: 0,
      limit: 20,
    } as any;
    await expect(service.readMeriTasksExact(ctx, query)).rejects.toThrow('Client not found');
    expect(tx.engagementTask.findMany).not.toHaveBeenCalled();

    tx.$queryRawUnsafe.mockResolvedValue([{ allowed: true }]);
    tx.engagementTask.findFirst.mockResolvedValue(taskRow(new Date('2026-09-22T00:00:00.000Z')));
    await expect(service.readMeriTasksExact(ctx, query)).resolves.toMatchObject({
      sourceStatus: 'degraded',
      sourceReason: 'task_source_changed_during_read',
      rows: [{ updatedAt: new Date('2026-09-22T00:00:00.000Z') }],
    });
    expect(tx.$queryRawUnsafe.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('checks archived/wall authority around action reads and reports a mid-read source edit', async () => {
    const row = actionRow();
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
      actionRecommendation: {
        findMany: jest.fn().mockResolvedValue([row]),
        findFirst: jest.fn().mockResolvedValue(actionRow(new Date('2026-09-22T00:00:00.000Z'))),
        count: jest.fn().mockResolvedValue(1),
      },
      sourceDocument: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ActionRecommendationReadService({
      withTenant: jest.fn(async (_tenant: string, fn: (arg: typeof tx) => unknown) => fn(tx)),
    } as never);
    await expect(
      service.readMeriActionItemsExact(ctx, {
        clientId: 'client-1',
        actionItemId: null,
        page: 1,
        limit: 20,
      }),
    ).resolves.toMatchObject({
      sourceStatus: 'degraded',
      sourceReason: 'action_item_source_changed_during_read',
      data: [{ updatedAt: '2026-09-22T00:00:00.000Z' }],
    });

    tx.client.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.readMeriActionItemsExact(ctx, {
        clientId: 'client-1',
        actionItemId: null,
        page: 1,
        limit: 20,
      }),
    ).rejects.toThrow('Client not found');
    expect(tx.actionRecommendation.findMany).toHaveBeenCalledTimes(1);
  });

  it('includes canceled tasks when no status subset was requested', async () => {
    const row = taskRow(undefined, { status: 'canceled' });
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
      engagementTask: {
        findMany: jest.fn().mockResolvedValue([row]),
        findFirst: jest.fn().mockResolvedValue(row),
        count: jest.fn().mockResolvedValue(1),
      },
      meeting: { findFirst: jest.fn() },
    };
    const service = Object.assign(Object.create(EngagementService.prototype), {
      prisma: {
        withTenant: jest.fn(async (_tenant: string, fn: (arg: typeof tx) => unknown) => fn(tx)),
      },
    }) as EngagementService;
    await expect(
      service.readMeriTasksExact(ctx, {
        clientId: 'client-1',
        taskId: null,
        status: null,
        openOnly: false,
        dueBefore: null,
        offset: 0,
        limit: 20,
      }),
    ).resolves.toMatchObject({ rows: [{ status: 'canceled' }], sourceStatus: 'healthy' });
    expect(tx.engagementTask.findMany.mock.calls[0]![0].where).not.toHaveProperty('status');
  });

  it('requires current same-client actor-owned meeting authority before and after await', async () => {
    const row = taskRow(undefined, { meetingId: 'meeting-1', sourceId: 'meeting-1' });
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
      engagementTask: {
        findMany: jest.fn().mockResolvedValue([row]),
        findFirst: jest.fn().mockResolvedValue(row),
        count: jest.fn().mockResolvedValue(1),
      },
      meeting: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = Object.assign(Object.create(EngagementService.prototype), {
      prisma: {
        withTenant: jest.fn(async (_tenant: string, fn: (arg: typeof tx) => unknown) => fn(tx)),
      },
    }) as EngagementService;
    const query = {
      clientId: 'client-1',
      taskId: null,
      status: null,
      openOnly: false,
      dueBefore: null,
      offset: 0,
      limit: 20,
    } as any;
    await expect(service.readMeriTasksExact(ctx, query)).resolves.toMatchObject({
      sourceStatus: 'degraded',
      rows: [{ meetingId: null, meeting: null, sourceId: null }],
    });
    expect(tx.meeting.findFirst.mock.calls[0]![0].where).toMatchObject({
      clientId: 'client-1',
      isInternal: false,
      OR: [{ createdByUserId: 'user-1' }, { connection: { createdByUserId: 'user-1' } }],
    });

    tx.meeting.findFirst.mockResolvedValue(meetingRow());
    await expect(service.readMeriTasksExact(ctx, query)).resolves.toMatchObject({
      sourceStatus: 'healthy',
      rows: [{ linkedSourceProofs: [{ owner: 'meetings', sourceRecordId: 'meeting-1' }] }],
    });
    tx.meeting.findFirst
      .mockReset()
      .mockResolvedValueOnce(meetingRow())
      .mockResolvedValueOnce(null);
    await expect(service.readMeriTasksExact(ctx, query)).resolves.toMatchObject({
      sourceStatus: 'degraded',
      rows: [{ meetingId: null, meeting: null, sourceId: null }],
    });
  });

  it('omits unowned source JSON and binds an authorized current source', async () => {
    const row = actionRow();
    row.evidence = [{ kind: 'source', sourceDocumentId: 'document-1', page: 4 }];
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
      actionRecommendation: {
        findMany: jest.fn().mockResolvedValue([row]),
        findFirst: jest.fn().mockResolvedValue(row),
        count: jest.fn().mockResolvedValue(1),
      },
      sourceDocument: { findMany: jest.fn().mockResolvedValue([sourceDocumentRow()]) },
    };
    const service = new ActionRecommendationReadService({
      withTenant: jest.fn(async (_tenant: string, fn: (arg: typeof tx) => unknown) => fn(tx)),
    } as never);
    const query = { clientId: 'client-1', actionItemId: null, page: 1, limit: 20 };
    await expect(service.readMeriActionItemsExact(ctx, query)).resolves.toMatchObject({
      sourceStatus: 'healthy',
      data: [
        {
          evidence: [{ kind: 'source', sourceDocumentId: 'document-1', page: 4 }],
          linkedSourceProofs: [{ owner: 'source_document', sourceRecordId: 'document-1' }],
        },
      ],
    });
    expect(tx.sourceDocument.findMany).toHaveBeenCalledTimes(2);

    row.evidence = [{ kind: 'source', sourceDocumentId: 'bluehaven', note: 'private note' }];
    tx.sourceDocument.findMany.mockResolvedValue([]);
    await expect(service.readMeriActionItemsExact(ctx, query)).resolves.toMatchObject({
      sourceStatus: 'degraded',
      data: [{ evidence: [], linkedSourceProofs: [] }],
    });
  });

  it('omits a source deleted after the first source-authority await', async () => {
    const row = actionRow();
    row.evidence = [{ kind: 'source', sourceDocumentId: 'document-1' }];
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
      actionRecommendation: {
        findMany: jest.fn().mockResolvedValue([row]),
        findFirst: jest.fn().mockResolvedValue(row),
        count: jest.fn().mockResolvedValue(1),
      },
      sourceDocument: {
        findMany: jest.fn().mockResolvedValueOnce([sourceDocumentRow()]).mockResolvedValueOnce([]),
      },
    };
    const service = new ActionRecommendationReadService({
      withTenant: jest.fn(async (_tenant: string, fn: (arg: typeof tx) => unknown) => fn(tx)),
    } as never);
    await expect(
      service.readMeriActionItemsExact(ctx, {
        clientId: 'client-1',
        actionItemId: null,
        page: 1,
        limit: 20,
      }),
    ).resolves.toMatchObject({
      sourceStatus: 'degraded',
      data: [{ evidence: [], linkedSourceProofs: [] }],
    });
  });
});
