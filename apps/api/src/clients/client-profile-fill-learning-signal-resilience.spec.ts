import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { LearningSignalCaptureService } from '../learning/learning-signal-capture.service.js';

/**
 * Phase 27A closure (handoff §A2): proves the "capture failure does not undo
 * the originating product action" invariant at the actual call site, not
 * just inside LearningSignalCaptureService's own unit tests. The pure
 * adapter-builder specs (crm-fill-finding.adapter.spec.ts) cover signal
 * *shape*; this covers the *wiring* — that an accept/reject decision is
 * durable even when the learning-signal side-channel throws.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const FINDING = '55555555-5555-4555-8555-555555555555';
const ctx: TenantContext = { tenantId: TENANT, userId: '22222222-2222-4222-8222-222222222222' } as TenantContext;

function pendingFindingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FINDING,
    runId: RUN,
    clientId: CLIENT,
    kind: 'profile_field',
    targetKey: 'legal_name',
    source: 'sam_gov',
    factKind: null,
    currentValue: null,
    proposedValue: { value: 'Acme Corp' },
    evidence: [],
    confidence: 0.9,
    status: 'pending',
    contentHash: 'hash-1',
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    appliedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildService(learningSignals: Pick<LearningSignalCaptureService, 'capture'> | undefined) {
  const tx = { $queryRawUnsafe: jest.fn(async (..._args: unknown[]): Promise<unknown[]> => []) };
  const prisma = { withTenant: jest.fn((_tenantId: string, cb: (tx: unknown) => unknown) => cb(tx)) };
  const prepopulation = { prepopulate: jest.fn(async () => undefined) };
  const service = new ClientProfileFillService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    prepopulation as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    learningSignals as never,
  );
  return { service, tx, prisma };
}

describe('ClientProfileFillService — learning-signal capture is non-blocking', () => {
  let assertClientSpy: jest.SpiedFunction<any>;
  let applyFindingSpy: jest.SpiedFunction<any>;
  let markAcceptedSpy: jest.SpiedFunction<any>;
  let refreshSummarySpy: jest.SpiedFunction<any>;

  beforeEach(() => {
    assertClientSpy = jest
      .spyOn(ClientProfileFillService.prototype as any, 'assertClient')
      .mockResolvedValue(undefined);
    applyFindingSpy = jest
      .spyOn(ClientProfileFillService.prototype as any, 'applyFinding')
      .mockResolvedValue(undefined);
    markAcceptedSpy = jest
      .spyOn(ClientProfileFillService.prototype as any, 'markAccepted')
      .mockResolvedValue(undefined);
    refreshSummarySpy = jest
      .spyOn(ClientProfileFillService.prototype as any, 'refreshSummary')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    assertClientSpy.mockRestore();
    applyFindingSpy.mockRestore();
    markAcceptedSpy.mockRestore();
    refreshSummarySpy.mockRestore();
  });

  it('acceptance: applyFindings still marks the finding applied when capture() rejects', async () => {
    const capture = jest.fn(async (..._args: unknown[]): Promise<unknown> => {
      throw new Error('learning_signal insert failed');
    });
    const { service, tx } = buildService({ capture: capture as never });
    tx.$queryRawUnsafe.mockImplementation(async () => [pendingFindingRow()]);

    const result = await service.applyFindings(ctx, CLIENT, RUN, [FINDING]);

    expect(result.applied).toEqual([FINDING]);
    expect(result.errors).toEqual([]);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('acceptance: a genuinely disabled/no-op capture path also leaves the finding applied', async () => {
    const { service, tx } = buildService(undefined);
    tx.$queryRawUnsafe.mockImplementation(async () => [pendingFindingRow()]);

    const result = await service.applyFindings(ctx, CLIENT, RUN, [FINDING]);

    expect(result.applied).toEqual([FINDING]);
    expect(result.errors).toEqual([]);
  });

  it('acceptance: capturing a real signal on success does not affect the applied result', async () => {
    const capture = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
      status: 'captured',
      id: 'signal-1',
    }));
    const { service, tx } = buildService({ capture: capture as never });
    tx.$queryRawUnsafe.mockImplementation(async () => [pendingFindingRow()]);

    const result = await service.applyFindings(ctx, CLIENT, RUN, [FINDING]);

    expect(result.applied).toEqual([FINDING]);
    expect(capture).toHaveBeenCalledTimes(1);
    const [, input] = capture.mock.calls[0] as [unknown, { signalType: string; clientId: string }];
    expect(input.signalType).toBe('crm_finding_accepted');
    expect(input.clientId).toBe(CLIENT);
  });

  it('rejection: rejectFinding still returns { ok: true } when capture() rejects', async () => {
    const capture = jest.fn(async (..._args: unknown[]): Promise<unknown> => {
      throw new Error('learning_signal insert failed');
    });
    const { service, tx } = buildService({ capture: capture as never });
    tx.$queryRawUnsafe.mockImplementation(async () => [
      { runId: RUN, kind: 'profile_field', targetKey: 'legal_name', source: 'sam_gov', confidence: 0.9 },
    ]);

    const result = await service.rejectFinding(ctx, CLIENT, FINDING, 'not accurate');

    expect(result).toEqual({ ok: true });
    expect(capture).toHaveBeenCalledTimes(1);
    const [, input] = capture.mock.calls[0] as [unknown, { signalType: string }];
    expect(input.signalType).toBe('crm_finding_rejected');
  });

  it('rejection: a missing/undefined learningSignals collaborator does not break rejectFinding', async () => {
    const { service, tx } = buildService(undefined);
    tx.$queryRawUnsafe.mockImplementation(async () => [
      { runId: RUN, kind: 'profile_field', targetKey: 'legal_name', source: 'sam_gov', confidence: 0.9 },
    ]);

    const result = await service.rejectFinding(ctx, CLIENT, FINDING, 'not accurate');

    expect(result).toEqual({ ok: true });
  });

  describe('LEARNING_SIGNAL_CAPTURE kill switch, end to end through the real capture service', () => {
    const prior = process.env.LEARNING_SIGNAL_CAPTURE;
    afterEach(() => {
      if (prior === undefined) delete process.env.LEARNING_SIGNAL_CAPTURE;
      else process.env.LEARNING_SIGNAL_CAPTURE = prior;
    });

    function buildServiceWithRealCapture() {
      const tx = {
        $queryRawUnsafe: jest.fn(async (..._args: unknown[]): Promise<unknown[]> => [pendingFindingRow()]),
        learningSignal: {
          create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'signal-1', ...args.data })),
          findFirst: jest.fn(async () => null),
        },
      };
      const prisma = { withTenant: jest.fn((_tenantId: string, cb: (tx: unknown) => unknown) => cb(tx)) };
      const prepopulation = { prepopulate: jest.fn(async () => undefined) };
      const service = new ClientProfileFillService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        prepopulation as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        new LearningSignalCaptureService() as never,
      );
      return { service, tx };
    }

    it('enabled (default): apply succeeds and a real signal row is created', async () => {
      delete process.env.LEARNING_SIGNAL_CAPTURE;
      const { service, tx } = buildServiceWithRealCapture();

      const result = await service.applyFindings(ctx, CLIENT, RUN, [FINDING]);

      expect(result.applied).toEqual([FINDING]);
      expect(tx.learningSignal.create).toHaveBeenCalledTimes(1);
    });

    it('disabled: apply still succeeds but no signal row is created', async () => {
      process.env.LEARNING_SIGNAL_CAPTURE = 'disabled';
      const { service, tx } = buildServiceWithRealCapture();

      const result = await service.applyFindings(ctx, CLIENT, RUN, [FINDING]);

      expect(result.applied).toEqual([FINDING]);
      expect(tx.learningSignal.create).not.toHaveBeenCalled();
    });
  });
});
