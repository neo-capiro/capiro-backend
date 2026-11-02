import { readTrackerMaterialChanges, TrackerMetricsError, type TrackerMetricsBackend } from '@capiro/shared';
import { TrackerService } from './tracker.service.js';
import { TrackerController } from './tracker.controller.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const now = Date.parse('2026-10-31T12:00:00Z'), clientId = id(3);
const actor = { tenantId: id(1), userId: id(2), clerkUserId: 'synthetic-clerk', role: 'standard_user' } as any;
function fixture() {
  const state = { member: true, wall: true, revision: 1, count: '175', unsupported: '0', sourceAt: new Date(now - 1000) as Date | null,
    onAggregate: () => {}, cleaned: false, sql: '' };
  const tx = {
    $executeRawUnsafe: jest.fn(async () => 1),
    $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
      if (sql.includes('FROM tenants t')) {
        expect(values).toEqual([actor.tenantId, clientId, actor.clerkUserId, actor.userId]);
        expect(sql).toContain("m.status::text='active'"); expect(sql).toContain("c.status::text<>'archived'");
        return state.member ? [{ userId: actor.userId, memberId: id(4), role: 'standard_user', memberUpdatedAt: state.revision, clientUpdatedAt: 1 }] : [];
      }
      if (sql.includes('AS allowed')) {
        expect(values).toEqual([actor.tenantId, clientId, actor.userId]); return [{ allowed: state.wall }];
      }
      state.sql = sql;
      expect(values).toEqual([actor.tenantId, clientId, new Date(now - 21 * 86400000).toISOString(), new Date(now).toISOString()]);
      state.onAggregate(); return [{ count: state.count, unsupported: state.unsupported, sourceObservedAt: state.sourceAt }];
    }),
  };
  const database: any = { withTenant: jest.fn(async (tenant: string, read: any, options: any) => {
    expect(tenant).toBe(actor.tenantId); expect(options.timeoutMs).toBeGreaterThan(0); expect(options.timeoutMs).toBeLessThanOrEqual(10000);
    try { return await read(tx); } finally { state.cleaned = true; }
  }) };
  const run = (backend: TrackerMetricsBackend = 'core', query: unknown = {}) => readTrackerMaterialChanges(database, actor, clientId, backend, query, () => now);
  return { state, tx, database, run };
}

test.each(['core', 'intelligence'] as const)('%s returns a producer full count beyond the loaded page with exact21-day bounds', async backend => {
  const f = fixture();
  await expect(f.run(backend)).resolves.toEqual({ metric: 'tracker.material_changes', version: 1, backend, clientId,
    window: { start: new Date(now - 21 * 86400000).toISOString(), end: new Date(now).toISOString(), days: 21, bounds: '[start,end)' },
    asOf: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), sourceObservedAt: new Date(now - 1000).toISOString(),
    count: 175, complete: true, capped: false });
  expect(f.state.sql).not.toMatch(/\bLIMIT\b|\bunread\b|status\s*=/i);
  expect(f.state.sql).toContain('SELECT DISTINCT bill_id'); expect(f.state.sql).toContain('GROUP BY');
  expect(f.state.sql).toContain('>= $3::timestamptz'); expect(f.state.sql).toContain('< $4::timestamptz');
  if (backend === 'core') {
    expect(f.state.sql).toContain('FROM tracked_bill WHERE tenant_id=$1::uuid AND client_id=$2::uuid');
    expect(f.state.sql).toContain('ANY(c.related_client_ids)'); expect(f.state.sql).not.toContain('intel_alert');
  } else {
    expect(f.state.sql).toContain("t.source='congress' AND a.source_type='bill'");
    expect(f.state.sql).toContain("t.source='state' AND a.source_type='state_bill'");
    expect(f.state.sql).toContain('a.tenant_id=$1 AND a.client_id=$2'); expect(f.state.sql).not.toContain('intelligence_change');
  }
  expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(5); expect(f.tx.$executeRawUnsafe).toHaveBeenCalledTimes(5);
  expect(f.state.cleaned).toBe(true);
});

test('complete empty evidence is zero with an explicit absent source-observation time', async () => {
  const f = fixture(); f.state.count = '0'; f.state.sourceAt = null;
  await expect(f.run()).resolves.toMatchObject({ count: 0, sourceObservedAt: null, complete: true });
});
test.each(['before-member', 'before-wall', 'after-member', 'after-wall', 'revision'])(
  '%s access change withholds the aggregate and never falls back to another backend', async change => {
    const f = fixture();
    if (change === 'before-member') f.state.member = false;
    if (change === 'before-wall') f.state.wall = false;
    f.state.onAggregate = () => {
      if (change === 'after-member') f.state.member = false;
      if (change === 'after-wall') f.state.wall = false;
      if (change === 'revision') f.state.revision++;
    };
    await expect(f.run()).rejects.toBeInstanceOf(TrackerMetricsError);
    expect(f.database.withTenant).toHaveBeenCalledTimes(1); expect(f.state.cleaned).toBe(true);
    if (change.startsWith('before')) expect(f.state.sql).toBe('');
  },
);
test.each(['core', 'intelligence'] as const)('%s refuses unsupported tracked sources instead of publishing a partial count', async backend => {
  const f = fixture(); f.state.unsupported = '1'; await expect(f.run(backend)).rejects.toMatchObject({ reason: 'unsupported_bill_source' });
});
test.each(['-1', '1.5', '9007199254740992', 'NaN'])('unsafe aggregate %s refuses', async count => {
  const f = fixture(); f.state.count = count; await expect(f.run()).rejects.toMatchObject({ reason: 'invalid_aggregate' });
});
test.each([null, [], { days: 7 }, { clientId: id(99) }])('rejects noncanonical query %p before SQL', async query => {
  const f = fixture(); await expect(f.run('core', query)).rejects.toMatchObject({ reason: 'invalid_request' });
  expect(f.database.withTenant).not.toHaveBeenCalled();
});
test('data-source failure and late execution cannot publish zero', async () => {
  const f = fixture(); f.tx.$queryRawUnsafe.mockRejectedValue(Error('synthetic database unavailable'));
  await expect(f.run()).rejects.toMatchObject({ reason: 'source_unavailable' }); expect(f.state.cleaned).toBe(true);
  let at = now; const late = fixture(); late.state.onAggregate = () => { at += 10000; };
  await expect(readTrackerMaterialChanges(late.database, actor, clientId, 'core', {}, () => at)).rejects.toMatchObject({ reason: 'deadline' });
});
test('Core mounted service/controller forwards full authenticated context and preserves errors', async () => {
  const f = fixture(), service = new TrackerService(f.database, {} as any), controller = new TrackerController(service, {} as any, {} as any);
  // Use a fixed clock only for this source fixture; the route owns no client time input.
  jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
    await expect(controller.materialChanges(actor, clientId, {})).resolves.toMatchObject({ backend: 'core', count: 175 });
    f.state.wall = false; await expect(controller.materialChanges(actor, clientId, {})).rejects.toMatchObject({ status: 404 });
    await expect(controller.materialChanges(actor, clientId, { days: 1 })).rejects.toMatchObject({ status: 400 });
    f.state.wall = true; f.state.unsupported = '1';
    await expect(controller.materialChanges(actor, clientId, {})).rejects.toMatchObject({ status: 503 });
    expect(Reflect.getMetadata('path', TrackerController.prototype.materialChanges)).toBe('clients/:clientId/tracker/material-changes');
    expect(Reflect.getMetadata('__headers__', TrackerController.prototype.materialChanges)).toEqual([{ name: 'Cache-Control', value: 'private, no-store' }]);
  } finally { jest.restoreAllMocks(); }
});

test.each(['core', 'intelligence'] as const)('%s applies the remaining statement budget and awaits rollback after cancellation', async backend => {
  jest.useFakeTimers({ now });
  let releaseRollback!: () => void;
  const rollback = new Promise<void>(resolve => { releaseRollback = resolve; });
  let enteredCount!: () => void;
  const countEntered = new Promise<void>(resolve => { enteredCount = resolve; });
  let budget = 0, active = 0, observations = 0, settled = false;
  const settings: number[] = [];
  const tx = {
    $executeRawUnsafe: jest.fn(async (_sql: string, setting: string) => {
      budget = Number.parseInt(setting, 10); settings.push(budget); return 1;
    }),
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('FROM tenants t')) {
        observations++; await jest.advanceTimersByTimeAsync(6000);
        return [{ userId: actor.userId, memberId: id(4), role: 'standard_user', memberUpdatedAt: 1, clientUpdatedAt: 1 }];
      }
      if (sql.includes('AS allowed')) return [{ allowed: true }];
      active++; enteredCount();
      return new Promise((_, reject) => setTimeout(() => { active--; reject(Error('statement timeout')); }, budget));
    }),
  };
  const database: any = { withTenant: jest.fn(async (_tenant: string, read: any, options: any) => {
    expect(options.timeoutMs).toBe(10000);
    try { return await read(tx); } finally { await rollback; }
  }) };
  const result = readTrackerMaterialChanges(database, actor, clientId, backend).then(
    value => { settled = true; return value; }, error => { settled = true; return error; },
  );
  try {
    await countEntered;
    expect(settings).toEqual([10000, 4000, 4000]); expect(active).toBe(1);
    await jest.advanceTimersByTimeAsync(4000);
    expect(active).toBe(0); expect(settled).toBe(false); expect(observations).toBe(1);
    releaseRollback();
    expect(await result).toMatchObject({ reason: 'deadline' });
    expect(settled).toBe(true); expect(jest.getTimerCount()).toBe(0);
  } finally { releaseRollback(); jest.useRealTimers(); }
});
