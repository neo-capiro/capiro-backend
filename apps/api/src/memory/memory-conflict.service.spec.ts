import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryConflictService } from './memory-conflict.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const WINNER = '33333333-3333-4333-8333-333333333333';
const LOSER = '44444444-4444-4444-8444-444444444444';
const OUTSIDER = '55555555-5555-4555-8555-555555555555';
const GROUP = '66666666-6666-4666-8666-666666666666';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: USER,
  clerkUserId: 'user_admin',
  role: 'user_admin',
};

function harness(opts: { group: string | null; members?: string[]; denyId?: string }) {
  const sqls: string[] = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const members = (opts.members ?? [WINNER, LOSER]).map((id) => ({
    id,
    governed_status: 'conflicted',
    client_id: null,
  }));
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      sqls.push(sql);
      if (sql.includes('SELECT conflict_group_id::text')) {
        return [{ conflict_group_id: opts.group }];
      }
      if (sql.includes('conflict_group_id = ?::uuid')) return members;
      return [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      sqls.push(sql);
      return sql.includes("conflict_status = 'resolved'") ? members.length - 1 : 1;
    }),
    memoryTransitionAudit: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditRows.push(args.data);
        return { id: `audit-${auditRows.length}` };
      },
    },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: typeof tx) => unknown) =>
      fn(tx),
    ),
  } as unknown as PrismaService;

  const authorized: Array<{ itemId: string; operation: string }> = [];
  const loadItemInTx = jest.fn(async (_tx: unknown, _tenant: string, itemId: string) => ({
    id: itemId,
    tenantId: TENANT,
    clientId: null,
    ownerUserId: null,
    clientStatus: null,
    memoryClass: 'institutional_authoritative' as const,
    scope: 'firm' as const,
    status: 'conflicted' as const,
    legalHold: false,
  }));
  const evaluateInTx = jest.fn(
    async (_tx: unknown, _ctx: unknown, subject: { id: string }, operation: string) => {
      authorized.push({ itemId: subject.id, operation });
      return subject.id === opts.denyId
        ? ({ allowed: false, reason: 'ethical_wall' } as const)
        : ({ allowed: true, basis: 'admin' } as const);
    },
  );
  const authz = { loadItemInTx, evaluateInTx } as unknown as MemoryAuthorizationService;
  const service = new MemoryConflictService(prisma, authz, new MemoryTransitionAuditService());
  return { service, sqls, auditRows, loadItemInTx, evaluateInTx, authorized, tx };
}

describe('MemoryConflictService.resolve', () => {
  it('names the controlling item and marks the rest of the group resolved', async () => {
    const h = harness({ group: GROUP });
    const result = await h.service.resolve(ctx, LOSER, WINNER, 'the FY27 number was restated');
    expect(result).toMatchObject({
      conflictGroupId: GROUP,
      controllingItemId: WINNER,
      resolvedCount: 1,
    });
    const controlling = h.sqls.find((sql) => sql.includes("conflict_status = 'controlling'"));
    const resolved = h.sqls.find((sql) => sql.includes("conflict_status = 'resolved'"));
    expect(controlling).toContain('controlling_item_id =');
    expect(resolved).toContain('id <> ');
  });

  it('locks the complete group in stable order before mutation', async () => {
    const h = harness({ group: GROUP });
    await h.service.resolve(ctx, LOSER, WINNER, 'restated');
    const groupRead = h.sqls.find(
      (sql) => sql.includes('conflict_group_id = ?::uuid') && sql.includes('FOR UPDATE'),
    );
    expect(groupRead).toContain('ORDER BY id');
  });

  it('authorizes every touched member inside the transaction', async () => {
    const h = harness({ group: GROUP });
    await h.service.resolve(ctx, LOSER, WINNER, 'restated');
    expect(h.loadItemInTx).toHaveBeenCalledTimes(2);
    expect(h.evaluateInTx).toHaveBeenCalledTimes(2);
    expect(h.authorized.every((entry) => entry.operation === 'resolve_conflict')).toBe(true);
    expect(h.authorized.map((entry) => entry.itemId).sort()).toEqual([WINNER, LOSER].sort());
  });

  it('aborts the whole resolution when any group member is unauthorized', async () => {
    const h = harness({ group: GROUP, denyId: LOSER });
    await expect(h.service.resolve(ctx, LOSER, WINNER, 'restated')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    expect(h.auditRows).toHaveLength(0);
  });

  it('refuses a controlling item from outside the conflict group', async () => {
    const h = harness({ group: GROUP });
    await expect(h.service.resolve(ctx, LOSER, OUTSIDER, 'restated')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.sqls.some((sql) => sql.includes("conflict_status = 'controlling'"))).toBe(false);
  });

  it('refuses when the anchor is not in a conflict group at all', async () => {
    const h = harness({ group: null });
    await expect(h.service.resolve(ctx, LOSER, WINNER, 'restated')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('requires a reason before opening a transaction', async () => {
    const h = harness({ group: GROUP });
    await expect(h.service.resolve(ctx, LOSER, WINNER, '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.loadItemInTx).not.toHaveBeenCalled();
  });

  it('writes one audit row per touched row, with the outcome recorded', async () => {
    const h = harness({ group: GROUP });
    await h.service.resolve(ctx, LOSER, WINNER, 'the FY27 number was restated');
    expect(h.auditRows).toHaveLength(2);
    expect(h.auditRows.every((row) => row.reasonCode === 'conflict_resolved')).toBe(true);
    const outcomes = h.auditRows.map(
      (row) => (row.metadata as Record<string, unknown>).outcome as string,
    );
    expect(outcomes.sort()).toEqual(['controlling', 'resolved']);
  });

  it('does not fabricate a lifecycle transition', async () => {
    const h = harness({ group: GROUP });
    await h.service.resolve(ctx, LOSER, WINNER, 'restated');
    for (const row of h.auditRows) {
      expect(row.fromStatus).toBeNull();
      expect(row.toStatus).toBe('conflicted');
    }
  });
});
