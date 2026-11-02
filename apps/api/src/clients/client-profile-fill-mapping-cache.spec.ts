import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ClientReadCache, clientIntelligenceReads } from '../intelligence/client-read-cache.js';
import { ClientMappingV1Review } from '../intelligence/client-mapping-v1-review.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { commitReviewedFindings } from './client-profile-fill-review-store.js';
import { reviewHash } from './client-profile-fill-review-snapshot.js';
import type { AdvancedFindingRow } from './client-profile-fill-finding-review.shared.js';

describe('reviewed LDA mapping cache effects', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const clientId = '00000000-0000-4000-8000-000000000002';
  const ctx = { tenantId, userId: '00000000-0000-4000-8000-000000000003',
    clerkUserId: 'clerk-user', role: 'user_admin' } as TenantContext;
  const runId = '00000000-0000-4000-8000-000000000004';
  const finding: AdvancedFindingRow = {
    id: '00000000-0000-4000-8000-000000000005', kind: 'lda_identity',
    targetKey: 'lda', source: 'lda', factKind: 'identity', currentValue: null,
    proposedValue: { externalId: 'lda-client', externalName: 'Reviewed client' },
    evidence: [], confidence: 1, status: 'pending', contentHash: 'reviewed',
  };

  async function harness(options: { rollback?: boolean; rejectAcceptance?: boolean } = {}) {
    let committed = false;
    let receipt: any = null;
    const statements: string[] = [];
    const tx = {
      tenantMembership: { findFirst: jest.fn(async () => ({ role: 'user_admin' })) },
      client: { findFirst: jest.fn(async () => ({ id: clientId, tenantId })) },
      clientIntelMapping: {
        findUnique: jest.fn(async () => null),
        upsert: jest.fn(async ({ create }: any) => ({ id: 'mapping', ...create })),
      },
      auditLog: {
        findFirst: jest.fn(async () => receipt),
        create: jest.fn(async ({ data }: any) => {
          if (data.action === 'client_profile_fill.reviewed_application') receipt = data;
          return data;
        }),
      },
      $queryRaw: jest.fn(async (query: any) => {
        const sql = Array.isArray(query) ? query.join('') : query.sql;
        if (sql.includes('account_owner_version')) return [{ version: 0, primary: null }];
        if (sql.includes('tenant_memberships')) return [{ role: 'user_admin' }];
        if (sql.includes('client_memory_access')) return [];
        throw new Error(`Unexpected authority query: ${sql}`);
      }),
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        if (sql.includes('AS allowed')) return [{ allowed: true }];
        if (sql.includes('SELECT to_jsonb')) return [];
        if (sql.includes('FROM client_profile_fill_run')) return [{ id: runId }];
        if (sql.includes('FROM client_profile_fill_finding')) return [finding];
        throw new Error(`Unexpected review query: ${sql}`);
      }),
      $executeRawUnsafe: jest.fn(async (sql: string) => {
        statements.push(sql);
        return sql.startsWith('UPDATE') && options.rejectAcceptance ? 0 : 1;
      }),
    };
    const intelligence = {} as { createManualMappingInTransaction: ClientMappingV1Review['createManualMappingInTransaction'] };
    const reads = clientIntelligenceReads(intelligence);
    const key = ClientReadCache.key(tenantId, clientId);
    const otherClient = ClientReadCache.key(tenantId, 'other-client');
    const otherTenant = ClientReadCache.key('other-tenant', clientId);
    const tracked = { total: 1, issueCodes: [], bills: [] };
    const regulations = { links: [], totalBills: 1, totalRegulations: 0 };
    async function prime() {
      for (const cacheKey of [key, otherClient, otherTenant]) {
        await reads.trackedBills.remember(cacheKey, async () => tracked);
        await reads.regulationLinks.remember(cacheKey, async () => regulations);
      }
    }
    await prime();
    const prisma = {
      withTenantUser: jest.fn(async (_tenant: string, _user: string, work: (value: typeof tx) => Promise<unknown>) => {
        const result = await work(tx);
        // The real transaction owner must not clear either cache before commit.
        expect(reads.trackedBills.get(key)).toBe(tracked);
        expect(reads.regulationLinks.get(key)).toBe(regulations);
        if (options.rollback) throw new Error('simulated outer commit failure');
        committed = true;
        return result;
      }),
    } as unknown as PrismaService;
    const mapping = new ClientMappingV1Review(prisma, {
      awardBearingMappingSource: () => false, prepopulation: () => undefined, clientReads: () => reads,
    });
    intelligence.createManualMappingInTransaction = mapping.createManualMappingInTransaction.bind(mapping);
    const fill: ClientProfileFillService = Object.assign(Object.create(ClientProfileFillService.prototype), { intelligence });
    const command = {
      requestId: '00000000-0000-4000-8000-000000000006',
      expectedClientRevision: reviewHash(Array.from({ length: 8 }, () => [])),
      findings: [{ id: finding.id, revision: reviewHash(finding) }],
    };
    const apply = () => commitReviewedFindings(prisma, ctx, clientId, runId, command,
      (scope, selected) => fill.applyFindingInTransaction(scope, ctx, clientId, selected), { warn: jest.fn() });
    return { apply, prime, reads, key, otherClient, otherTenant, tracked, regulations, tx, statements,
      committed: () => committed };
  }

  it('invalidates both reads after a successful commit and isolates other clients and tenants', async () => {
    const h = await harness();
    expect(await h.apply()).toMatchObject({ status: 'completed', applied: [finding.id], replayed: false });
    expect(h.committed()).toBe(true);
    expect(h.tx.clientIntelMapping.upsert).toHaveBeenCalledTimes(1);
    expect(h.reads.trackedBills.get(h.key)).toBeUndefined();
    expect(h.reads.regulationLinks.get(h.key)).toBeUndefined();
    for (const key of [h.otherClient, h.otherTenant]) {
      expect(h.reads.trackedBills.get(key)).toBe(h.tracked);
      expect(h.reads.regulationLinks.get(key)).toBe(h.regulations);
    }
    const rebuild = jest.fn(async () => ({ total: 2, issueCodes: [], bills: [] }));
    expect((await h.reads.trackedBills.remember(h.key, rebuild)).total).toBe(2);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('preserves both reads if the outer transaction fails to commit', async () => {
    const h = await harness({ rollback: true });
    await expect(h.apply()).rejects.toThrow('simulated outer commit failure');
    expect(h.tx.clientIntelMapping.upsert).toHaveBeenCalledTimes(1);
    expect(h.committed()).toBe(false);
    expect(h.reads.trackedBills.get(h.key)).toBe(h.tracked);
    expect(h.reads.regulationLinks.get(h.key)).toBe(h.regulations);
  });

  it('discards the mapping effect when finding acceptance rolls back to its savepoint', async () => {
    const h = await harness({ rejectAcceptance: true });
    expect(await h.apply()).toMatchObject({ status: 'refused', applied: [], replayed: false });
    expect(h.tx.clientIntelMapping.upsert).toHaveBeenCalledTimes(1);
    expect(h.statements).toContain('ROLLBACK TO SAVEPOINT reviewed_finding');
    expect(h.committed()).toBe(true);
    expect(h.reads.trackedBills.get(h.key)).toBe(h.tracked);
    expect(h.reads.regulationLinks.get(h.key)).toBe(h.regulations);
  });

  it('does not repeat writes or invalidate refreshed reads when replaying a committed receipt', async () => {
    const h = await harness();
    await h.apply();
    await h.prime();
    expect(await h.apply()).toMatchObject({ status: 'completed', applied: [finding.id], replayed: true });
    expect(h.tx.clientIntelMapping.upsert).toHaveBeenCalledTimes(1);
    expect(h.reads.trackedBills.get(h.key)).toBe(h.tracked);
    expect(h.reads.regulationLinks.get(h.key)).toBe(h.regulations);
  });
});
