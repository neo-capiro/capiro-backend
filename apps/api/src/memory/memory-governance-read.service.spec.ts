import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import { MemoryGovernanceReadService } from './memory-governance-read.service.js';

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
    expect((source.match(/privateProjectionSql\(ctx\.userId\)/g) ?? []).length).toBeGreaterThanOrEqual(
      3,
    );
  });
});
