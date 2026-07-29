import { describe, expect, it } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import { MemoryStoreService } from './memory-store.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const CLIO = '44444444-4444-4444-8444-444444444444';
const NEW_ITEM = '55555555-5555-4555-8555-555555555555';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: ADMIN,
  clerkUserId: 'user_admin',
  role: 'user_admin',
};

interface HarnessOpts {
  /** memory_items row the verb loads. Slug drives the clio-projection linkage. */
  slug?: string;
  governedStatus?: string;
  /** Non-null = the governed authority gate denies with this reason. */
  denyReason?: string | null;
}

function harness(opts: HarnessOpts = {}) {
  const slug = opts.slug ?? `clio:${CLIO}`;
  const sqls: string[] = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];

  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      sqls.push(sql);
      if (sql.includes('SELECT governed_status FROM memory_items')) {
        return [{ governed_status: opts.governedStatus ?? 'active' }];
      }
      // correctMemory's superseding INSERT ... RETURNING id.
      if (sql.includes('INSERT INTO memory_items')) return [{ id: NEW_ITEM }];
      if (sql.includes('FROM memory_items')) {
        return [
          {
            type: 'note',
            title: 'Firm position',
            slug,
            visibility: 'tenant',
            owner_user_id: null,
            client_id: null,
            entity_id: null,
            tags: [],
            status: 'active',
            legal_hold: false,
          },
        ];
      }
      return [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      sqls.push(strings.join('?'));
      return 1;
    }),
    auditLog: { create: jest.fn(async () => ({ id: 'audit-log' })) },
    memoryTransitionAudit: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditRows.push(args.data);
        return { id: `t-${auditRows.length}` };
      },
    },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: typeof tx) => unknown) =>
      fn(tx),
    ),
  } as unknown as PrismaService;
  const tenantCtx = { require: () => ctx } as unknown as TenantContextStore;
  const authz = {
    loadItemInTx: async () => ({ id: ITEM }),
    evaluateInTx: async () =>
      opts.denyReason ? { allowed: false, reason: opts.denyReason } : { allowed: true },
  } as unknown as MemoryAuthorizationService;
  const cleanupOutbox = {
    enqueue: jest.fn(async (_tx: unknown, _tenantId: string, input: Record<string, unknown>) => {
      enqueued.push(input);
    }),
  } as unknown as MemoryCleanupOutboxService;

  const service = new MemoryStoreService(
    prisma,
    tenantCtx,
    authz,
    new MemoryTransitionAuditService(),
    cleanupOutbox,
  );
  return { service, sqls, auditRows, enqueued, tx };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const originals = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const DARK = {
  MEMORY_GOVERNANCE_LIFECYCLE: undefined,
  MEMORY_GOVERNANCE_ENFORCE: undefined,
};

describe('memory verbs — governance DARK (the prod shape today)', () => {
  /**
   * governed_status does not exist until 20260729010000 is applied. If any of these
   * verbs referenced it while dark, every forget/correct in prod would fail on a
   * missing column.
   */
  it('forget never mentions a governed column', async () => {
    await withEnv(DARK, async () => {
      const h = harness();
      await expect(h.service.forgetMemory(ITEM, 'stale')).resolves.toMatchObject({ found: true });
      expect(h.sqls.some((s) => s.includes('governed_status'))).toBe(false);
    });
  });

  it('forget writes no transition-audit row and enqueues no cleanup job', async () => {
    await withEnv(DARK, async () => {
      const h = harness();
      await h.service.forgetMemory(ITEM);
      expect(h.auditRows).toHaveLength(0);
      expect(h.enqueued).toHaveLength(0);
      // The legacy audit_logs tombstone is untouched by this work.
      expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
    });
  });

  it('correct never mentions a governed column', async () => {
    await withEnv(DARK, async () => {
      const h = harness();
      const result = await h.service.correctMemory(ITEM, 'the FY27 number was restated');
      expect(result.found).toBe(true);
      expect(h.sqls.some((s) => s.includes('governed_status'))).toBe(false);
      expect(h.auditRows).toHaveLength(0);
    });
  });

  it('confirm does not consult the governed authority gate while unarmed', async () => {
    await withEnv(DARK, async () => {
      // denyReason would refuse if the gate ran; dark means it must not.
      const h = harness({ denyReason: 'ethical_wall' });
      await expect(h.service.confirmMemory(ITEM)).resolves.toMatchObject({ found: true });
    });
  });
});

describe('memory verbs — governed lifecycle ARMED', () => {
  it('forget flips the governed status, evidences it, and enqueues cleanup', async () => {
    await withEnv({ ...DARK, MEMORY_GOVERNANCE_LIFECYCLE: 'enforce' }, async () => {
      const h = harness();
      await h.service.forgetMemory(ITEM, 'superseded by the FY27 restatement');
      expect(h.sqls.some((s) => s.includes("SET governed_status = 'revoked'"))).toBe(true);
      expect(h.auditRows).toHaveLength(1);
      expect(h.auditRows[0]).toMatchObject({
        memoryItemId: ITEM,
        memoryCandidateId: null,
        fromStatus: 'active',
        toStatus: 'revoked',
        reasonCode: 'revoked',
        actorUserId: ADMIN,
      });
      expect(h.enqueued).toEqual([
        {
          memoryItemId: ITEM,
          clioMemoryId: CLIO,
          operation: 'revoke_projections',
          idempotencyKey: `revoke:${ITEM}`,
        },
      ]);
    });
  });

  it('carries no clio id for a natively-authored item', async () => {
    await withEnv({ ...DARK, MEMORY_GOVERNANCE_LIFECYCLE: 'enforce' }, async () => {
      const h = harness({ slug: 'firm' });
      await h.service.forgetMemory(ITEM);
      expect(h.enqueued[0]!.clioMemoryId).toBeNull();
    });
  });

  /**
   * 'pending_review' (the column default before classification) has NO outbound edge
   * to 'revoked' in the state machine. Asserting the hop would make an unclassified
   * item impossible to forget, so the row is recorded without a from status instead.
   */
  it('records an unclassified item without inventing an illegal hop', async () => {
    await withEnv({ ...DARK, MEMORY_GOVERNANCE_LIFECYCLE: 'enforce' }, async () => {
      const h = harness({ governedStatus: 'pending_review' });
      await h.service.forgetMemory(ITEM);
      expect(h.auditRows[0]!.fromStatus).toBeNull();
      expect(h.auditRows[0]!.toStatus).toBe('revoked');
      expect((h.auditRows[0]!.metadata as Record<string, unknown>).priorGovernedStatus).toBe(
        'pending_review',
      );
    });
  });

  it('correct supersedes with evidence and a supersede cleanup job', async () => {
    await withEnv({ ...DARK, MEMORY_GOVERNANCE_LIFECYCLE: 'enforce' }, async () => {
      const h = harness();
      await h.service.correctMemory(ITEM, 'the FY27 number was restated');
      expect(h.sqls.some((s) => s.includes("SET governed_status = 'superseded'"))).toBe(true);
      expect(h.auditRows[0]).toMatchObject({
        memoryItemId: ITEM,
        toStatus: 'superseded',
        reasonCode: 'corrected',
      });
      expect((h.auditRows[0]!.metadata as Record<string, unknown>).supersededBy).toBe(NEW_ITEM);
      expect(h.enqueued[0]).toMatchObject({
        memoryItemId: ITEM,
        operation: 'supersede_projections',
        idempotencyKey: `supersede:${ITEM}:${NEW_ITEM}`,
      });
    });
  });

  /** Evidence must be ids only — the corrected text must not reach the audit row. */
  it('never puts corrected content into the transition audit', async () => {
    await withEnv({ ...DARK, MEMORY_GOVERNANCE_LIFECYCLE: 'enforce' }, async () => {
      const h = harness();
      await h.service.correctMemory(ITEM, 'The firm now opposes the plus-up.');
      expect(JSON.stringify(h.auditRows)).not.toContain('plus-up');
    });
  });
});

describe('memory verbs — governed AUTHORITY armed', () => {
  const ARMED = { ...DARK, MEMORY_GOVERNANCE_ENFORCE: 'enforce' };

  /**
   * evaluateMemoryMutation grants ANY admin a shared-scope mutation and knows
   * nothing about the ethical wall, so before this gate an admin walled off a client
   * could still forget that client's memory.
   */
  it('forget is refused when governed authority denies (ethical wall)', async () => {
    await withEnv(ARMED, async () => {
      const h = harness({ denyReason: 'ethical_wall' });
      await expect(h.service.forgetMemory(ITEM)).resolves.toEqual({ found: false });
      expect(h.sqls.some((s) => s.includes("SET status = 'revoked'"))).toBe(false);
    });
  });

  it('surfaces a governed legal hold as blockedByLegalHold, not as not-found', async () => {
    await withEnv(ARMED, async () => {
      const h = harness({ denyReason: 'legal_hold' });
      await expect(h.service.forgetMemory(ITEM)).resolves.toMatchObject({
        found: true,
        blockedByLegalHold: true,
      });
    });
  });

  it('correct is refused when governed authority denies', async () => {
    await withEnv(ARMED, async () => {
      const h = harness({ denyReason: 'missing_grant' });
      await expect(h.service.correctMemory(ITEM, 'new text')).resolves.toEqual({ found: false });
      expect(h.sqls.some((s) => s.includes('INSERT INTO memory_items'))).toBe(false);
    });
  });

  it('confirm is refused when governed authority denies', async () => {
    await withEnv(ARMED, async () => {
      const h = harness({ denyReason: 'revoked_or_terminal' });
      await expect(h.service.confirmMemory(ITEM)).resolves.toEqual({ found: false });
      expect(h.sqls.some((s) => s.includes('last_confirmed_at = now()'))).toBe(false);
    });
  });

  it('allows the verb through when governed authority permits', async () => {
    await withEnv(ARMED, async () => {
      const h = harness({ denyReason: null });
      await expect(h.service.confirmMemory(ITEM)).resolves.toMatchObject({ found: true });
      expect(h.sqls.some((s) => s.includes('last_confirmed_at = now()'))).toBe(true);
    });
  });
});
