import type {
  RefreshScheduleRow,
  UpdateClientProfileFillScheduleInput,
} from './client-profile-fill-completion.service.js';
import {
  fixture,
  ctx,
  clientId,
  sources,
  dueRow,
  type Due,
} from '../../test/fixtures/client-profile-fill-refresh-schedule.js';

const sqlText = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const readSql = `SELECT enabled, cadence_hours AS "cadenceHours", sources,
  next_run_at AS "nextRunAt", last_enqueued_at AS "lastEnqueuedAt",
  updated_by_user_id AS "updatedByUserId", created_at AS "createdAt", updated_at AS "updatedAt"
  FROM client_profile_fill_schedule WHERE tenant_id = $1::uuid AND client_id = $2::uuid`;
const editSql = `INSERT INTO client_profile_fill_schedule
  (tenant_id, client_id, enabled, cadence_hours, sources, next_run_at, updated_by_user_id, updated_at)
  VALUES ( $1::uuid, $2::uuid, $3, $4, ARRAY(SELECT jsonb_array_elements_text($5::jsonb)),
    CASE WHEN $3 THEN now() + make_interval(hours => $4) ELSE NULL END, $6::uuid, now() )
  ON CONFLICT (tenant_id, client_id) DO UPDATE SET enabled = EXCLUDED.enabled,
    cadence_hours = EXCLUDED.cadence_hours, sources = EXCLUDED.sources,
    next_run_at = CASE WHEN EXCLUDED.enabled THEN now() + make_interval(hours => EXCLUDED.cadence_hours)
      ELSE NULL END, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`;
const claimSql = `WITH due AS ( SELECT tenant_id, client_id FROM client_profile_fill_schedule
  WHERE enabled = true AND next_run_at <= now() ORDER BY next_run_at ASC LIMIT 5 FOR UPDATE SKIP LOCKED )
  UPDATE client_profile_fill_schedule schedule
    SET next_run_at = now() + make_interval(hours => schedule.cadence_hours), updated_at = now()
  FROM due WHERE schedule.tenant_id = due.tenant_id AND schedule.client_id = due.client_id
  RETURNING schedule.tenant_id AS "tenantId", schedule.client_id AS "clientId",
    schedule.updated_by_user_id AS "userId", schedule.sources, schedule.cadence_hours AS "cadenceHours"`;
const bumpSql = `UPDATE client_profile_fill_schedule
  SET next_run_at = now() + make_interval(hours => $3),
    last_enqueued_at = CASE WHEN $4 THEN now() ELSE last_enqueued_at END, updated_at = now()
  WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND enabled = true`;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-13T12:00:00Z'));
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider calls forbidden'));
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('Authorized refresh schedule reads', () => {
  it('checks the actual governed user predicate before the exact tenant read', async () => {
    const h = fixture();
    await h.service.getSchedule(ctx, clientId);
    expect(h.calls.map((entry) => entry.kind)).toEqual(['auth', 'read']);
    expect(h.callsOf('auth')[0]!.args).toEqual([
      ctx.tenantId,
      ctx.userId,
      {
        where: {
          id: clientId,
          tenantId: ctx.tenantId,
          status: { not: 'archived' },
          OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: ctx.userId } } }],
        },
        select: { id: true },
      },
    ]);
    expect(h.callsOf('read')[0]).toMatchObject({
      scope: 'tenant:tenant-one',
      args: [ctx.tenantId, clientId],
    });
    expect(sqlText(h.callsOf('read')[0]!.sql!)).toBe(sqlText(readSql));
  });
  it('returns independent disabled defaults, cloned sources and distinct epoch dates', async () => {
    const h = fixture();
    const first = await h.service.getSchedule(ctx, clientId);
    const second = await h.service.getSchedule(ctx, clientId);
    expect(first).toEqual({
      enabled: false,
      cadenceHours: 168,
      sources,
      nextRunAt: null,
      lastEnqueuedAt: null,
      updatedByUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    expect(first).not.toBe(second);
    expect(first.sources).not.toBe(second.sources);
    expect(first.createdAt).not.toBe(first.updatedAt);
  });
  it('returns a persisted row by identity without normalizing its stored fields', async () => {
    const stored = {
      enabled: true,
      cadenceHours: 12,
      sources: ['lda'],
      nextRunAt: new Date(99),
      lastEnqueuedAt: null,
      updatedByUserId: 'saved-user',
      createdAt: new Date(1),
      updatedAt: new Date(2),
    } as RefreshScheduleRow;
    expect(await fixture({ stored }).service.getSchedule(ctx, clientId)).toBe(stored);
  });
  it('denies missing, archived or inaccessible clients before reading schedule data', async () => {
    const h = fixture({ authorized: [false] });
    await expect(h.service.getSchedule(ctx, clientId)).rejects.toThrow('Client not found');
    expect(h.callsOf('read')).toEqual([]);
  });
});

describe('Refresh configuration validation and readback', () => {
  it.each([6, 720])(
    'accepts cadence boundary %i with the exact upsert and accepting actor',
    async (cadenceHours) => {
      const h = fixture();
      await h.service.updateSchedule(ctx, clientId, {
        enabled: true,
        cadenceHours,
        sources: ['lda'],
      });
      expect(sqlText(h.callsOf('edit')[0]!.sql!)).toBe(sqlText(editSql));
      expect(h.callsOf('edit')[0]!.args).toEqual([
        ctx.tenantId,
        clientId,
        true,
        cadenceHours,
        '["lda"]',
        ctx.userId,
      ]);
      expect(h.calls.map((entry) => entry.kind)).toEqual(['auth', 'edit', 'auth', 'read']);
      expect(h.phases.indexOf('tenant:tenant-one:commit')).toBeLessThan(
        h.phases.lastIndexOf('auth'),
      );
    },
  );
  it.each([5, 721, 6.5, NaN])(
    'rejects cadence %p after access and before writes',
    async (cadenceHours) => {
      const h = fixture();
      await expect(
        h.service.updateSchedule(ctx, clientId, { enabled: true, cadenceHours }),
      ).rejects.toThrow('Refresh cadence must be between 6 and 720 hours');
      expect(h.calls.map((entry) => entry.kind)).toEqual(['auth']);
    },
  );
  it('checks authorization before an otherwise invalid cadence', async () => {
    const h = fixture({ authorized: [false] });
    await expect(
      h.service.updateSchedule(ctx, clientId, { enabled: true, cadenceHours: 0 }),
    ).rejects.toThrow('Client not found');
    expect(h.callsOf('edit')).toEqual([]);
  });
});

describe('Refresh source selection and committed readback', () => {
  it.each([undefined, []])(
    'uses all connected sources for omitted/empty input %p and defaults cadence',
    async (requested) => {
      const h = fixture();
      await h.service.updateSchedule(ctx, clientId, { enabled: false, sources: requested });
      expect(h.callsOf('edit')[0]!.args).toEqual([
        ctx.tenantId,
        clientId,
        false,
        168,
        JSON.stringify(sources),
        ctx.userId,
      ]);
    },
  );
  it('deduplicates before filtering and preserves the requested valid-source order', async () => {
    const requested = [
      'lda',
      'not-a-source',
      'public_web',
      'lda',
    ] as unknown as UpdateClientProfileFillScheduleInput['sources'];
    const h = fixture();
    await h.service.updateSchedule(ctx, clientId, { enabled: true, sources: requested });
    expect(h.callsOf('edit')[0]!.args[4]).toBe('["lda","public_web"]');
  });
  it('rejects a nonempty entirely-invalid list and leaves the existing schedule untouched', async () => {
    const h = fixture();
    await expect(
      h.service.updateSchedule(ctx, clientId, {
        enabled: true,
        sources: ['invalid'] as unknown as UpdateClientProfileFillScheduleInput['sources'],
      }),
    ).rejects.toThrow('Choose at least one refresh source');
    expect(h.callsOf('edit')).toEqual([]);
  });
  it('retains the committed upsert when authorized readback fails', async () => {
    const h = fixture({ authorized: [true, false] });
    await expect(h.service.updateSchedule(ctx, clientId, { enabled: false })).rejects.toThrow(
      'Client not found',
    );
    expect(h.calls.map((entry) => entry.kind)).toEqual(['auth', 'edit', 'auth']);
    expect(h.phases).toContain('tenant:tenant-one:commit');
  });
  it('returns the separate persisted readback rather than deriving a response from update input', async () => {
    const stored = { enabled: false, sources: ['lda'], cadenceHours: 12 } as RefreshScheduleRow;
    const h = fixture({ stored });
    expect(await h.service.updateSchedule(ctx, clientId, { enabled: true, cadenceHours: 48 })).toBe(
      stored,
    );
    expect(h.calls.map((entry) => entry.kind)).toEqual(['auth', 'edit', 'auth', 'read']);
  });
});

describe('Manual refresh uses common durable run orchestration', () => {
  it('starts a fresh run with saved sources even when disabled without bumping the schedule', async () => {
    const stored = { enabled: false, sources: ['lda'] } as RefreshScheduleRow;
    const h = fixture({ stored, active: false });
    expect(await h.service.refreshNow(ctx, clientId)).toEqual({
      id: 'new-run',
      status: 'completed',
    });
    expect(h.workflow.startRun).toHaveBeenCalledWith(ctx, clientId, { sources: stored.sources });
    expect(
      h
        .callsOf('task-write')
        .some((call) => call.sql?.includes('INSERT INTO client_profile_fill_extension_task')),
    ).toBe(true);
    expect(h.callsOf('bump')).toEqual([]);
  });
  it('reuses an active run through canonical getRun rather than starting another core run', async () => {
    const h = fixture();
    expect(await h.service.refreshNow(ctx, clientId)).toEqual({
      id: 'active-run',
      status: 'completed',
    });
    expect(h.workflow.startRun).not.toHaveBeenCalled();
    expect(h.workflow.getRun).toHaveBeenCalledWith(ctx, clientId, 'active-run');
  });
  it('preserves saved sources without new normalization at the workflow entry', async () => {
    const stored = { enabled: false, sources: [] } as unknown as RefreshScheduleRow;
    const h = fixture({ stored, active: false });
    await h.service.refreshNow(ctx, clientId);
    expect(h.workflow.startRun.mock.calls[0]![2]).toEqual({ sources: [] });
  });
});

describe('Atomic due reservation and scheduled actor', () => {
  it('claims globally once, reserves before starts and processes the returned order sequentially', async () => {
    const h = fixture({ due: [dueRow({ clientId: 'z' }), dueRow({ clientId: 'a' })] });
    await h.service.sweepSchedulesOnce();
    expect(sqlText(h.callsOf('claim')[0]!.sql!)).toBe(sqlText(claimSql));
    expect(h.callsOf('claim')[0]).toMatchObject({ scope: 'system', args: [] });
    expect(h.workflow.getRun.mock.calls.map((args) => args[1])).toEqual(['z', 'a']);
    expect(h.phases.indexOf('system:commit')).toBeLessThan(h.phases.indexOf('active'));
    expect(h.phases.filter((phase) => ['workflow-read', 'bump'].includes(phase))).toEqual([
      'workflow-read',
      'bump',
      'workflow-read',
      'bump',
    ]);
  });
  it('reconstructs the persisted standard-user actor and still marks an active-run reuse enqueued', async () => {
    const row = dueRow();
    const h = fixture({ due: [row] });
    await h.service.sweepSchedulesOnce();
    expect(h.workflow.getRun).toHaveBeenCalledWith(
      {
        tenantId: row.tenantId,
        tenantSlug: '',
        userId: row.userId,
        clerkUserId: '',
        role: 'standard_user',
      },
      row.clientId,
      'active-run',
    );
    expect(sqlText(h.callsOf('bump')[0]!.sql!)).toBe(sqlText(bumpSql));
    expect(h.callsOf('bump')[0]!.args).toEqual([row.tenantId, row.clientId, 168, true]);
  });
  it('only rearms a due row without an actor, preserving its captured cadence and enabled race guard', async () => {
    const h = fixture({ due: [dueRow({ userId: null, cadenceHours: 72 })] });
    await h.service.sweepSchedulesOnce();
    expect(h.calls.map((call) => call.kind)).toEqual(['claim', 'bump']);
    expect(h.callsOf('bump')[0]!.args).toEqual(['tenant-due', 'due-client', 72, false]);
    expect(h.callsOf('bump')[0]!.sql).toContain('AND enabled = true');
    expect(h.warnings).toEqual([]);
  });
  it('completes an empty due claim and permits another manual sweep', async () => {
    const h = fixture();
    await h.service.sweepSchedulesOnce();
    await h.service.sweepSchedulesOnce();
    expect(h.callsOf('claim')).toHaveLength(2);
  });
});

describe('Schedule rearming and escaped failures', () => {
  it.each([6, 72])(
    'warns on start failure and rearms at min(24,cadence) for %i hours',
    async (cadenceHours) => {
      const h = fixture({
        due: [dueRow({ cadenceHours })],
        readError: new Error('api_key=private start unavailable'),
      });
      await h.service.sweepSchedulesOnce();
      expect(h.callsOf('bump')[0]!.args).toEqual([
        'tenant-due',
        'due-client',
        Math.min(24, cadenceHours),
        false,
      ]);
      expect(h.warnings).toEqual([
        'Scheduled Fill with Meri refresh failed for due-client: api_key=[redacted] start unavailable',
      ]);
    },
  );
  it('catches a failed success bump and retries without marking enqueued', async () => {
    const h = fixture({ due: [dueRow()], bumps: [new Error('bump failed'), undefined] });
    await h.service.sweepSchedulesOnce();
    expect(h.callsOf('bump').map((call) => call.args.slice(2))).toEqual([
      [168, true],
      [24, false],
    ]);
    expect(h.warnings).toHaveLength(1);
  });
  it('propagates a failed retry bump and leaves later reserved rows unstarted, then releases exclusion', async () => {
    const h = fixture({
      due: [dueRow({ clientId: 'first' }), dueRow({ clientId: 'second' })],
      readError: new Error('start failed'),
      bumps: [new Error('retry failed')],
    });
    await expect(h.service.sweepSchedulesOnce()).rejects.toThrow('retry failed');
    expect(h.workflow.getRun.mock.calls.map((args) => args[1])).toEqual(['first']);
    h.options.due = [];
    await h.service.sweepSchedulesOnce();
    expect(h.callsOf('claim')).toHaveLength(2);
  });
  it('propagates a missing-actor bump failure without a per-row warning', async () => {
    const h = fixture({
      due: [dueRow({ userId: null }), dueRow({ clientId: 'second' })],
      bumps: [new Error('missing actor bump failed')],
    });
    await expect(h.service.sweepSchedulesOnce()).rejects.toThrow('missing actor bump failed');
    expect(h.warnings).toEqual([]);
    expect(h.workflow.getRun).not.toHaveBeenCalled();
  });
});

describe('Schedule sweep exclusion and claim recovery', () => {
  it('does not issue another claim while the first sweep is pending', async () => {
    let release!: (rows: Due[]) => void;
    const claim = new Promise<Due[]>((resolve) => {
      release = resolve;
    });
    const h = fixture({ claim: () => claim });
    const first = h.service.sweepSchedulesOnce();
    await h.service.sweepSchedulesOnce();
    expect(h.callsOf('claim')).toHaveLength(1);
    release([]);
    await first;
    await h.service.sweepSchedulesOnce();
    expect(h.callsOf('claim')).toHaveLength(2);
  });
  it('releases sweep exclusion after a rejected claim transaction', async () => {
    const h = fixture({
      claim: async () => {
        throw new Error('claim failed');
      },
    });
    await expect(h.service.sweepSchedulesOnce()).rejects.toThrow('claim failed');
    h.options.claim = async () => [];
    await h.service.sweepSchedulesOnce();
    expect(h.callsOf('claim')).toHaveLength(2);
  });
  it('keeps exclusion through a pending start while the independent task sweep still proceeds', async () => {
    let release!: (run: Record<string, unknown>) => void;
    const holdRead = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const h = fixture({ due: [dueRow()], holdRead });
    const first = h.service.sweepSchedulesOnce();
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    expect(h.callsOf('workflow-read')).toHaveLength(1);
    await h.service.sweepSchedulesOnce();
    await h.service.sweepOnce();
    expect(h.callsOf('claim')).toHaveLength(1);
    expect(
      h.callsOf('task-write').some((call) => call.sql?.includes("error_code = 'stale_worker'")),
    ).toBe(true);
    expect(h.callsOf('bump')).toEqual([]);
    release({ id: 'active-run', status: 'completed' });
    await first;
    expect(h.callsOf('bump')).toHaveLength(1);
  });
});
