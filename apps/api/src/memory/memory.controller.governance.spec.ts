import { describe, expect, it } from '@jest/globals';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MemoryController } from './memory.controller.js';
import type { MemoryStoreService } from './memory-store.service.js';
import type { MemoryFkLoader } from './memory-fk-loader.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { MemoryInterviewService } from './memory-interview.service.js';
import type { MemoryCandidateService } from './memory-candidate.service.js';
import type { MemoryPurgeService } from './memory-purge.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryAccessGrantService } from './memory-access-grant.service.js';
import type { MemoryConflictService } from './memory-conflict.service.js';
import type { AppConfig } from '../config/config.schema.js';
import type { ConfigService } from '@nestjs/config';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_admin',
  role: 'user_admin',
};

const CLIENT = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';

function harness(opts: { candidateDenied?: boolean } = {}) {
  const approve = jest.fn(async () => ({ memoryId: 'clio-1' }));
  const reject = jest.fn(async () => undefined);
  const requireCandidate = jest.fn(async () => {
    if (opts.candidateDenied) throw new ForbiddenException('Memory operation denied: ethical_wall');
    return {} as never;
  });
  const grantList = jest.fn(async () => []);
  const grantCreate = jest.fn(async () => ({ id: 'grant-1', permissions: ['approve' as const] }));
  const grantRevoke = jest.fn(async () => ({ revoked: true }));
  const resolveConflict = jest.fn(async () => ({
    conflictGroupId: 'g',
    controllingItemId: ITEM,
    resolvedCount: 1,
  }));

  const controller = new MemoryController(
    {} as unknown as MemoryStoreService,
    {} as unknown as MemoryFkLoader,
    {} as unknown as MemoryIngestService,
    {} as unknown as MemoryInterviewService,
    { approve, reject } as unknown as MemoryCandidateService,
    {} as unknown as MemoryPurgeService,
    { requireCandidate } as unknown as MemoryAuthorizationService,
    {
      list: grantList,
      grant: grantCreate,
      revoke: grantRevoke,
    } as unknown as MemoryAccessGrantService,
    { resolve: resolveConflict } as unknown as MemoryConflictService,
    { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>,
  );
  return {
    controller,
    approve,
    reject,
    requireCandidate,
    grantList,
    grantCreate,
    grantRevoke,
    resolveConflict,
  };
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
  MEMORY_GOVERNANCE_ENFORCE: undefined,
  MEMORY_GOVERNANCE_LIFECYCLE: undefined,
};

describe('candidate decisions — ethical wall', () => {
  it('does not consult the wall while MEMORY_GOVERNANCE_ENFORCE is dark', async () => {
    await withEnv(DARK, async () => {
      const h = harness({ candidateDenied: true });
      await expect(h.controller.approveCandidate(ctx, 'cand-1')).resolves.toEqual({
        ok: true,
        memoryId: 'clio-1',
      });
      expect(h.requireCandidate).not.toHaveBeenCalled();
    });
  });

  /**
   * listPending already withheld walled candidates, but the DECISION routes never
   * consulted the wall — so a non-granted admin with a candidate id could ratify a
   * walled client's memory. This is the gap being closed.
   */
  it('refuses an approval on a walled candidate BEFORE any memory write', async () => {
    await withEnv({ ...DARK, MEMORY_GOVERNANCE_ENFORCE: 'enforce' }, async () => {
      const h = harness({ candidateDenied: true });
      await expect(h.controller.approveCandidate(ctx, 'cand-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.approve).not.toHaveBeenCalled();
    });
  });

  it('refuses a rejection on a walled candidate too', async () => {
    await withEnv({ ...DARK, MEMORY_GOVERNANCE_ENFORCE: 'enforce' }, async () => {
      const h = harness({ candidateDenied: true });
      await expect(h.controller.rejectCandidate(ctx, 'cand-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.reject).not.toHaveBeenCalled();
    });
  });

  it('authorizes approve with approve and reject with review', async () => {
    await withEnv({ ...DARK, MEMORY_GOVERNANCE_ENFORCE: 'enforce' }, async () => {
      const h = harness();
      await h.controller.approveCandidate(ctx, 'cand-1');
      await h.controller.rejectCandidate(ctx, 'cand-2');
      expect(h.requireCandidate).toHaveBeenCalledTimes(2);
      expect(h.approve).toHaveBeenCalledTimes(1);
      expect(h.reject).toHaveBeenCalledTimes(1);
    });
  });
});

describe('governance management routes — dark by default', () => {
  /**
   * These routes touch tables/columns from two UNAPPLIED migrations. 503 is the
   * honest answer while dark; letting the request through would surface a Postgres
   * "relation does not exist" as a 500.
   */
  it('503s the grant routes while unarmed, without reaching the service', async () => {
    await withEnv(DARK, async () => {
      const h = harness();
      await expect(h.controller.listGrants(ctx, CLIENT)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(
        h.controller.createGrant(ctx, CLIENT, { userId: 'u', permissions: ['approve'] }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(h.controller.revokeGrant(ctx, CLIENT, 'u')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(h.grantList).not.toHaveBeenCalled();
      expect(h.grantCreate).not.toHaveBeenCalled();
      expect(h.grantRevoke).not.toHaveBeenCalled();
    });
  });

  it('503s the conflict-resolution route while unarmed', async () => {
    await withEnv(DARK, async () => {
      const h = harness();
      await expect(
        h.controller.resolveConflict(ctx, ITEM, { controllingItemId: ITEM, reason: 'restated' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(h.resolveConflict).not.toHaveBeenCalled();
    });
  });

  it('reaches the services once armed', async () => {
    await withEnv({ ...DARK, MEMORY_GOVERNANCE_LIFECYCLE: 'enforce' }, async () => {
      const h = harness();
      await expect(h.controller.listGrants(ctx, CLIENT)).resolves.toEqual({ grants: [] });
      await expect(
        h.controller.createGrant(ctx, CLIENT, { userId: 'u', permissions: ['approve'] }),
      ).resolves.toMatchObject({ ok: true, id: 'grant-1' });
      await expect(h.controller.revokeGrant(ctx, CLIENT, 'u')).resolves.toEqual({
        ok: true,
        revoked: true,
      });
      await expect(
        h.controller.resolveConflict(ctx, ITEM, { controllingItemId: ITEM, reason: 'restated' }),
      ).resolves.toMatchObject({ ok: true, resolvedCount: 1 });
    });
  });

  it('publishes the permission vocabulary without needing the migration', () => {
    const h = harness();
    expect(h.controller.grantPermissions().permissions).toContain('resolve_conflict');
  });
});
