import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import { MemoryGovernanceReadService } from './memory-governance-read.service.js';
import * as centerSwitch from './memory-governance-center.switch.js';
import type { Prisma } from '@prisma/client';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_admin',
  role: 'user_admin',
};

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('MemoryGovernanceReadService', () => {
  it('binds title search before the limit and retains tenant, wall, and per-item authorization', async () => {
    const enabled = jest.spyOn(centerSwitch, 'memoryGovernanceCenterEnabled').mockReturnValue(true);
    const query = "crm_finding_accepted:%_' OR true --";
    const deniedClient = '33333333-3333-4333-8333-333333333333';
    const rows = ['allowed', 'denied'].map((id) => ({
      id,
      title: query,
      governedStatus: 'active',
      updatedAt: new Date('2026-09-10'),
    }));
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{ id: deniedClient }]),
      $queryRaw: jest.fn(async (_sql: Prisma.Sql) => rows),
    };
    const withTenantUser = jest.fn(
      async (_tenant: string, _user: string, run: (tx: unknown) => Promise<unknown>) => run(tx),
    );
    const authorization = {
      loadItemInTx: jest.fn(async (_tx: unknown, _tenant: string, id: string) => ({ id })),
      evaluateInTx: jest.fn(
        async (_tx: unknown, _ctx: unknown, item: { id: string }, action: string) => ({
          allowed: item.id === 'allowed' && action === 'read',
        }),
      ),
    };
    try {
      const service = new MemoryGovernanceReadService(
        { withTenantUser } as unknown as PrismaService,
        authorization as unknown as MemoryAuthorizationService,
        {} as MemoryCandidateReviewService,
      );
      const result = await service.listItems(ctx, 'active', 250, `  ${query}  `);
      expect(result.items.map((item) => item.id)).toEqual(['allowed']);
      const sql = tx.$queryRaw.mock.calls[0]![0];
      expect(sql.sql).toContain('strpos(lower(mi.title), lower(?)) > 0');
      expect(sql.sql.indexOf('strpos')).toBeLessThan(sql.sql.indexOf('LIMIT'));
      expect(sql.sql).not.toContain(query);
      expect(sql.values).toEqual([ctx.tenantId, ctx.userId, query, 250]);
      expect(sql.sql).toContain("mi.visibility = 'tenant' OR mi.owner_user_id");
      expect(sql.sql).toContain(deniedClient);
      expect(withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function));
      expect(authorization.evaluateInTx).toHaveBeenCalledWith(tx, ctx, { id: 'denied' }, 'read');
    } finally {
      enabled.mockRestore();
    }
  });

  it('keeps the existing bounded listing when search is empty', async () => {
    const enabled = jest.spyOn(centerSwitch, 'memoryGovernanceCenterEnabled').mockReturnValue(true);
    const tx = {
      $queryRawUnsafe: jest.fn(async () => []),
      $queryRaw: jest.fn(async (_sql: Prisma.Sql) => []),
    };
    try {
      const service = new MemoryGovernanceReadService(
        {
          withTenantUser: async (_t: string, _u: string, run: (tx: unknown) => Promise<unknown>) =>
            run(tx),
        } as unknown as PrismaService,
        {} as MemoryAuthorizationService,
        {} as MemoryCandidateReviewService,
      );
      await service.listItems(ctx, 'active', 999, '   ');
      expect(tx.$queryRaw.mock.calls[0]![0].sql).not.toContain('strpos');
      expect(tx.$queryRaw.mock.calls[0]![0].values.at(-1)).toBe(250);
    } finally {
      enabled.mockRestore();
    }
  });

  it('rejects an oversized search before querying memory', async () => {
    const enabled = jest.spyOn(centerSwitch, 'memoryGovernanceCenterEnabled').mockReturnValue(true);
    const withTenantUser = jest.fn();
    try {
      const service = new MemoryGovernanceReadService(
        { withTenantUser } as unknown as PrismaService,
        {} as MemoryAuthorizationService,
        {} as MemoryCandidateReviewService,
      );
      await expect(service.listItems(ctx, 'active', 250, 'x'.repeat(201))).rejects.toThrow(
        'at most 200 characters',
      );
      expect(withTenantUser).not.toHaveBeenCalled();
    } finally {
      enabled.mockRestore();
    }
  });

  it('returns empty disabled projections without touching governed tables while dark', async () => {
    const prior = {
      center: process.env.MEMORY_GOVERNANCE_CENTER,
      lifecycle: process.env.MEMORY_GOVERNANCE_LIFECYCLE,
      enforce: process.env.MEMORY_GOVERNANCE_ENFORCE,
    };
    delete process.env.MEMORY_GOVERNANCE_CENTER;
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    delete process.env.MEMORY_GOVERNANCE_ENFORCE;

    try {
      const withTenantUser = jest.fn();
      const service = new MemoryGovernanceReadService(
        { withTenantUser } as unknown as PrismaService,
        {} as MemoryAuthorizationService,
        { listReviewable: jest.fn() } as unknown as MemoryCandidateReviewService,
      );

      await expect(service.overview(ctx)).resolves.toMatchObject({ enabled: false });
      await expect(service.listItems(ctx, 'active')).resolves.toEqual({
        enabled: false,
        items: [],
      });
      await expect(service.getItem(ctx, 'item-1')).resolves.toEqual({
        enabled: false,
        item: null,
      });
      await expect(service.listTransitions(ctx)).resolves.toEqual({
        enabled: false,
        transitions: [],
      });
      await expect(service.projectionHealth(ctx)).resolves.toMatchObject({
        enabled: false,
        recentFailures: [],
      });
      await expect(service.listClients(ctx)).resolves.toEqual({
        enabled: false,
        clients: [],
      });
      expect(withTenantUser).not.toHaveBeenCalled();
    } finally {
      restore('MEMORY_GOVERNANCE_CENTER', prior.center);
      restore('MEMORY_GOVERNANCE_LIFECYCLE', prior.lifecycle);
      restore('MEMORY_GOVERNANCE_ENFORCE', prior.enforce);
    }
  });

  it('uses immutable occurred_at evidence and client-wall filtering in the read model', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/memory/memory-governance-read.service.ts'),
      'utf8',
    );
    expect(source).toContain('a.occurred_at AS "occurredAt"');
    expect(source).toContain('ORDER BY a.occurred_at DESC');
    expect(source).toContain('fetchDeniedClientIds');
    expect(source).toContain('wallExclusionSql');
    expect(source).not.toContain('a.created_at AS "occurredAt"');
  });

  it('filters another user private item, candidate, and Clio projection identities', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/memory/memory-governance-read.service.ts'),
      'utf8',
    );
    expect(source).toContain("mi.visibility = 'tenant'");
    expect(source).toContain("mc.scope NOT IN ('personal','user_private')");
    expect(source).toContain('mc.proposed_by = ${userId}::uuid');
    expect(source).toContain("cm.scope <> 'user_private'");
    expect(source).toContain('cm.owner_user_id = ${userId}::uuid');
    expect(
      (source.match(/privateProjectionSql\(ctx\.userId\)/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
