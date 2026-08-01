import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAccessGrantService } from './memory-access-grant.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const FUTURE = '2030-01-01T00:00:00.000Z';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: ADMIN,
  clerkUserId: 'user_admin',
  role: 'user_admin',
};

function harness(opts: { wallAllowed: boolean; activeMember?: boolean }) {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      sqls.push(sql);
      return opts.wallAllowed ? [{ allowed: true }] : [];
    }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...args: unknown[]) => {
      const sql = strings.join('?');
      sqls.push(sql);
      params.push(args);
      if (sql.includes('FROM tenant_memberships')) {
        return opts.activeMember === false ? [] : [{ allowed: true }];
      }
      if (sql.includes('INSERT INTO memory_access_grant')) return [{ id: 'grant-1' }];
      if (sql.includes('FROM memory_access_grant')) return [];
      return [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...args: unknown[]) => {
      sqls.push(strings.join('?'));
      params.push(args);
      return 1;
    }),
  };
  const prisma = {
    withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: typeof tx) => unknown) =>
      fn(tx),
    ),
  } as unknown as PrismaService;
  return { service: new MemoryAccessGrantService(prisma), sqls, params };
}

const completeGrant = {
  userId: TARGET,
  permissions: ['approve'],
  reason: 'Client policy lead for FY27 review',
  expiresAt: FUTURE,
};

describe('MemoryAccessGrantService — the ethical wall binds the granting admin', () => {
  it('refuses to create a grant on a client the acting admin is walled from', async () => {
    const h = harness({ wallAllowed: false });
    await expect(h.service.grant(ctx, CLIENT, completeGrant)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.sqls.some((s) => s.includes('INSERT INTO memory_access_grant'))).toBe(false);
  });

  it('refuses to revoke on a walled client too (no probing by revoke)', async () => {
    const h = harness({ wallAllowed: false });
    await expect(h.service.revoke(ctx, CLIENT, TARGET)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.sqls.some((s) => s.includes('UPDATE memory_access_grant'))).toBe(false);
  });

  it('refuses to list a walled client’s grants', async () => {
    const h = harness({ wallAllowed: false });
    await expect(h.service.list(ctx, CLIENT)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('MemoryAccessGrantService.grant', () => {
  it('rejects a permission outside the shared vocabulary before any write', async () => {
    const h = harness({ wallAllowed: true });
    await expect(
      h.service.grant(ctx, CLIENT, { ...completeGrant, permissions: ['delete'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.sqls.some((s) => s.includes('INSERT INTO memory_access_grant'))).toBe(false);
  });

  it('rejects an empty permission set', async () => {
    const h = harness({ wallAllowed: true });
    await expect(
      h.service.grant(ctx, CLIENT, { ...completeGrant, permissions: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a non-empty reason and explicit expiration', async () => {
    const h = harness({ wallAllowed: true });
    await expect(
      h.service.grant(ctx, CLIENT, { ...completeGrant, reason: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.service.grant(ctx, CLIENT, { ...completeGrant, expiresAt: undefined }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects malformed or past expiration rather than granting indefinitely', async () => {
    const h = harness({ wallAllowed: true });
    await expect(
      h.service.grant(ctx, CLIENT, { ...completeGrant, expiresAt: 'next tuesday' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.service.grant(ctx, CLIENT, { ...completeGrant, expiresAt: '2020-01-01T00:00:00Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires the recipient to remain an active member of the same tenant', async () => {
    const h = harness({ wallAllowed: true, activeMember: false });
    await expect(h.service.grant(ctx, CLIENT, completeGrant)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.sqls.some((s) => s.includes('INSERT INTO memory_access_grant'))).toBe(false);
  });

  it('revokes the prior active grant before inserting the replacement', async () => {
    const h = harness({ wallAllowed: true });
    const result = await h.service.grant(ctx, CLIENT, {
      ...completeGrant,
      permissions: ['edit', 'approve'],
    });
    expect(result).toEqual({
      id: 'grant-1',
      permissions: ['approve', 'edit'],
      expiresAt: FUTURE,
    });
    const revokeIdx = h.sqls.findIndex((s) => s.includes("SET status = 'revoked'"));
    const insertIdx = h.sqls.findIndex((s) => s.includes('INSERT INTO memory_access_grant'));
    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(revokeIdx);
    expect(h.sqls.some((s) => s.includes('FROM tenant_memberships'))).toBe(true);
  });

  it('never DELETEs a grant — revocation is a status flip with an actor', async () => {
    const h = harness({ wallAllowed: true });
    await h.service.revoke(ctx, CLIENT, TARGET);
    const update = h.sqls.find((s) => s.includes('UPDATE memory_access_grant'));
    expect(update).toContain("SET status = 'revoked'");
    expect(update).toContain('revoked_at = now()');
    expect(update).toContain('revoked_by_user_id =');
    expect(h.sqls.some((s) => s.includes('DELETE FROM memory_access_grant'))).toBe(false);
  });

  it('reports revoked:false when there was no active grant (idempotent)', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 0),
    };
    const prisma = {
      withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: typeof tx) => unknown) =>
        fn(tx),
      ),
    } as unknown as PrismaService;
    const service = new MemoryAccessGrantService(prisma);
    await expect(service.revoke(ctx, CLIENT, TARGET)).resolves.toEqual({ revoked: false });
  });
});
