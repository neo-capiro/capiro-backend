import { describe, expect, it } from '@jest/globals';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { AppConfig } from '../config/config.schema.js';
import type { ConfigService } from '@nestjs/config';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const CLIO = '44444444-4444-4444-8444-444444444444';

interface CandidateRow {
  scope: string;
  source_kind: string;
  client_id: string | null;
  governed_status: string;
  expires_at: string | null;
}

/**
 * Drives `approve` end-to-end with everything below markDecided stubbed, so the
 * assertions are entirely about what the DECISION writes: the legacy columns, the
 * governed columns, and the audit rows.
 */
function harness(row: CandidateRow, payload: unknown = { key: 'k', value: 'v', source: 'chat' }) {
  const updates: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const tx = {
    memoryCandidate: {
      findFirst: async () => ({
        id: CANDIDATE,
        payload,
        proposedBy: 'proposer-1',
        scope: row.scope,
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return {};
      },
    },
    memoryTransitionAudit: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditRows.push(args.data);
        return { id: `audit-${auditRows.length}` };
      },
    },
    $queryRaw: async () => [row],
  };
  const withTenant = jest.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx));
  const prisma = { withTenant } as unknown as PrismaService;
  const ingest = { projectClioMemory: () => undefined } as unknown as MemoryIngestService;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>;
  const service = new MemoryCandidateService(
    prisma,
    ingest,
    config,
    new MemoryTransitionAuditService(),
  );
  // commitToClioMemory is the pre-existing, separately-tested clio write path; the
  // subject here is the DECISION bookkeeping around it.
  (service as unknown as { commitToClioMemory: () => Promise<string> }).commitToClioMemory =
    async () => CLIO;
  return { service, updates, auditRows, withTenant };
}

const FIRM_ROW: CandidateRow = {
  scope: 'firm',
  source_kind: 'explicit_user',
  client_id: null,
  governed_status: 'pending_review',
  expires_at: null,
};

function withLifecycle<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  if (value === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  else process.env.MEMORY_GOVERNANCE_LIFECYCLE = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = original;
  });
}

describe('MemoryCandidateService governed lifecycle — OFF (the prod shape today)', () => {
  /**
   * Both governance migrations are unapplied everywhere. If the OFF path wrote a
   * governed column, every memory save in prod would fail on a missing column — so
   * the write must be exactly the four legacy fields and nothing else.
   */
  it('writes only the legacy decision fields and no governed column', async () => {
    await withLifecycle(undefined, async () => {
      const h = harness(FIRM_ROW);
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      expect(h.updates).toHaveLength(1);
      expect(Object.keys(h.updates[0]!).sort()).toEqual([
        'committedMemoryId',
        'decidedAt',
        'decidedBy',
        'status',
      ]);
      expect(h.updates[0]!.status).toBe('approved');
    });
  });

  it('writes no transition-audit row at all', async () => {
    await withLifecycle(undefined, async () => {
      const h = harness(FIRM_ROW);
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      expect(h.auditRows).toHaveLength(0);
    });
  });

  it('stays off for truthy-looking values', async () => {
    for (const raw of ['true', '1', 'on']) {
      await withLifecycle(raw, async () => {
        const h = harness(FIRM_ROW);
        await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
        expect(h.auditRows).toHaveLength(0);
      });
    }
  });
});

describe('MemoryCandidateService governed lifecycle — ARMED', () => {
  it('classifies a firm approval and stamps the approval columns', async () => {
    await withLifecycle('enforce', async () => {
      const h = harness(FIRM_ROW);
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      const data = h.updates[0]!;
      expect(data).toMatchObject({
        status: 'approved',
        memoryClass: 'institutional_authoritative',
        memoryScope: 'firm',
        memoryAuthority: 'firm_approved',
        governedStatus: 'active',
        approvedByUserId: 'reviewer-1',
      });
      expect(data.approvedAt).toBeInstanceOf(Date);
    });
  });

  it('records one audit row per state-machine hop, in the same transaction', async () => {
    await withLifecycle('enforce', async () => {
      const h = harness(FIRM_ROW);
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      expect(h.auditRows).toHaveLength(1);
      expect(h.auditRows[0]).toMatchObject({
        tenantId: TENANT,
        memoryCandidateId: CANDIDATE,
        memoryItemId: null,
        fromStatus: 'pending_review',
        toStatus: 'active',
        reasonCode: 'approved',
        actorUserId: 'reviewer-1',
      });
      // The decision update and the audit row share ONE withTenant transaction, so
      // a committed status flip cannot lose its evidence.
      expect(h.withTenant).toHaveBeenCalledTimes(2); // getPendingOrThrow + markDecided
    });
  });

  it('routes a still-suggested candidate through the submission hop first', async () => {
    await withLifecycle('enforce', async () => {
      const h = harness({ ...FIRM_ROW, governed_status: 'suggested' });
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      expect(h.auditRows.map((r) => r.toStatus)).toEqual(['pending_review', 'active']);
      expect(h.auditRows.map((r) => r.reasonCode)).toEqual(['submitted_for_review', 'approved']);
    });
  });

  it('classifies a client-scope approval as client steering and carries the client id', async () => {
    await withLifecycle('enforce', async () => {
      const h = harness({ ...FIRM_ROW, scope: 'client', client_id: CLIENT });
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      expect(h.updates[0]).toMatchObject({
        memoryClass: 'client_steering',
        memoryScope: 'client',
        memoryAuthority: 'client_approved',
      });
      expect(h.auditRows[0]!.clientId).toBe(CLIENT);
    });
  });

  it('rejects without granting any authority and without stamping approval', async () => {
    await withLifecycle('enforce', async () => {
      const h = harness(FIRM_ROW);
      await h.service.reject(TENANT, CANDIDATE, 'reviewer-1');
      const data = h.updates[0]!;
      expect(data.status).toBe('rejected');
      expect(data.governedStatus).toBe('rejected');
      expect(data).not.toHaveProperty('memoryAuthority');
      expect(data).not.toHaveProperty('approvedByUserId');
      expect(h.auditRows[0]).toMatchObject({ toStatus: 'rejected', reasonCode: 'rejected' });
    });
  });

  /** The audit table is ids/status/reason only; the proposed value must not leak. */
  it('never puts the proposed memory value into the audit row', async () => {
    await withLifecycle('enforce', async () => {
      const h = harness(FIRM_ROW, {
        key: 'firm-position:fy27',
        value: 'The firm supports the plus-up.',
        source: 'chat',
      });
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      const serialized = JSON.stringify(h.auditRows);
      expect(serialized).not.toContain('plus-up');
      expect(h.auditRows[0]!.metadata).toMatchObject({ clioMemoryId: CLIO });
    });
  });

  /**
   * memory_candidate_ephemeral_ttl_check rejects episodic_working without a TTL, so
   * the class and the expires_at column must be written together.
   */
  it('writes expires_at alongside an episodic_working classification', async () => {
    await withLifecycle('enforce', async () => {
      const h = harness({
        ...FIRM_ROW,
        scope: 'personal',
        expires_at: '2030-01-01T00:00:00.000Z',
      });
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      expect(h.updates[0]!.memoryClass).toBe('episodic_working');
      expect(h.updates[0]!.expiresAt).toBeInstanceOf(Date);
    });
  });

  it('does not claim episodic_working for a personal save with no TTL', async () => {
    await withLifecycle('enforce', async () => {
      const h = harness({ ...FIRM_ROW, scope: 'personal' });
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      expect(h.updates[0]!.memoryClass).toBe('user_preference');
      expect(h.updates[0]).not.toHaveProperty('expiresAt');
    });
  });

  /**
   * committed_memory_item_id carries an FK to memory_items, but commitToClioMemory
   * returns a clio_memory id and the memory_items projection is written
   * asynchronously by projectClioMemory. Writing the clio id there would be an FK
   * violation, so the id goes in the audit metadata instead.
   */
  it('does not put a clio id into the memory_items lineage column', async () => {
    await withLifecycle('enforce', async () => {
      const h = harness(FIRM_ROW);
      await h.service.approve(TENANT, CANDIDATE, 'reviewer-1');
      expect(h.updates[0]).not.toHaveProperty('committedMemoryItemId');
      expect(h.updates[0]!.committedMemoryId).toBe(CLIO);
    });
  });
});
