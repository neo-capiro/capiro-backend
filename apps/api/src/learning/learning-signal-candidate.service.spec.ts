import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import {
  LearningSignalCandidateService,
  learningCandidateGenerationEnabled,
} from './learning-signal-candidate.service.js';
import type { MemoryCandidateService } from '../memory/memory-candidate.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const OTHER_ACTOR = '77777777-7777-4777-8777-777777777777';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const OTHER_CLIENT = '88888888-8888-4888-8888-888888888888';
const SIGNAL = '44444444-4444-4444-8444-444444444444';

interface FakeSignal {
  id: string;
  tenantId: string;
  actorUserId: string;
  clientId: string | null;
  sourceSurface: string;
  signalType: string;
  proposedMemoryLayer: string | null;
  evidenceJsonb: unknown;
  sensitivity: string;
  provenanceKind: string;
  provenanceJsonb: unknown;
}

function meriSignal(overrides: Partial<FakeSignal> = {}): FakeSignal {
  return {
    id: SIGNAL,
    tenantId: TENANT,
    actorUserId: ACTOR,
    clientId: null,
    sourceSurface: 'meri.chat',
    signalType: 'meri_feedback_negative',
    proposedMemoryLayer: 'user-voice',
    evidenceJsonb: [{ type: 'clio_message', id: 'msg-1' }],
    sensitivity: 'normal',
    provenanceKind: 'human_explicit',
    provenanceJsonb: { hasNote: true, reasons: [] },
    ...overrides,
  };
}

function crmSignal(overrides: Partial<FakeSignal> = {}): FakeSignal {
  return {
    id: SIGNAL,
    tenantId: TENANT,
    actorUserId: ACTOR,
    clientId: CLIENT,
    sourceSurface: 'crm.fill_with_meri',
    signalType: 'crm_finding_accepted',
    proposedMemoryLayer: 'client-steering',
    evidenceJsonb: [{ type: 'client_profile_fill_finding', id: 'finding-1' }],
    sensitivity: 'normal',
    provenanceKind: 'human_explicit',
    provenanceJsonb: { kind: 'government_identity', targetKey: 'duns', source: 'sam_gov' },
    ...overrides,
  };
}

function buildHarness(signal: FakeSignal | null) {
  const outcomeStore = new Map<string, any>();
  const tx = {
    learningSignalCandidateOutcome: {
      findUnique: jest.fn(async ({ where }: any) => outcomeStore.get(where.learningSignalId) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = outcomeStore.get(where.learningSignalId);
        if (!row) throw new Error('not found');
        return row;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (outcomeStore.has(data.learningSignalId)) {
          const err: any = new Error('duplicate');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: 'outcome-1', decidedAt: new Date(), ...data };
        outcomeStore.set(data.learningSignalId, row);
        return row;
      }),
    },
    learningSignal: {
      findFirst: jest.fn(async () => signal),
    },
    memoryCandidate: {
      findFirst: jest.fn(async () => ({ id: 'winning-candidate-1' })),
    },
    $queryRawUnsafe: jest.fn(async (..._args: unknown[]): Promise<unknown[]> => [{ allowed: true }]), // clientMemoryAllowed
    $queryRaw: jest.fn(async (..._args: unknown[]): Promise<Array<{ id: string }>> => []), // findExactDuplicate — no duplicate by default
  };
  const prisma = { withTenant: jest.fn((_tenantId: string, cb: (tx: unknown) => unknown) => cb(tx)) };
  const candidates = {
    proposeSaveMemory: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
      candidateId: 'candidate-1',
      status: 'pending',
      memoryId: null,
      ruleId: 'memory.learning_signal.requires_review',
      reason: 'test',
    })),
  };
  const service = new LearningSignalCandidateService(
    prisma as never,
    candidates as unknown as MemoryCandidateService,
  );
  return { service, tx, prisma, candidates, outcomeStore };
}

describe('learningCandidateGenerationEnabled (Phase 27B kill switch)', () => {
  it('is dark by default — unlike capture, undefined/empty means DISABLED', () => {
    expect(learningCandidateGenerationEnabled(undefined)).toBe(false);
    expect(learningCandidateGenerationEnabled('')).toBe(false);
    expect(learningCandidateGenerationEnabled('disabled')).toBe(false);
  });

  it('requires the exact literal "enabled" to arm', () => {
    expect(learningCandidateGenerationEnabled('enabled')).toBe(true);
    expect(learningCandidateGenerationEnabled('ENABLED')).toBe(true);
    expect(learningCandidateGenerationEnabled('true')).toBe(false);
    expect(learningCandidateGenerationEnabled('1')).toBe(false);
  });
});

describe('LearningSignalCandidateService', () => {
  const prior = process.env.LEARNING_CANDIDATE_GENERATION;

  beforeEach(() => {
    process.env.LEARNING_CANDIDATE_GENERATION = 'enabled';
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.LEARNING_CANDIDATE_GENERATION;
    else process.env.LEARNING_CANDIDATE_GENERATION = prior;
  });

  it('kill switch OFF: returns null immediately, touches no tables at all', async () => {
    process.env.LEARNING_CANDIDATE_GENERATION = 'disabled';
    const { service, tx } = buildHarness(meriSignal());
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result).toBeNull();
    expect(tx.learningSignal.findFirst).not.toHaveBeenCalled();
    expect(tx.learningSignalCandidateOutcome.create).not.toHaveBeenCalled();
  });

  it('idempotent: a signal already decided is returned as-is, without re-reading the signal', async () => {
    const { service, tx, outcomeStore } = buildHarness(meriSignal());
    outcomeStore.set(SIGNAL, {
      learningSignalId: SIGNAL,
      eligibility: 'eligible',
      reason: 'already decided',
      memoryCandidateId: 'candidate-old',
    });
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result).toEqual({
      learningSignalId: SIGNAL,
      eligibility: 'eligible',
      reason: 'already decided',
      memoryCandidateId: 'candidate-old',
    });
    expect(tx.learningSignal.findFirst).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the signal does not exist for this tenant', async () => {
    const { service } = buildHarness(null);
    await expect(service.generateForSignal(TENANT, SIGNAL)).rejects.toThrow(NotFoundException);
  });

  it('CRITICAL RULE: a rejected CRM finding never calls proposeSaveMemory and is recorded negative_feedback_only', async () => {
    const { service, candidates, outcomeStore } = buildHarness(
      crmSignal({ signalType: 'crm_finding_rejected' }),
    );
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('negative_feedback_only');
    expect(result?.memoryCandidateId).toBeNull();
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
    expect(outcomeStore.get(SIGNAL).eligibility).toBe('negative_feedback_only');
  });

  it('a bare Meri rating with no note and no reasons is insufficient_evidence, no candidate created', async () => {
    const { service, candidates } = buildHarness(
      meriSignal({ provenanceJsonb: { hasNote: false, reasons: [] } }),
    );
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('insufficient_evidence');
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('AI-only provenance never reaches proposeSaveMemory', async () => {
    const { service, candidates } = buildHarness(meriSignal({ provenanceKind: 'ai_generated_only' }));
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('ai_only');
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('restricted sensitivity is blocked_by_policy, no candidate created', async () => {
    const { service, candidates } = buildHarness(meriSignal({ sensitivity: 'restricted' }));
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('blocked_by_policy');
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('ethical wall: a client-scoped signal whose client the actor can no longer see is blocked_by_policy', async () => {
    const { service, tx, candidates } = buildHarness(crmSignal());
    tx.$queryRawUnsafe.mockResolvedValueOnce([{ allowed: false }]);
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('blocked_by_policy');
    expect(result?.reason).toMatch(/ethical-wall/i);
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('exact duplicate (same client/kind/targetKey) is recorded duplicate, no new candidate created', async () => {
    const { service, tx, candidates } = buildHarness(crmSignal());
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'existing-candidate-1' }]);
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('duplicate');
    expect(result?.memoryCandidateId).toBeNull();
    expect(result?.reason).toContain('existing-candidate-1');
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('eligible Meri signal: proposeSaveMemory called with user_private scope, ownerUserId = signal.actorUserId, never firm', async () => {
    const { service, candidates, outcomeStore } = buildHarness(meriSignal());
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('eligible');
    expect(result?.memoryCandidateId).toBe('candidate-1');
    expect(candidates.proposeSaveMemory).toHaveBeenCalledTimes(1);
    const [calledTenantId, calledActorId, record, isAdmin, sourceKind] =
      candidates.proposeSaveMemory.mock.calls[0] as [string, string, any, boolean, string];
    expect(calledTenantId).toBe(TENANT);
    expect(calledActorId).toBe(ACTOR);
    expect(record.scope).toBe('user_private');
    expect(record.ownerUserId).toBe(ACTOR);
    expect(record.clientId).toBeNull();
    expect(record.sourceType).toBe('learning_signal_capture');
    expect(record.sourceId).toBe(SIGNAL);
    expect(record.proposedMemoryClass).toBe('user_preference');
    expect(record.proposedMemoryAuthority).toBe('user_asserted');
    expect(isAdmin).toBe(false);
    expect(sourceKind).toBe('learning_signal');
    expect(outcomeStore.get(SIGNAL).memoryCandidateId).toBe('candidate-1');
  });

  it('eligible CRM signal: scope is client, clientId is exactly the signal\'s own clientId — never widened to firm', async () => {
    const { service, candidates } = buildHarness(crmSignal());
    await service.generateForSignal(TENANT, SIGNAL);
    const [, , record] = candidates.proposeSaveMemory.mock.calls[0] as [string, string, any];
    expect(record.scope).toBe('client');
    expect(record.clientId).toBe(CLIENT);
    expect(record.ownerUserId).toBeNull();
    expect(record.proposedMemoryClass).toBe('client_steering');
    expect(record.proposedMemoryAuthority).toBe('external_authoritative'); // sam_gov
  });

  it('SECURITY: a client A signal can never be proposed as a client B candidate — clientId always comes from the loaded signal row', async () => {
    const { service, candidates } = buildHarness(crmSignal({ clientId: CLIENT }));
    await service.generateForSignal(TENANT, SIGNAL);
    const [, , record] = candidates.proposeSaveMemory.mock.calls[0] as [string, string, any];
    expect(record.clientId).toBe(CLIENT);
    expect(record.clientId).not.toBe(OTHER_CLIENT);
  });

  it('SECURITY: actorUserId always comes from the loaded signal row, never any other identity', async () => {
    const { service, candidates } = buildHarness(meriSignal({ actorUserId: ACTOR }));
    await service.generateForSignal(TENANT, SIGNAL);
    const [, calledActorId] = candidates.proposeSaveMemory.mock.calls[0] as [string, string];
    expect(calledActorId).toBe(ACTOR);
    expect(calledActorId).not.toBe(OTHER_ACTOR);
  });

  it('defensive: throws if proposeSaveMemory ever resolves anything other than pending (the never-auto-commit guard failing to fire)', async () => {
    const { service, candidates } = buildHarness(meriSignal());
    candidates.proposeSaveMemory.mockResolvedValueOnce({
      candidateId: 'candidate-x',
      status: 'auto_committed',
      memoryId: 'memory-x',
      ruleId: 'memory.personal.auto_commit',
      reason: 'test',
    } as never);
    await expect(service.generateForSignal(TENANT, SIGNAL)).rejects.toThrow(/unexpectedly resolved/);
  });

  it('idempotent under a concurrent race: a unique-violation on the partial index is recovered, not rethrown', async () => {
    const { service, tx, candidates } = buildHarness(meriSignal());
    const raceError = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `23505`.', {
      code: 'P2010',
      clientVersion: '5.22.0',
      meta: { code: '23505', message: 'duplicate key' },
    });
    candidates.proposeSaveMemory.mockRejectedValueOnce(raceError);
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('eligible');
    expect(result?.memoryCandidateId).toBe('winning-candidate-1');
    expect(tx.memoryCandidate.findFirst).toHaveBeenCalledTimes(1);
  });

  it('rethrows a genuine (non-unique-violation) proposeSaveMemory error rather than swallowing it', async () => {
    const { service, candidates } = buildHarness(meriSignal());
    candidates.proposeSaveMemory.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.generateForSignal(TENANT, SIGNAL)).rejects.toThrow('connection reset');
  });

  describe('processBatch', () => {
    it('kill switch OFF returns an empty array without touching the database', async () => {
      process.env.LEARNING_CANDIDATE_GENERATION = 'disabled';
      const { service, tx } = buildHarness(meriSignal());
      const result = await service.processBatch(TENANT);
      expect(result).toEqual([]);
      expect(tx.learningSignal.findFirst).not.toHaveBeenCalled();
    });

    it('one failing signal does not stop the rest of the batch from processing', async () => {
      const { service, tx, prisma } = buildHarness(meriSignal());
      prisma.withTenant = jest.fn((_t: string, cb: (tx: unknown) => unknown) => cb(tx)) as never;
      (tx.learningSignal as any).findMany = jest.fn(async () => [{ id: 'sig-a' }, { id: 'sig-b' }]);
      const spy = jest
        .spyOn(service, 'generateForSignal')
        .mockRejectedValueOnce(new Error('boom on sig-a'))
        .mockResolvedValueOnce({
          learningSignalId: 'sig-b',
          eligibility: 'eligible',
          reason: 'ok',
          memoryCandidateId: 'candidate-b',
        });
      const results = await service.processBatch(TENANT);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(results).toEqual([
        { learningSignalId: 'sig-b', eligibility: 'eligible', reason: 'ok', memoryCandidateId: 'candidate-b' },
      ]);
    });
  });
});
