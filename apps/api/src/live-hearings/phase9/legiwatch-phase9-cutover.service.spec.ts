import { ConflictException } from '@nestjs/common';
import {
  LegiWatchPhase9CutoverService,
  type RunRow,
  type StateRow,
} from './legiwatch-phase9-cutover.service.js';

interface HarnessOptions {
  state?: Partial<StateRow>;
  run?: Partial<RunRow> | null;
  /** legiwatch_runtime_heartbeat(job_key='capture-worker').enabled AND schedule_enabled */
  captureWorkerRunnable?: boolean;
}

function stateRow(): StateRow {
  return {
    phase: 'SHADOW',
    productionDefault: false,
    schedulesEnabled: false,
    killSwitchEngaged: true,
    captureAllPublicEvents: false,
    minimumConsecutivePasses: 3,
    minimumShadowHours: 168,
    consecutivePasses: 0,
    shadowStartedAt: new Date('2026-08-01T00:00:00Z'),
    canaryStartedAt: null,
    cutoverAt: null,
    rollbackAt: null,
    lastRunId: null,
    lastPassingRunId: null,
    updatedBy: 'test',
    updatedAt: new Date('2026-08-21T00:00:00Z'),
  };
}

function runRow(): RunRow {
  return {
    id: '00000000-0000-0000-0000-000000000901',
    mode: 'READINESS',
    status: 'PASS',
    evidenceSource: 'MIXED',
    blockerCount: 0,
    createdAt: new Date('2026-08-21T00:00:00Z'),
  };
}

function harness(options: HarnessOptions = {}) {
  let current = { ...stateRow(), ...(options.state ?? {}) };
  const run = options.run === null ? null : { ...runRow(), ...(options.run ?? {}) };
  const execute = jest.fn(async (sql: string, ...values: unknown[]) => {
    if (sql.includes("phase='CANARY'")) {
      current = {
        ...current,
        phase: 'CANARY',
        canaryStartedAt: current.canaryStartedAt ?? new Date('2026-08-21T00:00:00Z'),
        updatedBy: String(values[0]),
      };
    } else if (sql.includes("phase='READY'")) {
      current = { ...current, phase: 'READY', updatedBy: String(values[0]) };
    } else if (sql.includes("phase='CUTOVER'")) {
      current = {
        ...current,
        phase: 'CUTOVER',
        productionDefault: true,
        killSwitchEngaged: false,
        cutoverAt: new Date('2026-08-21T00:00:00Z'),
        updatedBy: String(values[0]),
      };
    } else if (sql.includes("phase='ROLLBACK'")) {
      current = {
        ...current,
        phase: 'ROLLBACK',
        productionDefault: false,
        schedulesEnabled: false,
        killSwitchEngaged: true,
        captureAllPublicEvents: false,
        rollbackAt: new Date('2026-08-21T00:00:00Z'),
        consecutivePasses: 0,
        updatedBy: String(values[0]),
      };
    } else if (sql.includes('capture_all_public_events=$1')) {
      current = {
        ...current,
        captureAllPublicEvents: Boolean(values[0]),
        updatedBy: String(values[1]),
      };
    }
    return 1;
  });
  const query = jest.fn(async (sql: string, ..._values: unknown[]) => {
    if (sql.includes('FROM legiwatch_cutover_state')) return [current];
    if (sql.includes('FROM legiwatch_runtime_heartbeat')) {
      return [{ runnable: options.captureWorkerRunnable ?? true }];
    }
    if (sql.includes('FROM legiwatch_cutover_run')) return run ? [run] : [];
    if (sql.includes('INSERT INTO legiwatch_verification_evidence')) {
      return [
        {
          id: '00000000-0000-0000-0000-000000000902',
          evidenceType: 'TENANT_RLS',
          evidenceSource: 'LOCAL_FIXTURE',
          status: 'PASS',
          hearingId: null,
          captureId: null,
          runId: null,
          observedAt: new Date('2026-08-21T00:00:00Z'),
          expiresAt: new Date('2026-11-19T00:00:00Z'),
          artifactUri: 's3://phase9/evidence.json',
          details: { fixture: 'rls' },
          recordedBy: 'admin-user',
          createdAt: new Date('2026-08-21T00:00:00Z'),
        },
      ];
    }
    return [];
  });
  const tx = { $executeRawUnsafe: execute, $queryRawUnsafe: query };
  const prisma = {
    $executeRawUnsafe: execute,
    $queryRawUnsafe: query,
    withSystem: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    service: new LegiWatchPhase9CutoverService(prisma as never),
    prisma,
    query,
    execute,
    current: () => current,
  };
}

describe('LegiWatchPhase9CutoverService', () => {
  const originalCutover = process.env.LEGIWATCH_ALLOW_PRODUCTION_CUTOVER;
  const originalCaptureAll = process.env.LEGIWATCH_ALLOW_CAPTURE_ALL;

  afterEach(() => {
    if (originalCutover === undefined) delete process.env.LEGIWATCH_ALLOW_PRODUCTION_CUTOVER;
    else process.env.LEGIWATCH_ALLOW_PRODUCTION_CUTOVER = originalCutover;
    if (originalCaptureAll === undefined) delete process.env.LEGIWATCH_ALLOW_CAPTURE_ALL;
    else process.env.LEGIWATCH_ALLOW_CAPTURE_ALL = originalCaptureAll;
  });

  it('returns a fail-closed rollout decision before CUTOVER', async () => {
    const { service } = harness();
    await expect(service.rolloutDecision()).resolves.toMatchObject({
      phase: 'SHADOW',
      productionDefault: false,
      killSwitchEngaged: true,
      liveHearingsV2DefaultEnabled: false,
    });
  });

  it('refuses canary until the complete schedule matrix is enabled', async () => {
    const { service } = harness({ state: { schedulesEnabled: false } });
    await expect(
      service.transition({
        target: 'CANARY',
        actor: 'admin-user',
        confirmation: 'ENABLE LEGIWATCH CANARY',
      }),
    ).rejects.toThrow(/schedules/i);
  });

  it('requires the exact confirmation before any transition', async () => {
    const { service } = harness({ state: { schedulesEnabled: true } });
    await expect(
      service.transition({
        target: 'CANARY',
        actor: 'admin-user',
        confirmation: 'yes',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows canary only from SHADOW with a blocker-free passing run', async () => {
    const { service, execute } = harness({ state: { schedulesEnabled: true } });
    await expect(
      service.transition({
        target: 'CANARY',
        actor: 'admin-user',
        confirmation: 'ENABLE LEGIWATCH CANARY',
      }),
    ).resolves.toMatchObject({ phase: 'CANARY', productionDefault: false });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("phase='CANARY'"), 'admin-user');
  });

  it('requires shadow duration and consecutive passes before READY', async () => {
    const { service } = harness({
      state: {
        phase: 'CANARY',
        schedulesEnabled: true,
        shadowStartedAt: new Date(),
        consecutivePasses: 2,
      },
      run: { mode: 'CANARY' },
    });
    await expect(
      service.transition({
        target: 'READY',
        actor: 'admin-user',
        confirmation: 'MARK LEGIWATCH READY',
      }),
    ).rejects.toThrow(/Shadow window|consecutive/i);
  });

  it('blocks production cutover when the controlled environment gate is absent', async () => {
    delete process.env.LEGIWATCH_ALLOW_PRODUCTION_CUTOVER;
    const { service } = harness({
      state: { phase: 'READY', schedulesEnabled: true, consecutivePasses: 3 },
      run: { mode: 'CUTOVER_VERIFICATION', evidenceSource: 'LIVE' },
    });
    await expect(
      service.transition({
        target: 'CUTOVER',
        actor: 'admin-user',
        confirmation: 'CUT OVER LEGIWATCH LIVE HEARINGS',
      }),
    ).rejects.toThrow(/LEGIWATCH_ALLOW_PRODUCTION_CUTOVER/);
  });

  it('requires a latest LIVE/MIXED cutover-verification run', async () => {
    process.env.LEGIWATCH_ALLOW_PRODUCTION_CUTOVER = 'true';
    const { service } = harness({
      state: { phase: 'READY', schedulesEnabled: true, consecutivePasses: 3 },
      run: { mode: 'CUTOVER_VERIFICATION', evidenceSource: 'OFFICIAL_ARCHIVE' },
    });
    await expect(
      service.transition({
        target: 'CUTOVER',
        actor: 'admin-user',
        confirmation: 'CUT OVER LEGIWATCH LIVE HEARINGS',
      }),
    ).rejects.toThrow(/LIVE or MIXED/);
  });

  it('atomically restores safety controls during rollback', async () => {
    const { service, execute } = harness({
      state: {
        phase: 'CUTOVER',
        productionDefault: true,
        schedulesEnabled: true,
        killSwitchEngaged: false,
        captureAllPublicEvents: true,
      },
    });
    await expect(
      service.transition({
        target: 'ROLLBACK',
        actor: 'admin-user',
        confirmation: 'ROLL BACK LEGIWATCH LIVE HEARINGS',
      }),
    ).resolves.toMatchObject({
      phase: 'ROLLBACK',
      productionDefault: false,
      schedulesEnabled: false,
      killSwitchEngaged: true,
      captureAllPublicEvents: false,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("phase='ROLLBACK'"),
      'admin-user',
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE legiwatch_runtime_heartbeat'),
      expect.any(String),
    );
  });

  it('enables capture-all system-wide from any phase (still SHADOW, kill switch still engaged) once the capture worker runtime is enabled and the operator environment allows it', async () => {
    process.env.LEGIWATCH_ALLOW_CAPTURE_ALL = 'true';
    // Deliberately still SHADOW / killSwitchEngaged:true (the ladder default) —
    // capture-all is independent of that singleton by design; only the REAL
    // runtime kill switch (legiwatch_runtime_heartbeat) gates it.
    const { service, execute } = harness({ captureWorkerRunnable: true });
    await service.setCaptureAll({
      enabled: true,
      actor: 'admin-user',
      confirmation: 'ENABLE LEGIWATCH CAPTURE ALL',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('SET capture_all_public_events=$1'),
      true,
      'admin-user',
    );
  });

  it('refuses to enable capture-all while the capture-worker runtime is disabled, even with the operator environment and exact confirmation', async () => {
    process.env.LEGIWATCH_ALLOW_CAPTURE_ALL = 'true';
    const { service, execute } = harness({ captureWorkerRunnable: false });
    await expect(
      service.setCaptureAll({
        enabled: true,
        actor: 'admin-user',
        confirmation: 'ENABLE LEGIWATCH CAPTURE ALL',
      }),
    ).rejects.toThrow(/capture-worker runtime is disabled/);
    expect(execute).not.toHaveBeenCalledWith(
      expect.stringContaining('SET capture_all_public_events=$1'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects setCaptureAll with a wrong or blank confirmation string', async () => {
    process.env.LEGIWATCH_ALLOW_CAPTURE_ALL = 'true';
    const { service, execute } = harness();
    await expect(
      service.setCaptureAll({ enabled: true, actor: 'admin-user', confirmation: '' }),
    ).rejects.toThrow(/Exact confirmation required/);
    await expect(
      service.setCaptureAll({
        enabled: true,
        actor: 'admin-user',
        confirmation: 'enable legiwatch capture all',
      }),
    ).rejects.toThrow(/Exact confirmation required/);
    expect(execute).not.toHaveBeenCalledWith(
      expect.stringContaining('SET capture_all_public_events=$1'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('disables capture-all without requiring the operator environment or a released kill switch', async () => {
    delete process.env.LEGIWATCH_ALLOW_CAPTURE_ALL;
    const { service, execute } = harness();
    await service.setCaptureAll({
      enabled: false,
      actor: 'admin-user',
      confirmation: 'DISABLE LEGIWATCH CAPTURE ALL',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('SET capture_all_public_events=$1'),
      false,
      'admin-user',
    );
  });

  it('keeps capture-all separately gated after cutover', async () => {
    delete process.env.LEGIWATCH_ALLOW_CAPTURE_ALL;
    const { service } = harness({
      state: {
        phase: 'CUTOVER',
        productionDefault: true,
        killSwitchEngaged: false,
      },
    });
    await expect(
      service.setCaptureAll({
        enabled: true,
        actor: 'admin-user',
        confirmation: 'ENABLE LEGIWATCH CAPTURE ALL',
      }),
    ).rejects.toThrow(/LEGIWATCH_ALLOW_CAPTURE_ALL/);
  });

  it('rejects evidence payloads containing secrets or tenant/client material', async () => {
    const { service } = harness();
    await expect(
      service.recordEvidence({
        evidenceType: 'TENANT_RLS',
        evidenceSource: 'LOCAL_FIXTURE',
        status: 'PASS',
        details: { tenantId: 'private-tenant' },
        actor: 'admin-user',
      }),
    ).rejects.toThrow(/forbidden field/i);
    await expect(
      service.recordEvidence({
        evidenceType: 'TENANT_RLS',
        evidenceSource: 'LOCAL_FIXTURE',
        status: 'PASS',
        details: { provider: { apiKey: 'secret' } },
        actor: 'admin-user',
      }),
    ).rejects.toThrow(/forbidden field/i);
  });

  it('requires hearing and capture anchors for real live capture proof', async () => {
    const { service } = harness();
    await expect(
      service.recordEvidence({
        evidenceType: 'LIVE_DEEPGRAM',
        evidenceSource: 'LIVE',
        status: 'PASS',
        actor: 'admin-user',
      }),
    ).rejects.toThrow(/hearingId and captureId/);
  });

  it('persists bounded credential-free evidence', async () => {
    const { service, query } = harness();
    await expect(
      service.recordEvidence({
        evidenceType: 'TENANT_RLS',
        evidenceSource: 'LOCAL_FIXTURE',
        status: 'PASS',
        artifactUri: 's3://phase9/evidence.json',
        details: { fixture: 'rls' },
        actor: 'admin-user',
      }),
    ).resolves.toMatchObject({
      evidenceType: 'TENANT_RLS',
      status: 'PASS',
      artifactUri: 's3://phase9/evidence.json',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO legiwatch_verification_evidence'),
      'TENANT_RLS',
      'LOCAL_FIXTURE',
      'PASS',
      null,
      null,
      null,
      expect.any(Date),
      expect.any(Date),
      's3://phase9/evidence.json',
      JSON.stringify({ fixture: 'rls' }),
      'admin-user',
    );
  });
});
