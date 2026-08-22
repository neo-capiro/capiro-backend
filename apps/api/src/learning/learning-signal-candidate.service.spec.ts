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
    clioMessage: {
      // No note by default — resolveFactText returns null, so conflict
      // detection never even calls out (existing tests stay inert to it).
      findFirst: jest.fn(async (..._args: unknown[]): Promise<unknown> => null),
    },
    $queryRawUnsafe: jest.fn(async (..._args: unknown[]): Promise<unknown[]> => [{ allowed: true }]), // clientMemoryAllowed
    $queryRaw: jest.fn(async (..._args: unknown[]): Promise<Array<{ id: string; status: string }>> => []), // findExactDuplicate / CRM finding lookup — no match by default
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
  const conflictDetection = {
    findBestActiveMemoryMatch: jest.fn(async (..._args: unknown[]): Promise<unknown> => null),
  };
  const service = new LearningSignalCandidateService(
    prisma as never,
    candidates as unknown as MemoryCandidateService,
    conflictDetection as never,
  );
  return { service, tx, prisma, candidates, conflictDetection, outcomeStore };
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
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'existing-candidate-1', status: 'pending' }]);
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('duplicate');
    expect(result?.memoryCandidateId).toBeNull();
    expect(result?.reason).toContain('existing-candidate-1');
    expect(result?.reason).not.toContain('rejected');
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  // Phase 27D §17: rejection durability. The next identical signal for the
  // same (clientId, kind, targetKey) must not silently recreate a candidate
  // a reviewer already turned down, as though the rejection never happened.
  it('rejection durability: a same-proposition signal after a REJECTED candidate is suppressed, not resubmitted', async () => {
    const { service, tx, candidates } = buildHarness(crmSignal());
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'rejected-candidate-1', status: 'rejected' }]);
    const result = await service.generateForSignal(TENANT, SIGNAL);
    expect(result?.eligibility).toBe('duplicate');
    expect(result?.memoryCandidateId).toBeNull();
    expect(result?.reason).toContain('rejected-candidate-1');
    expect(result?.reason.toLowerCase()).toContain('rejected');
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('rejection durability query matches rejected alongside the live statuses, ordered by recency', async () => {
    const { service, tx } = buildHarness(crmSignal());
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'rejected-candidate-1', status: 'rejected' }]);
    await service.generateForSignal(TENANT, SIGNAL);
    const [sqlArg] = tx.$queryRaw.mock.calls[0] as [{ raw?: string[] } | string];
    const sql = Array.isArray((sqlArg as { raw?: string[] }).raw)
      ? (sqlArg as { raw: string[] }).raw.join('?')
      : String(sqlArg);
    expect(sql).toMatch(/'rejected'/);
    expect(sql).toMatch(/ORDER BY created_at DESC/i);
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

  describe('Phase 27C: conflict detection against active memory', () => {
    it('a Meri signal with no note never calls conflict detection at all (nothing to compare)', async () => {
      const { service, conflictDetection } = buildHarness(
        meriSignal({ provenanceJsonb: { hasNote: false, reasons: ['inaccurate'] } }),
      );
      await service.generateForSignal(TENANT, SIGNAL);
      expect(conflictDetection.findBestActiveMemoryMatch).not.toHaveBeenCalled();
    });

    it('a Meri signal WITH a note fetches it (ephemerally) and calls conflict detection', async () => {
      const { service, tx, conflictDetection } = buildHarness(meriSignal());
      (tx.clioMessage.findFirst as any).mockResolvedValueOnce({
        metadata: { feedback: { note: 'Please keep responses under 3 sentences going forward.' } },
      });
      await service.generateForSignal(TENANT, SIGNAL);
      expect(conflictDetection.findBestActiveMemoryMatch).toHaveBeenCalledTimes(1);
      const [scope, factText] = (conflictDetection.findBestActiveMemoryMatch as any).mock
        .calls[0] as [unknown, string];
      expect(scope).toMatchObject({ tenantId: TENANT, clientId: null, actorUserId: ACTOR });
      expect(factText).toContain('3 sentences');
    });

    it('CRM signal fetches the finding\'s proposed value and calls conflict detection', async () => {
      const { service, tx, conflictDetection } = buildHarness(crmSignal());
      // findExactDuplicate's own $queryRaw call runs first (no match), then
      // every later call (resolveFactText's finding lookup) gets the
      // proposedValue row.
      (tx.$queryRaw as any).mockResolvedValueOnce([]);
      (tx.$queryRaw as any).mockImplementation(async (..._args: unknown[]) => [
        { proposedValue: { value: 'weekly' } },
      ]);
      await service.generateForSignal(TENANT, SIGNAL);
      expect(conflictDetection.findBestActiveMemoryMatch).toHaveBeenCalledTimes(1);
      const [, factText] = (conflictDetection.findBestActiveMemoryMatch as any).mock.calls[0] as [
        unknown,
        string,
      ];
      expect(factText).toContain('weekly');
    });

    it("'duplicate' match: no candidate created, outcome recorded as duplicate", async () => {
      const { service, tx, candidates, conflictDetection } = buildHarness(meriSignal());
      (tx.clioMessage.findFirst as any).mockResolvedValueOnce({
        metadata: { feedback: { note: 'Keep it short please.' } },
      });
      conflictDetection.findBestActiveMemoryMatch.mockResolvedValueOnce({
        kind: 'duplicate',
        score: 0.97,
        memoryItemId: 'item-1',
        slug: 'clio:item-1',
        title: 'User prefers short replies',
      } as never);
      const result = await service.generateForSignal(TENANT, SIGNAL);
      expect(result?.eligibility).toBe('duplicate');
      expect(result?.memoryCandidateId).toBeNull();
      expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
    });

    it("CORE EXAMPLE — 'probable_contradiction' match: candidate IS still created, flagged, active item never touched", async () => {
      const { service, tx, candidates, conflictDetection } = buildHarness(crmSignal());
      // Same ordering note as the test above: findExactDuplicate's call
      // must see no match before resolveFactText's finding lookup runs.
      (tx.$queryRaw as any).mockResolvedValueOnce([]);
      (tx.$queryRaw as any).mockImplementation(async (..._args: unknown[]) => [
        { proposedValue: { value: 'weekly' } },
      ]);
      conflictDetection.findBestActiveMemoryMatch.mockResolvedValueOnce({
        kind: 'probable_contradiction',
        score: 0.94,
        memoryItemId: 'item-monthly-1',
        slug: 'clio:item-monthly-1',
        title: 'Client wants monthly congressional updates',
      } as never);

      const result = await service.generateForSignal(TENANT, SIGNAL);

      expect(result?.eligibility).toBe('eligible'); // still a candidate — preserved, not discarded
      expect(candidates.proposeSaveMemory).toHaveBeenCalledTimes(1);
      const [, , record] = candidates.proposeSaveMemory.mock.calls[0] as [unknown, unknown, any];
      expect(record.contradictsMemoryItemId).toBe('item-monthly-1');
      expect(record.conflictStatus).toBe('open');
      expect(result?.reason).toContain('item-monthly-1');
      expect(result?.reason).toMatch(/contradiction/i);
      // The active item itself is never written — this service has no
      // memoryItem.update/create call anywhere; asserting the fake tx
      // exposes no such delegate is the structural guard.
      expect((tx as any).memoryItem).toBeUndefined();
    });

    it("'possible_related' match: candidate created and flagged the same way as a probable contradiction, weaker language", async () => {
      const { service, tx, candidates, conflictDetection } = buildHarness(meriSignal());
      (tx.clioMessage.findFirst as any).mockResolvedValueOnce({
        metadata: { feedback: { note: 'Some note long enough to pass the length gate.' } },
      });
      conflictDetection.findBestActiveMemoryMatch.mockResolvedValueOnce({
        kind: 'possible_related',
        score: 0.8,
        memoryItemId: 'item-2',
        slug: 'clio:item-2',
        title: 'Some related preference',
      } as never);
      const result = await service.generateForSignal(TENANT, SIGNAL);
      expect(result?.eligibility).toBe('eligible');
      const [, , record] = candidates.proposeSaveMemory.mock.calls[0] as [unknown, unknown, any];
      expect(record.contradictsMemoryItemId).toBe('item-2');
      expect(record.conflictStatus).toBe('open');
      expect(result?.reason).toMatch(/possibly related/i);
    });

    it('no match (null): candidate created with no conflict fields set at all', async () => {
      const { service, tx, candidates, conflictDetection } = buildHarness(meriSignal());
      (tx.clioMessage.findFirst as any).mockResolvedValueOnce({
        metadata: { feedback: { note: 'Some note long enough to pass the length gate.' } },
      });
      conflictDetection.findBestActiveMemoryMatch.mockResolvedValueOnce(null as never);
      await service.generateForSignal(TENANT, SIGNAL);
      expect(conflictDetection.findBestActiveMemoryMatch).toHaveBeenCalledTimes(1);
      const [, , record] = candidates.proposeSaveMemory.mock.calls[0] as [unknown, unknown, any];
      expect(record.contradictsMemoryItemId).toBeUndefined();
      expect(record.conflictStatus).toBeUndefined();
    });
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
