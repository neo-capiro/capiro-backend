import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import { EvaluationCaptureService } from './evaluation-capture.service.js';
import type { RecordEvaluationInput } from '@capiro/meriv2-core';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '33333333-3333-4333-8333-333333333333';

function baseInput(overrides: Partial<RecordEvaluationInput> = {}): RecordEvaluationInput {
  return {
    tenantId: TENANT,
    clientId: null,
    surface: 'outreach',
    operation: 'outreach.draft_version.generate',
    evaluationType: 'institutional_context_ablation',
    status: 'pending',
    treatmentArtifactId: 'draft-version-1',
    samplingKey: `${TENANT}:outreach.draft_version.generate:draft-version-1`,
    configVersion: 'evaluation-config-v1',
    observedAt: new Date('2026-08-22T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Minimal fake tx exposing only `evaluationRecord` — mirrors
 * `quality-telemetry-capture.service.spec.ts`'s `fakePrisma` pattern. If the
 * service under test ever reached memoryItem/memoryCandidate/clioMemory/
 * learningSignal/contextPacket write delegates, the call would throw "is
 * not a function" rather than silently pass.
 */
function fakePrisma(
  overrides: {
    createImpl?: jest.Mock;
    findFirstImpl?: jest.Mock;
    updateManyImpl?: jest.Mock;
  } = {},
) {
  const create =
    overrides.createImpl ?? jest.fn(async (args: { data: { tenantId: string } }) => ({ id: 'eval-1', ...args.data }));
  const findFirst = overrides.findFirstImpl ?? jest.fn(async () => null);
  const updateMany = overrides.updateManyImpl ?? jest.fn(async () => ({ count: 1 }));
  const tx = {
    evaluationRecord: { create, findFirst, updateMany },
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: Prisma.TransactionClient) => unknown) => fn(tx)),
  };
  return { prisma, create, findFirst, updateMany };
}

describe('EvaluationCaptureService', () => {
  const priorFlag = process.env.LEARNING_EVALUATION;
  beforeEach(() => {
    process.env.LEARNING_EVALUATION = 'enabled';
  });
  afterAll(() => {
    if (priorFlag === undefined) delete process.env.LEARNING_EVALUATION;
    else process.env.LEARNING_EVALUATION = priorFlag;
  });

  it('records a well-formed pending decision and returns its id', async () => {
    const { prisma, create } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    const result = await service.recordDecision(baseInput());
    expect(result).toEqual({ status: 'recorded', id: 'eval-1' });
    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.tenantId).toBe(TENANT);
    expect(data.status).toBe('pending');
    expect(data.idempotencyKey).toContain('outreach.draft_version.generate');
  });

  it('records a skipped decision with its reason', async () => {
    const { prisma, create } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    await service.recordDecision(baseInput({ status: 'skipped', skipReason: 'not_sampled' }));
    const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('skipped');
    expect(data.skipReason).toBe('not_sampled');
  });

  it('REJECTS a skipped decision with no skipReason before any write', async () => {
    const { prisma, create } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    const result = await service.recordDecision(baseInput({ status: 'skipped', skipReason: null }));
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('is idempotent: a unique-constraint violation on retry returns the existing row, not a failure', async () => {
    const create = jest.fn(async () => {
      throw { code: 'P2002' };
    });
    const findFirst = jest.fn(async () => ({ id: 'existing-eval' }));
    const { prisma } = fakePrisma({ createImpl: create, findFirstImpl: findFirst });
    const service = new EvaluationCaptureService(prisma as never);
    const result = await service.recordDecision(baseInput());
    expect(result).toEqual({ status: 'duplicate', id: 'existing-eval' });
  });

  it('NEVER throws on a database error — resolves to a failed result', async () => {
    const create = jest.fn(async () => {
      throw new Error('connection reset');
    });
    const { prisma } = fakePrisma({ createImpl: create });
    const service = new EvaluationCaptureService(prisma as never);
    const result = await service.recordDecision(baseInput());
    expect(result).toEqual({ status: 'failed', reason: 'connection reset' });
  });

  it('REJECTS confidential-shaped content in metrics before any write (long string)', async () => {
    const { prisma, create } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    const result = await service.recordDecision(
      baseInput({ metrics: { note: 'x'.repeat(500) } as never }),
    );
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('REJECTS a banned content field name in metrics before any write', async () => {
    const { prisma, create } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    const result = await service.recordDecision(baseInput({ metrics: { draft: 'short but banned' } as never }));
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('respects the LEARNING_EVALUATION kill switch — dark by default, no write while unset', async () => {
    delete process.env.LEARNING_EVALUATION;
    const { prisma, create } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    const result = await service.recordDecision(baseInput());
    expect(result).toEqual({ status: 'disabled' });
    expect(create).not.toHaveBeenCalled();
  });

  it('persists the caller-supplied clientId', async () => {
    const { prisma, create } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    await service.recordDecision(baseInput({ clientId: CLIENT }));
    const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.clientId).toBe(CLIENT);
  });

  it('markRunning transitions a pending row to running, scoped to (id, tenantId, status=pending)', async () => {
    const { prisma, updateMany } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    await service.markRunning(TENANT, 'eval-1');
    expect(updateMany).toHaveBeenCalledTimes(1);
    const args = updateMany.mock.calls[0]?.[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(args.where).toEqual({ id: 'eval-1', tenantId: TENANT, status: 'pending' });
    expect(args.data.status).toBe('running');
  });

  it('markCompleted transitions a running row to completed with metrics/cost, scoped to status=running', async () => {
    const { prisma, updateMany } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    await service.markCompleted(TENANT, 'eval-1', {
      treatmentOutputHash: 'hash-a',
      controlOutputHash: 'hash-b',
      controlProjectionPolicy: 'withhold_all_institutional_layers',
      metrics: { normalizedEditDistance: 0.42 },
      cost: { model: 'gpt-5', inputTokens: 100, outputTokens: 50, providerDurationMs: 900, estimatedCostUsd: 0.01 },
    });
    const args = updateMany.mock.calls[0]?.[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(args.where).toEqual({ id: 'eval-1', tenantId: TENANT, status: 'running' });
    expect(args.data.status).toBe('completed');
    expect(args.data.metricsJsonb).toEqual({ normalizedEditDistance: 0.42 });
  });

  it('markCompleted NEVER throws even when the update itself fails — falls back to markFailed', async () => {
    const updateMany = jest.fn(async () => {
      throw new Error('db down');
    });
    const { prisma } = fakePrisma({ updateManyImpl: updateMany });
    const service = new EvaluationCaptureService(prisma as never);
    await expect(service.markCompleted(TENANT, 'eval-1', {})).resolves.toBeUndefined();
    // Called once for the failed completion attempt, once more for markFailed's own update.
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it('markCompleted REJECTS confidential-shaped metrics before any write and falls back to markFailed', async () => {
    const { prisma, updateMany } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    await service.markCompleted(TENANT, 'eval-1', { metrics: { note: 'x'.repeat(500) } as never });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const args = updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data.status).toBe('failed');
  });

  it('markFailed NEVER throws even when the update itself fails', async () => {
    const updateMany = jest.fn(async () => {
      throw new Error('db down');
    });
    const { prisma } = fakePrisma({ updateManyImpl: updateMany });
    const service = new EvaluationCaptureService(prisma as never);
    await expect(service.markFailed(TENANT, 'eval-1', 'provider_timeout')).resolves.toBeUndefined();
  });

  it('never references memoryItem/memoryCandidate/clioMemory/learningSignal/contextPacket Prisma delegates', async () => {
    const { prisma } = fakePrisma();
    const service = new EvaluationCaptureService(prisma as never);
    const result = await service.recordDecision(baseInput());
    expect(result.status).toBe('recorded');
  });
  it('respects the LEARNING_TENANTS rollout bound — no evaluation_record row for a tenant outside the allowlist', async () => {
    const priorTenants = process.env.LEARNING_TENANTS;
    process.env.LEARNING_TENANTS = '99999999-9999-4999-8999-999999999999';
    try {
      const { prisma, create } = fakePrisma();
      const service = new EvaluationCaptureService(prisma as never);
      const result = await service.recordDecision(baseInput());
      expect(result).toEqual({ status: 'disabled' });
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (priorTenants === undefined) delete process.env.LEARNING_TENANTS;
      else process.env.LEARNING_TENANTS = priorTenants;
    }
  });

  it('rollout bound fails closed when LEARNING_TENANTS is unset, even with the global switch enabled', async () => {
    const priorTenants = process.env.LEARNING_TENANTS;
    delete process.env.LEARNING_TENANTS;
    try {
      const { prisma, create } = fakePrisma();
      const service = new EvaluationCaptureService(prisma as never);
      const result = await service.recordDecision(baseInput());
      expect(result).toEqual({ status: 'disabled' });
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (priorTenants === undefined) delete process.env.LEARNING_TENANTS;
      else process.env.LEARNING_TENANTS = priorTenants;
    }
  });

  it('does not write even a skipped/not_sampled decision for a tenant outside the allowlist', async () => {
    const priorTenants = process.env.LEARNING_TENANTS;
    process.env.LEARNING_TENANTS = '99999999-9999-4999-8999-999999999999';
    try {
      const { prisma, create } = fakePrisma();
      const service = new EvaluationCaptureService(prisma as never);
      const result = await service.recordDecision(
        baseInput({ status: 'skipped', skipReason: 'not_sampled' }),
      );
      expect(result).toEqual({ status: 'disabled' });
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (priorTenants === undefined) delete process.env.LEARNING_TENANTS;
      else process.env.LEARNING_TENANTS = priorTenants;
    }
  });

});
