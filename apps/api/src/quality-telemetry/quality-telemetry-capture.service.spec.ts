import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import { QualityTelemetryCaptureService } from './quality-telemetry-capture.service.js';
import type { RecordQualityTelemetryEventInput } from '@capiro/meriv2-core';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

function baseInput(overrides: Partial<RecordQualityTelemetryEventInput> = {}): RecordQualityTelemetryEventInput {
  return {
    tenantId: TENANT,
    actorUserId: USER,
    clientId: null,
    surface: 'crm_fill',
    operation: 'crm_fill.finding.decide',
    eventType: 'approved',
    artifactType: 'crm_fill_finding',
    artifactId: 'finding-1',
    contextPacketId: null,
    provenance: {},
    observedAt: new Date('2026-08-21T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Minimal fake tx exposing only `qualityTelemetryEvent`/`auditLog` — mirrors
 * `learning-signal-capture.service.spec.ts`'s fakeTx pattern. Deliberately
 * does NOT expose memoryItem/memoryCandidate/clioMemory/learningSignal: if
 * the service under test ever reached one of those, the call would throw
 * "not a function" and fail the test — a structural guard against Phase 27E
 * writing anything but its own two tables.
 */
function fakePrisma(overrides: {
  createImpl?: jest.Mock;
  findFirstImpl?: jest.Mock;
  auditLogCreateImpl?: jest.Mock;
} = {}) {
  const create =
    overrides.createImpl ?? jest.fn(async (args: { data: { tenantId: string } }) => ({ id: 'event-1', ...args.data }));
  const findFirst = overrides.findFirstImpl ?? jest.fn(async () => null);
  const auditLogCreate =
    overrides.auditLogCreateImpl ?? jest.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'audit-1' }));
  const tx = {
    qualityTelemetryEvent: { create, findFirst },
    auditLog: { create: auditLogCreate },
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: Prisma.TransactionClient) => unknown) => fn(tx)),
  };
  return { prisma, create, findFirst, auditLogCreate };
}

describe('QualityTelemetryCaptureService', () => {
  const priorFlag = process.env.LEARNING_QUALITY_TELEMETRY;
  beforeEach(() => {
    process.env.LEARNING_QUALITY_TELEMETRY = 'enabled';
  });
  afterAll(() => {
    if (priorFlag === undefined) delete process.env.LEARNING_QUALITY_TELEMETRY;
    else process.env.LEARNING_QUALITY_TELEMETRY = priorFlag;
  });

  it('records a well-formed event and returns its id', async () => {
    const { prisma, create } = fakePrisma();
    const service = new QualityTelemetryCaptureService(prisma as never);
    const result = await service.recordEvent(baseInput());
    expect(result).toEqual({ status: 'recorded', id: 'event-1' });
    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.tenantId).toBe(TENANT);
    expect(data.idempotencyKey).toContain('crm_fill');
  });

  it('is idempotent: a unique-constraint violation on retry returns the existing row, not a failure', async () => {
    const create = jest.fn(async () => {
      throw { code: 'P2002' };
    });
    const findFirst = jest.fn(async () => ({ id: 'existing-event' }));
    const { prisma } = fakePrisma({ createImpl: create, findFirstImpl: findFirst });
    const service = new QualityTelemetryCaptureService(prisma as never);
    const result = await service.recordEvent(baseInput());
    expect(result).toEqual({ status: 'duplicate', id: 'existing-event' });
  });

  it('NEVER throws on a database error — resolves to a failed result and records a safe failure audit row', async () => {
    const create = jest.fn(async () => {
      throw new Error('connection reset');
    });
    const { prisma, auditLogCreate } = fakePrisma({ createImpl: create });
    const service = new QualityTelemetryCaptureService(prisma as never);
    const result = await service.recordEvent(baseInput());
    expect(result).toEqual({ status: 'failed', reason: 'connection reset' });
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const data = (auditLogCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.action).toBe('quality_telemetry.record_failed');
  });

  it('NEVER throws on invalid input either — validation failures resolve to a failed result, not a rejection', async () => {
    const { prisma, create } = fakePrisma();
    const service = new QualityTelemetryCaptureService(prisma as never);
    const result = await service.recordEvent(baseInput({ tenantId: '' }));
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('REJECTS confidential-shaped content before any write (long string)', async () => {
    const { prisma, create } = fakePrisma();
    const service = new QualityTelemetryCaptureService(prisma as never);
    const result = await service.recordEvent(
      baseInput({ provenance: { reasonCode: 'x'.repeat(500) } }),
    );
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('REJECTS a banned content field name before any write', async () => {
    const { prisma, create } = fakePrisma();
    const service = new QualityTelemetryCaptureService(prisma as never);
    const result = await service.recordEvent(baseInput({ provenance: { note: 'short but banned' } }));
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('REJECTS a sixth/unknown context layer in memoryItemUses before any write', async () => {
    const { prisma, create } = fakePrisma();
    const service = new QualityTelemetryCaptureService(prisma as never);
    const result = await service.recordEvent(
      baseInput({ memoryItemUses: [{ memoryItemId: 'm-1', contextLayer: 'external-research' as never }] }),
    );
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('persists the caller-supplied clientId for a client-scoped event', async () => {
    const { prisma, create } = fakePrisma();
    const service = new QualityTelemetryCaptureService(prisma as never);
    await service.recordEvent(baseInput({ clientId: CLIENT }));
    const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.clientId).toBe(CLIENT);
  });

  it('respects the LEARNING_QUALITY_TELEMETRY kill switch — dark by default, no write while unset', async () => {
    delete process.env.LEARNING_QUALITY_TELEMETRY;
    const { prisma, create } = fakePrisma();
    const service = new QualityTelemetryCaptureService(prisma as never);
    const result = await service.recordEvent(baseInput());
    expect(result).toEqual({ status: 'disabled' });
    expect(create).not.toHaveBeenCalled();
  });

  it('never references memoryItem/memoryCandidate/clioMemory/learningSignal Prisma delegates', async () => {
    // The fake tx above exposes ONLY qualityTelemetryEvent/auditLog. If
    // recordEvent ever touched one of the governed-write delegates it would
    // throw "is not a function" here, not silently pass — this test's mere
    // success (recorded, not failed) is the assertion.
    const { prisma } = fakePrisma();
    const service = new QualityTelemetryCaptureService(prisma as never);
    const result = await service.recordEvent(baseInput());
    expect(result.status).toBe('recorded');
  });
  it('respects the LEARNING_TENANTS rollout bound — no write for a tenant outside the allowlist', async () => {
    const priorTenants = process.env.LEARNING_TENANTS;
    process.env.LEARNING_TENANTS = '99999999-9999-4999-8999-999999999999';
    try {
      const { prisma, create } = fakePrisma();
      const service = new QualityTelemetryCaptureService(prisma as never);
      const result = await service.recordEvent(baseInput());
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
      const service = new QualityTelemetryCaptureService(prisma as never);
      const result = await service.recordEvent(baseInput());
      expect(result).toEqual({ status: 'disabled' });
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (priorTenants === undefined) delete process.env.LEARNING_TENANTS;
      else process.env.LEARNING_TENANTS = priorTenants;
    }
  });

  it('still reports a missing tenantId as an input failure, not as a rollout decline', async () => {
    const priorTenants = process.env.LEARNING_TENANTS;
    process.env.LEARNING_TENANTS = 'all';
    try {
      const { prisma, create } = fakePrisma();
      const service = new QualityTelemetryCaptureService(prisma as never);
      const result = await service.recordEvent(baseInput({ tenantId: '' }));
      expect(result.status).toBe('failed');
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (priorTenants === undefined) delete process.env.LEARNING_TENANTS;
      else process.env.LEARNING_TENANTS = priorTenants;
    }
  });

});
