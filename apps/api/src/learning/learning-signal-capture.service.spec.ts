import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import { LearningSignalCaptureService } from './learning-signal-capture.service.js';
import type { CaptureLearningSignalInput } from '@capiro/meriv2-core';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

function baseInput(overrides: Partial<CaptureLearningSignalInput> = {}): CaptureLearningSignalInput {
  return {
    tenantId: TENANT,
    actorUserId: USER,
    clientId: null,
    sourceSurface: 'meri.chat',
    sourceObjectType: 'clio_message',
    sourceObjectId: 'msg-1',
    sourceRunId: null,
    signalType: 'meri_feedback_negative',
    proposedMemoryLayer: null,
    proposedMemoryClass: null,
    evidenceRefs: [{ type: 'clio_message', id: 'msg-1' }],
    confidence: null,
    sourceAuthority: null,
    sensitivity: 'normal',
    provenanceKind: 'human_explicit',
    provenance: {},
    governanceRequirement: 'human_required',
    observedAt: new Date('2026-08-21T00:00:00.000Z'),
    ...overrides,
  };
}

/** Minimal fake tx exposing only `learningSignal` — mirrors the mocked-tx
 * pattern used throughout apps/api/src/memory/*.spec.ts (e.g.
 * memory-governance-action.service.spec.ts). Deliberately does NOT expose
 * memoryItem/memoryCandidate/clioMemory: if the service under test ever
 * tried to reach one of those, the call would throw "not a function" and
 * fail the test — a structural guard against 27A writing active memory. */
function fakeTx(overrides: { createImpl?: jest.Mock; findFirstImpl?: jest.Mock } = {}) {
  const create =
    overrides.createImpl ?? jest.fn(async (args: { data: { tenantId: string } }) => ({ id: 'signal-1', ...args.data }));
  const findFirst = overrides.findFirstImpl ?? jest.fn(async () => null);
  return {
    tx: { learningSignal: { create, findFirst } } as unknown as Prisma.TransactionClient,
    create,
    findFirst,
  };
}

describe('LearningSignalCaptureService', () => {
  it('captures a well-formed signal and returns its id', async () => {
    const service = new LearningSignalCaptureService();
    const { tx, create } = fakeTx();
    const result = await service.capture(tx, baseInput());
    expect(result.status).toBe('captured');
    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.tenantId).toBe(TENANT);
    expect(data.actorUserId).toBe(USER);
    expect(data.idempotencyKey).toContain('meri.chat');
  });

  it('is idempotent: a unique-constraint violation on retry returns the existing row, not an error', async () => {
    const service = new LearningSignalCaptureService();
    const create = jest.fn(async () => {
      throw { code: 'P2002' };
    });
    const findFirst = jest.fn(async () => ({ id: 'existing-signal' }));
    const { tx } = fakeTx({ createImpl: create, findFirstImpl: findFirst });
    const result = await service.capture(tx, baseInput());
    expect(result).toEqual({ status: 'duplicate', id: 'existing-signal' });
  });

  it('rethrows a non-unique-violation database error rather than swallowing it', async () => {
    const service = new LearningSignalCaptureService();
    const create = jest.fn(async () => {
      throw new Error('connection reset');
    });
    const { tx } = fakeTx({ createImpl: create });
    await expect(service.capture(tx, baseInput())).rejects.toThrow('connection reset');
  });

  it('rejects a missing tenantId before touching the database', async () => {
    const service = new LearningSignalCaptureService();
    const { tx, create } = fakeTx();
    await expect(service.capture(tx, baseInput({ tenantId: '' }))).rejects.toThrow(/tenantId is required/);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a missing actorUserId before touching the database — no signal can be attributed to "nobody"', async () => {
    const service = new LearningSignalCaptureService();
    const { tx, create } = fakeTx();
    await expect(service.capture(tx, baseInput({ actorUserId: '' }))).rejects.toThrow(/actorUserId is required/);
    expect(create).not.toHaveBeenCalled();
  });

  it('REJECTS AI-only provenance claiming human-tier authority — anti-feedback-loop guard fires before any write', async () => {
    const service = new LearningSignalCaptureService();
    const { tx, create } = fakeTx();
    await expect(
      service.capture(tx, baseInput({ provenanceKind: 'ai_generated_only', sourceAuthority: 'user_asserted' })),
    ).rejects.toThrow(/AI-generated content cannot be its own evidence/);
    expect(create).not.toHaveBeenCalled();
  });

  it('REJECTS a sixth/unknown proposed memory layer before any write', async () => {
    const service = new LearningSignalCaptureService();
    const { tx, create } = fakeTx();
    await expect(
      service.capture(tx, baseInput({ proposedMemoryLayer: 'external-research' as never })),
    ).rejects.toThrow(/not one of the five frozen context layers/);
    expect(create).not.toHaveBeenCalled();
  });

  it('REJECTS a proposed memory layer with zero evidence refs before any write', async () => {
    const service = new LearningSignalCaptureService();
    const { tx, create } = fakeTx();
    await expect(
      service.capture(tx, baseInput({ proposedMemoryLayer: 'user-voice', evidenceRefs: [] })),
    ).rejects.toThrow(/must carry at least one evidence reference/);
    expect(create).not.toHaveBeenCalled();
  });

  it('persists the caller-supplied clientId for a client-scoped signal', async () => {
    const service = new LearningSignalCaptureService();
    const { tx, create } = fakeTx();
    await service.capture(tx, baseInput({ clientId: CLIENT, sourceSurface: 'crm.fill_with_meri' }));
    const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.clientId).toBe(CLIENT);
  });

  it('never references memory_items/memory_candidate/clio_memory Prisma delegates', async () => {
    // The fakeTx above exposes ONLY `learningSignal`. If capture() ever
    // touched tx.memoryItem / tx.memoryCandidate / tx.clioMemory it would
    // throw "tx.memoryItem is not a function" here, not silently pass —
    // this test's mere success is the assertion.
    const service = new LearningSignalCaptureService();
    const { tx } = fakeTx();
    const result = await service.capture(tx, baseInput());
    expect(result.status).toBe('captured');
  });
});
