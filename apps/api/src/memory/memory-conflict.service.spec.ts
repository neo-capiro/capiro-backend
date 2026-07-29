import { describe, expect, it } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
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

function harness(opts: { group: string | null; members?: string[] }) {
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
        return [{ conflict_group_id: opts.group, client_id: null }];
      }
      if (sql.includes('conflict_group_id = ?::uuid')) return members;
      return [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      sqls.push(strings.join('?'));
      return 1;
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
  const requireItem = jest.fn(async (_ctx: unknown, itemId: string, operation: string) => {
    authorized.push({ itemId, operation });
    return {} as never;
  });
  const authz = { requireItem } as unknown as MemoryAuthorizationService;
  const service = new MemoryConflictService(prisma, authz, new MemoryTransitionAuditService());
  return { service, sqls, auditRows, requireItem, authorized };
}

describe('MemoryConflictService.resolve', () => {
  it('names the controlling item and marks the rest of the group resolved', async () => {
    const h = harness({ group: GROUP });
    const result = await h.service.resolve(ctx, LOSER, WINNER, 'the FY27 number was restated');
    expect(result).toMatchObject({ conflictGroupId: GROUP, controllingItemId: WINNER });
    const controlling = h.sqls.find((s) => s.includes("conflict_status = 'controlling'"));
    const resolved = h.sqls.find((s) => s.includes("conflict_status = 'resolved'"));
    expect(controlling).toContain('controlling_item_id =');
    expect(resolved).toContain('id <> ');
  });

  /**
   * Authorizing only the anchor would let a caller promote an item they may not
   * touch, so both the anchor AND the winner go through requireItem — which is what
   * applies the ethical wall, legal hold and per-client grants.
   */
  it('authorizes both the anchor and the winner with resolve_conflict', async () => {
    const h = harness({ group: GROUP });
    await h.service.resolve(ctx, LOSER, WINNER, 'restated');
    expect(h.requireItem).toHaveBeenCalledTimes(2);
    expect(h.authorized.every((a) => a.operation === 'resolve_conflict')).toBe(true);
    expect(h.authorized.map((a) => a.itemId).sort()).toEqual([WINNER, LOSER].sort());
  });

  it('authorizes once when the anchor IS the winner', async () => {
    const h = harness({ group: GROUP });
    await h.service.resolve(ctx, WINNER, WINNER, 'restated');
    expect(h.requireItem).toHaveBeenCalledTimes(1);
  });

  /**
   * Without the membership check a caller could name any item in the tenant as
   * controlling, and the losing rows would point at an unrelated row — which
   * filterGovernedMemory would then read as "resolved".
   */
  it('refuses a controlling item from outside the conflict group', async () => {
    const h = harness({ group: GROUP });
    await expect(h.service.resolve(ctx, LOSER, OUTSIDER, 'restated')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.sqls.some((s) => s.includes("conflict_status = 'controlling'"))).toBe(false);
  });

  it('refuses when the anchor is not in a conflict group at all', async () => {
    const h = harness({ group: null });
    await expect(h.service.resolve(ctx, LOSER, WINNER, 'restated')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('requires a reason, since the audit row carries it', async () => {
    const h = harness({ group: GROUP });
    await expect(h.service.resolve(ctx, LOSER, WINNER, '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.requireItem).not.toHaveBeenCalled();
  });

  it('writes one audit row per touched row, with the outcome recorded', async () => {
    const h = harness({ group: GROUP });
    await h.service.resolve(ctx, LOSER, WINNER, 'the FY27 number was restated');
    expect(h.auditRows).toHaveLength(2);
    expect(h.auditRows.every((r) => r.reasonCode === 'conflict_resolved')).toBe(true);
    const outcomes = h.auditRows.map(
      (r) => (r.metadata as Record<string, unknown>).outcome as string,
    );
    expect(outcomes.sort()).toEqual(['controlling', 'resolved']);
  });

  /**
   * conflict_status is a separate axis from governed_status: resolving a conflict
   * does not move the lifecycle state, so the audit row must record the UNCHANGED
   * status rather than invent a transition that did not happen.
   */
  it('does not fabricate a lifecycle transition', async () => {
    const h = harness({ group: GROUP });
    await h.service.resolve(ctx, LOSER, WINNER, 'restated');
    for (const row of h.auditRows) {
      expect(row.fromStatus).toBeNull();
      expect(row.toStatus).toBe('conflicted');
    }
  });
});
