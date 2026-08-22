import {
  LEGIWATCH_PHASE9_PREFLIGHT_CHECKPOINTS,
  LegiWatchPhase9PreflightService,
} from './legiwatch-phase9-preflight.service.js';

interface RowOverrides {
  hearingId?: string;
  startsAt?: Date;
  captureId?: string | null;
  captureStatus?: string | null;
  demandCount?: number;
  candidateCount?: number;
  serverAllowedCount?: number;
  reviewRequiredCount?: number;
  terminalNonServerCount?: number;
  eventStatus?: string;
}

function plannerRow(overrides: RowOverrides = {}) {
  return {
    hearingId: overrides.hearingId ?? 'hearing-1',
    startsAt: overrides.startsAt ?? new Date('2026-08-21T13:00:00Z'),
    title: 'Defense posture hearing',
    eventStatus: overrides.eventStatus ?? 'scheduled',
    visibility: 'public',
    captureId: overrides.captureId ?? null,
    captureStatus: overrides.captureStatus ?? null,
    demandCount: overrides.demandCount ?? 1,
    candidateCount: overrides.candidateCount ?? 0,
    serverAllowedCount: overrides.serverAllowedCount ?? 0,
    reviewRequiredCount: overrides.reviewRequiredCount ?? 0,
    terminalNonServerCount: overrides.terminalNonServerCount ?? 0,
  };
}

function harness(input: {
  rows?: ReturnType<typeof plannerRow>[];
  captureAll?: boolean;
  checkpoint?: 'inserted' | 'rearmed' | 'active';
  existingCaptureId?: string;
} = {}) {
  const rows = input.rows ?? [plannerRow()];
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM legiwatch_cutover_state')) {
      return [{ captureAllPublicEvents: input.captureAll ?? false }];
    }
    if (sql.includes('FROM committee_hearing h')) return rows;
    if (sql.includes('INSERT INTO public_hearing_capture')) {
      return [{ id: input.existingCaptureId ?? 'capture-new' }];
    }
    if (sql.includes('SELECT id FROM public_hearing_capture')) {
      return [{ id: input.existingCaptureId ?? 'capture-existing' }];
    }
    if (sql.includes('INSERT INTO public_hearing_capture_job')) {
      if (input.checkpoint === 'active') return [];
      return [
        {
          id: 'job-1',
          inserted: input.checkpoint !== 'rearmed',
          rearmed: input.checkpoint === 'rearmed',
        },
      ];
    }
    return [];
  });
  const prisma = { $queryRawUnsafe: query };
  return {
    service: new LegiWatchPhase9PreflightService(prisma as never),
    query,
  };
}

describe('LegiWatchPhase9PreflightService', () => {
  const now = new Date('2026-08-21T12:00:00Z');

  it('pins the required T-60/T-15/T-2/start checkpoint contract', () => {
    expect(LEGIWATCH_PHASE9_PREFLIGHT_CHECKPOINTS).toEqual([60, 15, 2, 0]);
  });

  it('creates one canonical capture and all four preflight checkpoints for tenant demand', async () => {
    const { service, query } = harness();
    await expect(service.plan({ now })).resolves.toMatchObject({
      scanned: 1,
      eligible: 1,
      capturesCreated: 1,
      checkpointsInserted: 4,
      delayedStartCheckpoints: 0,
      skippedNoDemand: 0,
      errors: [],
    });
    const checkpointCalls = query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO public_hearing_capture_job'),
    );
    expect(checkpointCalls).toHaveLength(4);
    expect(checkpointCalls.map((call) => call[1])).toEqual([
      'hearing-stream-preflight:v2:hearing-1:t60',
      'hearing-stream-preflight:v2:hearing-1:t15',
      'hearing-stream-preflight:v2:hearing-1:t2',
      'hearing-stream-preflight:v2:hearing-1:start',
    ]);
    expect(checkpointCalls.every((call) => JSON.parse(String(call[4])).mustReresolve)).toBe(true);
  });

  it('does not create capture demand for an unscheduled tenant while capture-all is off', async () => {
    const { service, query } = harness({ rows: [plannerRow({ demandCount: 0 })] });
    await expect(service.plan({ now })).resolves.toMatchObject({
      scanned: 1,
      eligible: 0,
      skippedNoDemand: 1,
      checkpointsInserted: 0,
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO public_hearing_capture')),
    ).toBe(false);
  });

  it('permits public coverage planning only when the separately guarded capture-all state is true', async () => {
    const { service } = harness({
      captureAll: true,
      rows: [plannerRow({ demandCount: 0 })],
    });
    await expect(service.plan({ now })).resolves.toMatchObject({
      eligible: 1,
      capturesCreated: 1,
      skippedNoDemand: 0,
    });
  });

  it('skips a hearing whose available candidates are all explicitly non-server', async () => {
    const { service, query } = harness({
      rows: [
        plannerRow({
          candidateCount: 2,
          terminalNonServerCount: 2,
          serverAllowedCount: 0,
          reviewRequiredCount: 0,
        }),
      ],
    });
    await expect(service.plan({ now })).resolves.toMatchObject({
      eligible: 0,
      skippedExplicitNonServerPolicy: 1,
      capturesCreated: 0,
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO public_hearing_capture')),
    ).toBe(false);
  });

  it('skips an already-terminal canonical capture', async () => {
    const { service } = harness({
      rows: [
        plannerRow({
          captureId: 'capture-complete',
          captureStatus: 'COMPLETE_WITH_GAPS',
        }),
      ],
    });
    await expect(service.plan({ now })).resolves.toMatchObject({
      eligible: 0,
      skippedTerminalCapture: 1,
    });
  });

  it('re-arms completed checkpoint jobs idempotently rather than creating duplicates', async () => {
    const { service } = harness({ checkpoint: 'rearmed' });
    await expect(service.plan({ now })).resolves.toMatchObject({
      checkpointsInserted: 0,
      checkpointsRearmed: 4,
      checkpointsAlreadyActive: 0,
    });
  });

  it('recognizes an already leased/active checkpoint without disturbing it', async () => {
    const { service } = harness({ checkpoint: 'active' });
    await expect(service.plan({ now })).resolves.toMatchObject({
      checkpointsInserted: 0,
      checkpointsRearmed: 0,
      checkpointsAlreadyActive: 4,
    });
  });

  it('creates a rolling delayed-start checkpoint for a due hearing without replaying stale checkpoints', async () => {
    const { service, query } = harness({
      rows: [
        plannerRow({
          startsAt: new Date('2026-08-21T11:30:00Z'),
          eventStatus: 'in_progress',
        }),
      ],
    });
    await expect(service.plan({ now, delayedStartHours: 6 })).resolves.toMatchObject({
      eligible: 1,
      checkpointsInserted: 1,
      delayedStartCheckpoints: 1,
    });
    const checkpointCalls = query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO public_hearing_capture_job'),
    );
    expect(checkpointCalls).toHaveLength(1);
    expect(String(checkpointCalls[0]?.[1])).toMatch(
      /^hearing-stream-preflight:v2:hearing-1:delayed:\d+$/,
    );
    expect(JSON.parse(String(checkpointCalls[0]?.[4]))).toMatchObject({
      checkpoint: 'delayed-start',
      mustReresolve: true,
    });
  });

  it('isolates one event failure and continues planning the remaining events', async () => {
    const rows = [plannerRow({ hearingId: 'bad' }), plannerRow({ hearingId: 'good' })];
    const { service, query } = harness({ rows });
    let captureCalls = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM legiwatch_cutover_state')) return [{ captureAllPublicEvents: false }];
      if (sql.includes('FROM committee_hearing h')) return rows;
      if (sql.includes('INSERT INTO public_hearing_capture')) {
        captureCalls += 1;
        if (captureCalls === 1) throw new Error('database conflict');
        return [{ id: 'capture-good' }];
      }
      if (sql.includes('INSERT INTO public_hearing_capture_job')) {
        return [{ id: 'job', inserted: true, rearmed: false }];
      }
      return [];
    });
    const result = await service.plan({ now });
    expect(result.errors).toEqual([{ hearingId: 'bad', error: 'database conflict' }]);
    expect(result.eligible).toBe(2);
    expect(result.capturesCreated).toBe(1);
    expect(result.checkpointsInserted).toBe(4);
  });
});
