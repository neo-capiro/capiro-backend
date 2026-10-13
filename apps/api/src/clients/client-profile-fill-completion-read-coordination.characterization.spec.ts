import { ADVOCACY_SOURCE_NAMES } from './client-profile-fill-advocacy-health.js';
import { CLIENT_PROFILE_FILL_SOURCES } from './client-profile-fill.helpers.js';
import {
  clientId,
  ctx,
  deferred,
  harness,
  installReadClock,
  now,
  schedule,
  sqlText,
  tenantId,
} from '../../test/fixtures/client-profile-fill-read-coordination.js';

installReadClock();

it('starts Workflow and schedule setup reads in parallel and preserves core fields plus seven tasks', async () => {
  const workflowRead = deferred<unknown>();
  const scheduleRead = deferred<ReturnType<typeof schedule>[]>();
  const h = harness({ setupRead: workflowRead.promise, scheduleRead: scheduleRead.promise });
  const read = h.setup();
  await h.started('schedule');
  expect(h.workflow.getSetup).toHaveBeenCalledWith(ctx, clientId);
  expect(h.callsOf('workflow')).toHaveLength(1);
  expect(h.callsOf('schedule')[0]!.args).toEqual([tenantId, clientId]);
  expect(sqlText(h.callsOf('schedule')[0]!.sql)).toContain(
    'WHERE tenant_id = $1::uuid AND client_id = $2::uuid',
  );
  const identity = { client: 'core-client' };
  const core = {
    taskPreview: ['Core one', 'Core two'],
    identity,
    arbitrary: 17,
    refreshSchedule: 'old',
  };
  const refreshSchedule = schedule();
  scheduleRead.resolve([refreshSchedule]);
  workflowRead.resolve(core);
  const result = await read;
  expect(result).toEqual({
    ...core,
    taskPreview: [
      'Core one',
      'Core two',
      'Federal Market',
      'Facilities',
      'District Nexus',
      'Advocacy History',
      'Lifecycle Outcomes',
      'Reconciliation',
      'Profile Completion',
    ],
    refreshSchedule,
  });
  expect((result as unknown as { identity: unknown }).identity).toBe(identity);
  expect(result.refreshSchedule).toBe(refreshSchedule);
  expect(result.taskPreview).not.toBe(core.taskPreview);
  expect(core.taskPreview).toEqual(['Core one', 'Core two']);
  expect(h.unexpected).not.toHaveBeenCalled();
});

it('propagates Workflow setup failure after starting the independent schedule read', async () => {
  const workflowRead = deferred<unknown>();
  const scheduleRead = deferred<ReturnType<typeof schedule>[]>();
  const h = harness({ setupRead: workflowRead.promise, scheduleRead: scheduleRead.promise });
  const error = new Error('workflow setup rejected');
  const rejection = expect(h.setup()).rejects.toBe(error);
  await h.started('schedule');
  workflowRead.reject(error);
  await rejection;
  scheduleRead.resolve([]);
  expect(h.callsOf('workflow')).toHaveLength(1);
  expect(h.callsOf('schedule')).toHaveLength(1);
});

it('propagates schedule setup failure while the independent Workflow read remains pending', async () => {
  const workflowRead = deferred<unknown>();
  const error = new Error('schedule setup rejected');
  const h = harness({ setupRead: workflowRead.promise, failure: 'schedule', error });
  await expect(h.setup()).rejects.toBe(error);
  expect(h.callsOf('workflow')).toHaveLength(1);
  expect(h.callsOf('schedule')).toHaveLength(1);
  workflowRead.resolve({ taskPreview: [] });
});

it('authorizes health through the user memory wall before any cursor, schedule or count I/O', async () => {
  const h = harness({ authReplies: [null] });
  await expect(h.health()).rejects.toThrow('Client not found');
  expect(h.prisma.withTenantUser).toHaveBeenCalledWith(tenantId, ctx.userId, expect.any(Function));
  expect(h.callsOf('client')[0]!.args).toEqual([
    {
      where: {
        id: clientId,
        tenantId,
        status: { not: 'archived' },
        OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: ctx.userId } } }],
      },
      select: { id: true },
    },
  ]);
  expect(h.calls.map((call) => call.operation)).toEqual(['auth-1', 'client', 'authorized-1']);
  expect(h.prisma.withTenant).not.toHaveBeenCalled();
  expect(h.unexpected).not.toHaveBeenCalled();
});

it('starts cursor and count reads while schedule repeats authorization and remains pending', async () => {
  const secondAuth = deferred<{ id: string } | null>();
  const cursorRead = deferred<Array<{ watermark: unknown }>>();
  const countsRead = deferred<Array<{ status: string; count: unknown }>>();
  const scheduleRead = deferred<ReturnType<typeof schedule>[]>();
  const h = harness({
    authReplies: [{ id: clientId }, secondAuth.promise],
    cursorRead: cursorRead.promise,
    countsRead: countsRead.promise,
    scheduleRead: scheduleRead.promise,
  });
  const read = h.health();
  await Promise.all([h.started('cursor'), h.started('counts'), h.started('auth-2')]);
  expect(h.callsOf('cursor')[0]!.args).toEqual([tenantId, clientId, 'advocacy_history']);
  expect(h.callsOf('counts')[0]!.args).toEqual([tenantId, clientId]);
  expect(h.callsOf('schedule')).toEqual([]);
  expect(h.callsOf('auth-2')[0]!.args).toEqual([tenantId, ctx.userId]);
  secondAuth.resolve({ id: clientId });
  await h.started('schedule');
  countsRead.resolve([{ status: 'pending', count: '2' }]);
  scheduleRead.resolve([schedule()]);
  cursorRead.resolve([]);
  const result = await read;
  expect(result.pendingFindings).toBe(2);
  expect(h.prisma.withTenantUser).toHaveBeenCalledTimes(2);
  expect(h.prisma.withTenant).toHaveBeenCalledTimes(3);
  const order = h.calls.map((call) => call.operation);
  expect(order.indexOf('authorized-1')).toBeLessThan(order.indexOf('cursor'));
  expect(order.indexOf('authorized-1')).toBeLessThan(order.indexOf('counts'));
  expect(order.indexOf('authorized-2')).toBeLessThan(order.indexOf('schedule'));
});

it('coerces canonical status counts and computes actual cadence, next date and source freshness', async () => {
  const lastSuccessAt = new Date(Date.parse(now) - 30 * 3_600_000).toISOString();
  const cursor = {
    refreshedAt: now,
    backfill: {
      sources: Object.fromEntries(
        ADVOCACY_SOURCE_NAMES.map((source) => [
          source,
          {
            status: 'complete',
            availability: 'available',
            lastSuccessAt,
            examined: '12',
            candidates: '3',
          },
        ]),
      ),
    },
  };
  const refreshSchedule = schedule();
  const h = harness({
    cursor,
    scheduleRows: [refreshSchedule],
    counts: [
      { status: 'pending', count: '4' },
      { status: 'accepted', count: 2n },
      { status: 'rejected', count: '3' },
      { status: 'pending', count: '5' },
      { status: 'informational', count: 99 },
    ],
  });
  const result = await h.health();
  expect(result).toMatchObject({
    overall: 'stale',
    refreshedAt: now,
    nextRefreshAt: '2026-10-14T12:00:00.000Z',
    pendingFindings: 5,
    acceptedFindings: 2,
    rejectedFindings: 3,
  });
  expect(result.sources.map((source) => source.source)).toEqual([...ADVOCACY_SOURCE_NAMES]);
  expect(
    result.sources.every(
      (source) =>
        source.status === 'complete' &&
        source.examined === 12 &&
        source.candidates === 3 &&
        source.nextRefreshAt === result.nextRefreshAt,
    ),
  ).toBe(true);
  expect(result.sources.find((source) => source.source === 'lda')?.freshness).toBe('stale');
  expect(result.sources.find((source) => source.source === 'fara')?.freshness).toBe('fresh');
  expect(result.sources.find((source) => source.source === 'community_funding')?.freshness).toBe(
    'fresh',
  );
  expect(sqlText(h.callsOf('counts')[0]!.sql)).toBe(
    "SELECT status, COUNT(*)::int AS count FROM client_profile_fill_finding WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND source = 'advocacy_history' AND kind = 'advocacy_record' AND status IN ('pending', 'accepted', 'rejected') GROUP BY status",
  );
  expect(h.callsOf('counts')[0]!.args).toEqual([tenantId, clientId]);
});

it('defaults missing cursor and counts to zero and uses the real 168-hour missing schedule cadence', async () => {
  const empty = harness();
  const first = await empty.health();
  expect(first).toMatchObject({
    overall: 'not_built',
    pendingFindings: 0,
    acceptedFindings: 0,
    rejectedFindings: 0,
  });
  expect(first.nextRefreshAt).toBeUndefined();
  expect(first.sources).toHaveLength(8);
  expect(
    first.sources.every(
      (source) => source.status === 'not_started' && source.freshness === 'unknown',
    ),
  ).toBe(true);
  const atBoundary = new Date(Date.parse(now) - 168 * 3_600_000).toISOString();
  const older = new Date(Date.parse(now) - 192 * 3_600_000).toISOString();
  const h = harness({
    cursor: {
      backfill: {
        sources: {
          lda: { status: 'complete', lastSuccessAt: atBoundary },
          fara: { status: 'complete', lastSuccessAt: older },
        },
      },
    },
  });
  const second = await h.health();
  expect(second.sources.find((source) => source.source === 'lda')?.freshness).toBe('fresh');
  expect(second.sources.find((source) => source.source === 'fara')?.freshness).toBe('fresh');
  expect(second.nextRefreshAt).toBeUndefined();
});

it.each(['cursor', 'schedule', 'counts'] as const)(
  'propagates %s health read failure while starting all authorized parallel reads',
  async (failure) => {
    const error = new Error(`${failure} unavailable`);
    const h = harness({ failure, error });
    await expect(h.health()).rejects.toBe(error);
    await h.started('schedule');
    expect(h.callsOf('cursor')).toHaveLength(1);
    expect(h.callsOf('schedule')).toHaveLength(1);
    expect(h.callsOf('counts')).toHaveLength(1);
    expect(h.prisma.withTenantUser).toHaveBeenCalledTimes(2);
    expect(h.unexpected).not.toHaveBeenCalled();
  },
);

it('keeps repeated schedule authorization denial separate from already-started cursor and count reads', async () => {
  const h = harness({ authReplies: [{ id: clientId }, null] });
  await expect(h.health()).rejects.toThrow('Client not found');
  expect(h.prisma.withTenantUser).toHaveBeenCalledTimes(2);
  expect(h.callsOf('cursor')).toHaveLength(1);
  expect(h.callsOf('counts')).toHaveLength(1);
  expect(h.callsOf('schedule')).toHaveLength(0);
  expect(h.prisma.withTenant).toHaveBeenCalledTimes(2);
});

it('returns the actual default schedule with the stable expanded setup task strings', async () => {
  const h = harness({ setup: { taskPreview: [], marker: 'unchanged' } });
  const result = await h.setup();
  expect(result.taskPreview).toEqual([
    'Federal Market',
    'Facilities',
    'District Nexus',
    'Advocacy History',
    'Lifecycle Outcomes',
    'Reconciliation',
    'Profile Completion',
  ]);
  expect(result).toMatchObject({
    marker: 'unchanged',
    refreshSchedule: {
      enabled: false,
      cadenceHours: 168,
      sources: [...CLIENT_PROFILE_FILL_SOURCES],
      nextRunAt: null,
      lastEnqueuedAt: null,
      updatedByUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  });
  expect(h.prisma.withTenantUser).toHaveBeenCalledTimes(1);
});
