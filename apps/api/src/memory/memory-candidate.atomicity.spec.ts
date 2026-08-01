import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfig } from '../config/config.schema.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const PROPOSER = '44444444-4444-4444-8444-444444444444';
const REVIEWER_A = '55555555-5555-4555-8555-555555555555';
const REVIEWER_B = '66666666-6666-4666-8666-666666666666';

interface CandidateState {
  id: string;
  tenantId: string;
  payload: Record<string, unknown>;
  proposedBy: string;
  scope: string;
  sourceKind: string;
  clientId: string | null;
  status: string;
  governedStatus: string;
  committedMemoryId: string | null;
  committedMemoryItemId: string | null;
  decidedBy: string | null;
}

interface MemoryState {
  id: string;
  tenantId: string;
  scope: string;
  ownerUserId: string | null;
  clientId: string | null;
  key: string;
  value: string;
}

interface HarnessOptions {
  candidates?: CandidateState[];
  transitionAudit?: MemoryTransitionAuditService;
}

function sqlText(strings: unknown): string {
  return Array.isArray((strings as { raw?: string[] }).raw)
    ? (strings as { raw: string[] }).raw.join('?')
    : String(strings);
}

function cloneCandidates(source: Map<string, CandidateState>): Map<string, CandidateState> {
  return new Map([...source].map(([id, row]) => [id, structuredClone(row)]));
}

function cloneMemories(source: Map<string, MemoryState>): Map<string, MemoryState> {
  return new Map([...source].map(([id, row]) => [id, structuredClone(row)]));
}

function makeHarness(options: HarnessOptions = {}) {
  const candidates = new Map<string, CandidateState>();
  for (const row of options.candidates ?? []) candidates.set(row.id, structuredClone(row));
  const memories = new Map<string, MemoryState>();
  const canonicalItems: Array<{ id: string; params: unknown[] }> = [];
  const outbox: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let memorySequence = 0;
  let candidateSequence = 0;
  let transactionSequence = 0;
  let serialized = Promise.resolve();
  const operationTransactions: number[] = [];

  const makeTx = (transactionId: number) => ({
    memoryCandidate: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        operationTransactions.push(transactionId);
        const row = candidates.get(args.where.id);
        if (!row) throw new Error('candidate missing');
        Object.assign(row, {
          status: args.data.status ?? row.status,
          decidedBy: args.data.decidedBy ?? row.decidedBy,
          committedMemoryId: args.data.committedMemoryId ?? row.committedMemoryId,
          committedMemoryItemId: args.data.committedMemoryItemId ?? row.committedMemoryItemId,
          governedStatus: args.data.governedStatus ?? row.governedStatus,
        });
        return row;
      },
    },
    clioMemory: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        operationTransactions.push(transactionId);
        return (
          [...memories.values()].find(
            (m) =>
              m.tenantId === args.where.tenantId &&
              m.scope === args.where.scope &&
              m.ownerUserId === args.where.ownerUserId &&
              m.clientId === args.where.clientId &&
              m.key === args.where.key,
          ) ?? null
        );
      },
      create: async (args: { data: Record<string, unknown> }) => {
        operationTransactions.push(transactionId);
        memorySequence += 1;
        const id = `77777777-7777-4777-8777-${String(memorySequence).padStart(12, '0')}`;
        memories.set(id, {
          id,
          tenantId: String(args.data.tenantId),
          scope: String(args.data.scope),
          ownerUserId: (args.data.ownerUserId as string | null) ?? null,
          clientId: (args.data.clientId as string | null) ?? null,
          key: String(args.data.key),
          value: String(args.data.value),
        });
        return { id };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        operationTransactions.push(transactionId);
        const row = memories.get(args.where.id);
        if (!row) throw new Error('memory missing');
        row.value = String(args.data.value);
        return row;
      },
    },
    memoryTransitionAudit: {
      create: async (args: { data: Record<string, unknown> }) => {
        operationTransactions.push(transactionId);
        audits.push(structuredClone(args.data));
        return { id: `audit-${audits.length}` };
      },
    },
    $queryRaw: async (strings: unknown, ...params: unknown[]) => {
      operationTransactions.push(transactionId);
      const sql = sqlText(strings);
      if (/FOR UPDATE/i.test(sql)) {
        const candidateId = String(params[0]);
        const tenantId = String(params[1]);
        const row = candidates.get(candidateId);
        if (!row || row.tenantId !== tenantId || row.status !== 'pending') return [];
        return [
          {
            id: row.id,
            payload: structuredClone(row.payload),
            proposedBy: row.proposedBy,
            scope: row.scope,
            sourceKind: row.sourceKind,
          },
        ];
      }
      if (/INSERT INTO memory_candidate/i.test(sql)) {
        candidateSequence += 1;
        const id = `88888888-8888-4888-8888-${String(candidateSequence).padStart(12, '0')}`;
        const payload = JSON.parse(String(params[5])) as Record<string, unknown>;
        candidates.set(id, {
          id,
          tenantId: String(params[0]),
          proposedBy: String(params[1]),
          sourceKind: String(params[2]),
          scope: String(params[3]),
          clientId: (params[4] as string | null) ?? null,
          payload,
          status: 'pending',
          governedStatus: 'suggested',
          committedMemoryId: null,
          committedMemoryItemId: null,
          decidedBy: null,
        });
        return [{ id }];
      }
      if (/JOIN clio_memory/i.test(sql)) return [];
      if (/updated_at\s+FROM\s+clio_memory/i.test(sql)) {
        return [{ updated_at: new Date('2026-07-30T00:00:00.000Z') }];
      }
      if (/INSERT INTO memory_items/i.test(sql)) {
        const id = '99999999-9999-4999-8999-000000000001';
        canonicalItems.push({ id, params: structuredClone(params) });
        return [{ id }];
      }
      if (/governed_status/i.test(sql)) {
        const candidateId = String(params[0]);
        const tenantId = String(params[1]);
        const row = candidates.get(candidateId);
        if (!row || row.tenantId !== tenantId) return [];
        return [
          {
            scope: row.scope,
            source_kind: row.sourceKind,
            client_id: row.clientId,
            governed_status: row.governedStatus,
            expires_at:
              typeof row.payload.expiresAt === 'string' ? String(row.payload.expiresAt) : null,
          },
        ];
      }
      return [];
    },
    $executeRaw: async (strings: unknown, ...params: unknown[]) => {
      operationTransactions.push(transactionId);
      const sql = sqlText(strings);
      if (/INSERT INTO memory_cleanup_outbox/i.test(sql)) {
        outbox.push({
          tenantId: params[0],
          memoryItemId: params[1],
          clioMemoryId: params[2],
          operation: params[3],
          idempotencyKey: params[4],
        });
      }
      return 1;
    },
    $executeRawUnsafe: async () => 1,
  });

  const withTenantUser = jest.fn(
    async <T>(
      _tenantId: string,
      _userId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const previous = serialized;
      let release!: () => void;
      serialized = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;

      transactionSequence += 1;
      const transactionId = transactionSequence;
      const candidateSnapshot = cloneCandidates(candidates);
      const memorySnapshot = cloneMemories(memories);
      const canonicalSnapshot = structuredClone(canonicalItems);
      const outboxSnapshot = structuredClone(outbox);
      const auditSnapshot = structuredClone(audits);
      const memorySequenceSnapshot = memorySequence;
      const candidateSequenceSnapshot = candidateSequence;
      try {
        return await fn(makeTx(transactionId) as unknown as Prisma.TransactionClient);
      } catch (error) {
        candidates.clear();
        for (const [id, row] of candidateSnapshot) candidates.set(id, row);
        memories.clear();
        for (const [id, row] of memorySnapshot) memories.set(id, row);
        canonicalItems.splice(0, canonicalItems.length, ...canonicalSnapshot);
        outbox.splice(0, outbox.length, ...outboxSnapshot);
        audits.splice(0, audits.length, ...auditSnapshot);
        memorySequence = memorySequenceSnapshot;
        candidateSequence = candidateSequenceSnapshot;
        throw error;
      } finally {
        release();
      }
    },
  );

  const systemTx = {
    $executeRaw: async () => 1,
  };
  const prisma = {
    withTenantUser,
    withSystem: jest.fn(async (fn: (tx: unknown) => unknown) => fn(systemTx)),
  } as unknown as PrismaService;
  const ingest = {
    projectClioMemory: jest.fn(async () => undefined),
  } as unknown as MemoryIngestService;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>;
  const service = new MemoryCandidateService(
    prisma,
    ingest,
    config,
    options.transitionAudit ?? new MemoryTransitionAuditService(),
  );

  return {
    service,
    candidates,
    memories,
    canonicalItems,
    outbox,
    audits,
    withTenantUser,
    operationTransactions,
  };
}

function firmCandidate(overrides: Partial<CandidateState> = {}): CandidateState {
  return {
    id: CANDIDATE,
    tenantId: TENANT_A,
    payload: {
      scope: 'firm',
      ownerUserId: null,
      clientId: null,
      key: 'firm-position:fy27',
      value: 'Support the plus-up.',
      source: 'chat',
    },
    proposedBy: PROPOSER,
    scope: 'firm',
    sourceKind: 'explicit_user',
    clientId: null,
    status: 'pending',
    governedStatus: 'pending_review',
    committedMemoryId: null,
    committedMemoryItemId: null,
    decidedBy: null,
    ...overrides,
  };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const originals = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const DARK = {
  MEMORY_GOVERNANCE_ENFORCE: undefined,
  MEMORY_GOVERNANCE_LIFECYCLE: undefined,
};

describe('MemoryCandidateService atomic activation', () => {
  it('allows exactly one of two simultaneous approvals to activate the candidate', async () => {
    await withEnv(DARK, async () => {
      const h = makeHarness({ candidates: [firmCandidate()] });
      const outcomes = await Promise.allSettled([
        h.service.approve(TENANT_A, CANDIDATE, REVIEWER_A),
        h.service.approve(TENANT_A, CANDIDATE, REVIEWER_B),
      ]);

      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({ reason: expect.any(NotFoundException) });
      expect(h.memories.size).toBe(1);
      expect(h.outbox).toHaveLength(1);
      expect(h.candidates.get(CANDIDATE)).toMatchObject({
        status: 'approved',
        committedMemoryId: [...h.memories.keys()][0],
      });
    });
  });

  it('records exact canonical item lineage when governed activation is armed', async () => {
    await withEnv(
      { MEMORY_GOVERNANCE_ENFORCE: undefined, MEMORY_GOVERNANCE_LIFECYCLE: 'enforce' },
      async () => {
        const h = makeHarness({ candidates: [firmCandidate()] });
        await h.service.approve(TENANT_A, CANDIDATE, REVIEWER_A);

        expect(h.canonicalItems).toHaveLength(1);
        expect(h.candidates.get(CANDIDATE)).toMatchObject({
          status: 'approved',
          committedMemoryId: [...h.memories.keys()][0],
          committedMemoryItemId: h.canonicalItems[0]?.id,
        });
        expect(h.outbox).toEqual([
          expect.objectContaining({ memoryItemId: h.canonicalItems[0]?.id }),
        ]);
      },
    );
  });

  it('rolls back candidate, memory, audit, and outbox when a post-insert audit step fails', async () => {
    await withEnv(
      { MEMORY_GOVERNANCE_ENFORCE: undefined, MEMORY_GOVERNANCE_LIFECYCLE: 'enforce' },
      async () => {
        const transitionAudit = new MemoryTransitionAuditService();
        jest.spyOn(transitionAudit, 'record').mockImplementation(async (tx, tenantId, input) => {
          await tx.memoryTransitionAudit.create({
            data: {
              tenantId,
              memoryItemId: null,
              memoryCandidateId: input.subject.memoryCandidateId ?? null,
              actorUserId: input.actorUserId ?? null,
              effectiveTenantId: tenantId,
              clientId: null,
              fromStatus: input.fromStatus ?? null,
              toStatus: input.toStatus,
              reasonCode: input.reasonCode,
              reason: 'test',
              metadata: {},
            },
          });
          throw new Error('audit write failed after memory insert');
        });
        const h = makeHarness({ candidates: [firmCandidate()], transitionAudit });

        await expect(h.service.approve(TENANT_A, CANDIDATE, REVIEWER_A)).rejects.toThrow(
          'audit write failed after memory insert',
        );
        expect(h.candidates.get(CANDIDATE)).toMatchObject({
          status: 'pending',
          committedMemoryId: null,
          decidedBy: null,
        });
        expect(h.memories.size).toBe(0);
        expect(h.canonicalItems).toHaveLength(0);
        expect(h.outbox).toHaveLength(0);
        expect(h.audits).toHaveLength(0);
      },
    );
  });

  it('rejects re-approval of a terminal candidate without creating a second version', async () => {
    await withEnv(DARK, async () => {
      const h = makeHarness({ candidates: [firmCandidate()] });
      await h.service.approve(TENANT_A, CANDIDATE, REVIEWER_A);
      await expect(h.service.approve(TENANT_A, CANDIDATE, REVIEWER_B)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(h.memories.size).toBe(1);
      expect(h.outbox).toHaveLength(1);
    });
  });

  it('does not reveal whether a candidate id belongs to another tenant', async () => {
    await withEnv(DARK, async () => {
      const h = makeHarness({ candidates: [firmCandidate()] });
      const crossTenant = await h.service
        .approve(TENANT_B, CANDIDATE, REVIEWER_A)
        .catch((error: unknown) => error);
      const absent = await h.service
        .approve(TENANT_A, '99999999-9999-4999-8999-999999999999', REVIEWER_A)
        .catch((error: unknown) => error);

      expect(crossTenant).toBeInstanceOf(NotFoundException);
      expect(absent).toBeInstanceOf(NotFoundException);
      expect((crossTenant as Error).message).toBe((absent as Error).message);
      expect(h.memories.size).toBe(0);
      expect(h.outbox).toHaveLength(0);
    });
  });

  it('activates personal memory, decision, lineage, and outbox in one transaction', async () => {
    await withEnv(DARK, async () => {
      const h = makeHarness();
      const result = await h.service.proposeSaveMemory(
        TENANT_A,
        PROPOSER,
        {
          scope: 'user_private',
          ownerUserId: PROPOSER,
          key: 'preference:briefing-style',
          value: 'Lead with the decision.',
          source: 'explicit_user',
        },
        false,
      );

      expect(result).toMatchObject({ status: 'auto_committed', memoryId: expect.any(String) });
      expect(h.withTenantUser).toHaveBeenCalledTimes(1);
      expect(new Set(h.operationTransactions)).toEqual(new Set([1]));
      expect(h.candidates.get(result.candidateId)).toMatchObject({
        status: 'auto_committed',
        committedMemoryId: result.memoryId,
      });
      expect(h.memories.size).toBe(1);
      expect(h.outbox).toHaveLength(1);
    });
  });
});
