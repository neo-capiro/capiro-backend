import {
  LegiWatchPhase9AdminController,
  LegiWatchPhase9RolloutController,
} from './legiwatch-phase9.controller.js';

const ctx = {
  tenantId: '00000000-0000-0000-0000-000000000901',
  tenantSlug: 'phase9',
  userId: 'admin-user',
  clerkUserId: 'clerk-admin',
  role: 'capiro_admin',
} as never;

function harness() {
  const readiness = {
    evaluate: jest.fn().mockResolvedValue({ status: 'BLOCKED' }),
    evaluateAndPersist: jest.fn().mockResolvedValue({
      report: { status: 'PASS' },
      run: { id: 'run-1' },
    }),
    listRecentRuns: jest.fn().mockResolvedValue([]),
    getRun: jest.fn().mockResolvedValue({ id: 'run-1' }),
    dispositionObservation: jest.fn().mockResolvedValue({ status: 'CONFLICT' }),
  };
  const runtime = {
    list: jest.fn().mockResolvedValue([]),
    registerSchedules: jest.fn().mockResolvedValue([]),
  };
  const cutover = {
    rolloutDecision: jest.fn().mockResolvedValue({
      phase: 'SHADOW',
      liveHearingsV2DefaultEnabled: false,
    }),
    state: jest.fn().mockResolvedValue({ phase: 'SHADOW' }),
    transition: jest.fn().mockResolvedValue({ phase: 'CANARY' }),
    setCaptureAll: jest.fn().mockResolvedValue({ captureAllPublicEvents: false }),
    recordEvidence: jest.fn().mockResolvedValue({ id: 'evidence-1' }),
    listEvidence: jest.fn().mockResolvedValue([]),
  };
  return {
    rollout: new LegiWatchPhase9RolloutController(cutover as never),
    admin: new LegiWatchPhase9AdminController(
      readiness as never,
      runtime as never,
      cutover as never,
    ),
    readiness,
    runtime,
    cutover,
  };
}

describe('LegiWatch Phase 9 controllers', () => {
  it('exposes only the safe rollout decision on the standard-user surface', async () => {
    const { rollout, cutover } = harness();
    await expect(rollout.rollout()).resolves.toMatchObject({
      phase: 'SHADOW',
      liveHearingsV2DefaultEnabled: false,
    });
    expect(cutover.rolloutDecision).toHaveBeenCalledTimes(1);
  });

  it('defaults a readiness preview to NONE evidence so it cannot pass accidentally', async () => {
    const { admin, readiness } = harness();
    await admin.readinessPreview({});
    expect(readiness.evaluate).toHaveBeenCalledWith({
      evidenceSource: 'NONE',
      mode: 'READINESS',
      lookbackDays: undefined,
      lookaheadDays: undefined,
      captureGraceMinutes: undefined,
      intelligenceLagMinutes: undefined,
    });
  });

  it('attributes a persisted readiness run to the authenticated admin', async () => {
    const { admin, readiness } = harness();
    await admin.runReadiness(ctx, {
      evidenceSource: 'MIXED',
      mode: 'CUTOVER_VERIFICATION',
      lookbackDays: 30,
    });
    expect(readiness.evaluateAndPersist).toHaveBeenCalledWith('admin-user', {
      evidenceSource: 'MIXED',
      mode: 'CUTOVER_VERIFICATION',
      lookbackDays: 30,
      lookaheadDays: undefined,
      captureGraceMinutes: undefined,
      intelligenceLagMinutes: undefined,
    });
  });

  it('keeps observation disposition explicit and admin attributed', async () => {
    const { admin, readiness } = harness();
    await admin.dispositionObservation(ctx, 'observation-1', {
      disposition: 'CONFLICT',
      reasonCode: 'OFFICIAL_SOURCE_CONFLICT',
    });
    expect(readiness.dispositionObservation).toHaveBeenCalledWith({
      observationId: 'observation-1',
      disposition: 'CONFLICT',
      reasonCode: 'OFFICIAL_SOURCE_CONFLICT',
      actor: 'admin-user',
    });
  });

  it('passes schedule registration and exact confirmation through unchanged', async () => {
    const { admin, runtime } = harness();
    const registrations = [
      {
        jobKey: 'metrics',
        enabled: true,
        scheduleEnabled: true,
        ruleName: 'metrics-rule',
        taskFamily: 'api-job',
      },
    ];
    await admin.registerRuntime(ctx, {
      registrations,
      confirmation: 'ENABLE LEGIWATCH SCHEDULES',
    });
    expect(runtime.registerSchedules).toHaveBeenCalledWith({
      registrations,
      actor: 'admin-user',
      confirmation: 'ENABLE LEGIWATCH SCHEDULES',
    });
  });

  it('delegates cutover and capture-all without weakening confirmations', async () => {
    const { admin, cutover } = harness();
    await admin.transition(ctx, {
      target: 'CANARY',
      confirmation: 'ENABLE LEGIWATCH CANARY',
    });
    await admin.captureAll(ctx, {
      enabled: false,
      confirmation: 'DISABLE LEGIWATCH CAPTURE ALL',
    });
    expect(cutover.transition).toHaveBeenCalledWith({
      target: 'CANARY',
      actor: 'admin-user',
      confirmation: 'ENABLE LEGIWATCH CANARY',
    });
    expect(cutover.setCaptureAll).toHaveBeenCalledWith({
      enabled: false,
      actor: 'admin-user',
      confirmation: 'DISABLE LEGIWATCH CAPTURE ALL',
    });
  });

  it('converts validated evidence timestamps and preserves safe metadata', async () => {
    const { admin, cutover } = harness();
    await admin.recordEvidence(ctx, {
      evidenceType: 'LIVE_CAPTURE',
      evidenceSource: 'LIVE',
      status: 'PASS',
      hearingId: 'hearing-1',
      captureId: 'capture-1',
      observedAt: '2026-08-21T12:00:00Z',
      expiresAt: '2026-09-21T12:00:00Z',
      artifactUri: 's3://phase9/live-capture.json',
      details: { outcome: 'complete' },
    });
    expect(cutover.recordEvidence).toHaveBeenCalledWith({
      evidenceType: 'LIVE_CAPTURE',
      evidenceSource: 'LIVE',
      status: 'PASS',
      hearingId: 'hearing-1',
      captureId: 'capture-1',
      runId: undefined,
      observedAt: new Date('2026-08-21T12:00:00Z'),
      expiresAt: new Date('2026-09-21T12:00:00Z'),
      artifactUri: 's3://phase9/live-capture.json',
      details: { outcome: 'complete' },
      actor: 'admin-user',
    });
  });
});
