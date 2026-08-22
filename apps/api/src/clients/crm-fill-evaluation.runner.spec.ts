import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { CrmFillEvaluationRunner, type CrmFillEvaluationInput } from './crm-fill-evaluation.runner.js';

const CTX = { tenantId: 't1', tenantSlug: 'tenant', userId: 'u1', clerkUserId: 'clerk_u1', role: 'user' } as unknown as TenantContext;

function makeRunner() {
  const recordDecision = jest.fn(async (_input: Record<string, unknown>) => ({ status: 'recorded' as const, id: 'eval-1' }));
  const markRunning = jest.fn(async (_t: string, _id: string) => undefined);
  const markCompleted = jest.fn(async (_t: string, _id: string, _r: Record<string, unknown>) => undefined);
  const markFailed = jest.fn(async (_t: string, _id: string, _r: string) => undefined);
  const evaluation = { recordDecision, markRunning, markCompleted, markFailed };
  const runner = new CrmFillEvaluationRunner(evaluation as never);
  return { runner, recordDecision, markRunning, markCompleted, markFailed };
}

function baseInput(over: Partial<CrmFillEvaluationInput> = {}): CrmFillEvaluationInput {
  return {
    clientId: 'client-1',
    source: 'public_web',
    contextPacketId: 'packet-1',
    institutionalItemCount: 2,
    treatmentExtraction: {
      people: [{ name: 'Dana Reed' }],
      facilities: [{ name: 'Aperture HQ' }],
      capabilities: [{ name: 'Systems Engineering' }],
    },
    replay: async () => ({
      people: [{ name: 'Dana Reed' }],
      facilities: [],
      capabilities: [{ name: 'Systems Engineering' }],
    }),
    ...over,
  };
}

describe('CrmFillEvaluationRunner', () => {
  const priorEnabled = process.env.LEARNING_EVALUATION;
  const priorRate = process.env.LEARNING_EVALUATION_SAMPLE_RATE;
  afterEach(() => {
    if (priorEnabled === undefined) delete process.env.LEARNING_EVALUATION;
    else process.env.LEARNING_EVALUATION = priorEnabled;
    if (priorRate === undefined) delete process.env.LEARNING_EVALUATION_SAMPLE_RATE;
    else process.env.LEARNING_EVALUATION_SAMPLE_RATE = priorRate;
  });

  test('records nothing while the kill switch is off', async () => {
    delete process.env.LEARNING_EVALUATION;
    const { runner, recordDecision } = makeRunner();
    await runner.considerAndRun(CTX, 'packet-1:public_web', baseInput());
    expect(recordDecision).not.toHaveBeenCalled();
  });

  test('records nothing when the treatment extraction was null (nothing to evaluate)', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const { runner, recordDecision } = makeRunner();
    await runner.considerAndRun(CTX, 'packet-1:public_web', baseInput({ treatmentExtraction: null }));
    expect(recordDecision).not.toHaveBeenCalled();
  });

  test('skips with no_institutional_context when the run had nothing to withhold', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const { runner, recordDecision } = makeRunner();
    await runner.considerAndRun(CTX, 'packet-1:public_web', baseInput({ institutionalItemCount: 0 }));
    const call = recordDecision.mock.calls[0]?.[0] as { status: string; skipReason: string };
    expect(call.status).toBe('skipped');
    expect(call.skipReason).toBe('no_institutional_context');
  });

  test('skips with not_sampled at sample rate 0', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '0';
    const { runner, recordDecision } = makeRunner();
    await runner.considerAndRun(CTX, 'packet-1:public_web', baseInput());
    const call = recordDecision.mock.calls[0]?.[0] as { status: string; skipReason: string };
    expect(call.status).toBe('skipped');
    expect(call.skipReason).toBe('not_sampled');
  });

  test('at sample rate 1: runs the replay, computes finding overlap, and marks completed — never calls addFinding (replay is opaque)', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const { runner, recordDecision, markRunning, markCompleted } = makeRunner();
    await runner.considerAndRun(CTX, 'packet-1:public_web', baseInput());

    expect((recordDecision.mock.calls[0]?.[0] as { status: string }).status).toBe('pending');
    expect(markRunning).toHaveBeenCalledWith('t1', 'eval-1');
    expect(markCompleted).toHaveBeenCalledTimes(1);
    const args = markCompleted.mock.calls[0]?.[2] as { metrics: Record<string, unknown> };
    expect(args.metrics.controlProducedOutput).toBe(true);
    expect(args.metrics.treatmentProposedCount).toBe(3);
    expect(args.metrics.controlProposedCount).toBe(2);
    // Dana Reed + Systems Engineering overlap; Aperture HQ only in treatment.
    expect(args.metrics.findingOverlapRate).toBeCloseTo(2 / 3);
  });

  test('a replay failure marks the row failed instead of throwing', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const { runner, markFailed, markCompleted } = makeRunner();
    await expect(
      runner.considerAndRun(
        CTX,
        'packet-1:public_web',
        baseInput({
          replay: async () => {
            throw new Error('provider timeout');
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markCompleted).not.toHaveBeenCalled();
  });

  test('a duplicate decision never re-runs the replay', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const recordDecision = jest.fn(async () => ({ status: 'duplicate' as const, id: 'existing-eval' }));
    const markRunning = jest.fn();
    const replay = jest.fn(async () => ({ capabilities: [] }));
    const runner = new CrmFillEvaluationRunner({ recordDecision, markRunning } as never);
    await runner.considerAndRun(CTX, 'packet-1:public_web', baseInput({ replay }));
    expect(replay).not.toHaveBeenCalled();
    expect(markRunning).not.toHaveBeenCalled();
  });
});
