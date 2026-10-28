import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import { MemoryGovernanceReadService } from './memory-governance-read.service.js';
import * as center from './memory-governance-center.switch.js';
import {
  decodeGovernancePage,
  encodeGovernancePage,
  governancePageBinding,
} from './memory-governance-page.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  role: 'user_admin',
  tenantSlug: 'test',
  clerkUserId: 'test',
} satisfies TenantContext;
const version = 'mv1:123:' + 'a'.repeat(32);

function harness() {
  // Two timestamps differ below JS Date precision; two rows share one timestamp.
  const rows = [4, 3, 2, 1].map((n) => ({
    id: id(n + 10),
    cursorAt: `2026-10-28T10:00:00.${n >= 3 ? '123999' : '123001'}Z`,
    updatedAt: new Date('2026-10-28'),
    occurredAt: new Date('2026-10-28T10:00:00.123Z'),
    version,
    title: `Memory ${n}`,
  }));
  const denied = new Set<string>();
  const query = jest.fn(async (sql: Prisma.Sql) => {
    const at = sql.values.find((v) => typeof v === 'string' && /^2026-.*Z$/.test(v)) as
      string | undefined;
    const afterId = at ? (sql.values[sql.values.indexOf(at) + 1] as string) : undefined;
    const selected = rows.filter(
      (r) => !at || r.cursorAt < at || (r.cursorAt === at && r.id < afterId!),
    );
    return selected.slice(0, sql.values.at(-1) as number);
  });
  const tx = { $queryRaw: query, $queryRawUnsafe: jest.fn(async () => []) };
  const authorization = {
    loadItemInTx: jest.fn(async (_tx: unknown, _tenant: string, id: string) => ({ id })),
    evaluateInTx: jest.fn(async (_tx: unknown, _ctx: unknown, row: { id: string }) => ({
      allowed: !denied.has(row.id),
    })),
  };
  const service = new MemoryGovernanceReadService(
    {
      withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaService,
    authorization as unknown as MemoryAuthorizationService,
    {} as MemoryCandidateReviewService,
  );
  return { rows, denied, query, service, authorization };
}

describe('Memory governance keyset pages', () => {
  beforeEach(() => {
    jest.spyOn(center, 'memoryGovernanceCenterEnabled').mockReturnValue(true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('walks tied timestamps exactly once despite changes to mutable update/review fields', async () => {
    const h = harness(),
      seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.service.listItems(ctx, 'all', 1, '', cursor);
      seen.push(...page.items.map((row) => row.id));
      expect(page.items[0]?.version).toBe(version);
      h.rows.forEach((r) => {
        r.updatedAt = new Date('2027-01-01');
      });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(h.rows.map((r) => r.id));
    expect(new Set(seen).size).toBe(4);
    expect(
      h.query.mock.calls.every(([sql]) =>
        sql.sql.includes('ORDER BY mi.created_at DESC, mi.id DESC'),
      ),
    ).toBe(true);
    expect(h.query.mock.calls[1]![0].values).toContain('2026-10-28T10:00:00.123999Z');
    expect(h.query.mock.calls[1]![0].sql).toContain('(mi.created_at, mi.id) <');
  });

  it('continues through an empty authorized page and rechecks access on later pages', async () => {
    const h = harness();
    h.denied.add(h.rows[0]!.id);
    const first = await h.service.listItems(ctx, 'all', 1);
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    h.denied.add(h.rows[1]!.id);
    const second = await h.service.listItems(ctx, 'all', 1, '', first.nextCursor!);
    expect(second.items).toEqual([]);
    expect(second.nextCursor).not.toBeNull();
    const third = await h.service.listItems(ctx, 'all', 2, '', second.nextCursor!);
    expect(third.items.map((r) => r.id)).toEqual(h.rows.slice(2).map((r) => r.id));
    expect(third.nextCursor).toBeNull();
  });

  it('pages immutable transition timestamps with a unique tie breaker', async () => {
    const h = harness();
    const first = await h.service.listTransitions(ctx, 2);
    const second = await h.service.listTransitions(ctx, 2, first.nextCursor!);
    expect([...first.transitions, ...second.transitions].map((r) => r.id)).toEqual(
      h.rows.map((r) => r.id),
    );
    expect(second.nextCursor).toBeNull();
    expect(first.transitions[0]).not.toHaveProperty('cursorAt');
    expect(h.query.mock.calls[1]![0].sql).toContain('(a.occurred_at, a.id) <');
    expect(h.query.mock.calls[1]![0].sql).toContain('ORDER BY a.occurred_at DESC, a.id DESC');
  });

  it('binds continuation to actor, tenant, view and normalized search before querying', async () => {
    const h = harness(),
      first = await h.service.listItems(ctx, 'active', 1, 'retained');
    for (const [actor, bucket, q] of [
      [{ ...ctx, userId: id(9) }, 'active', 'retained'],
      [{ ...ctx, tenantId: id(9) }, 'active', 'retained'],
      [ctx, 'history', 'retained'],
      [ctx, 'active', 'changed'],
    ] as const) {
      await expect(
        h.service.listItems(actor, bucket, 1, q, first.nextCursor!),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(h.service.listTransitions(ctx, 1, first.nextCursor!)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('preserves microseconds and rejects malformed or noncanonical cursor fields', () => {
    const binding = governancePageBinding(ctx, 'all');
    const row = { id: id(10), cursorAt: '2026-10-28T10:00:00.123999Z' };
    expect(decodeGovernancePage(encodeGovernancePage(row, binding), binding)).toEqual(row);
    for (const raw of [
      '',
      null,
      '%',
      'a'.repeat(513),
      encodeGovernancePage({ ...row, cursorAt: '2026-02-30T10:00:00.123999Z' }, binding),
    ])
      expect(() => decodeGovernancePage(raw, binding)).toThrow(BadRequestException);
  });

  it('offers first approval only for an authorized classified pending item from another proposer', async () => {
    const h = harness(),
      row = h.rows[0]!;
    Object.assign(row, {
      governedStatus: 'pending_review',
      memoryClass: 'institutional_authoritative',
      assertedByUserId: id(90),
    });
    expect((await h.service.listItems(ctx, 'all', 1)).items[0]!.capabilities.approve).toBe(true);
    Object.assign(row, { assertedByUserId: ctx.userId });
    expect((await h.service.listItems(ctx, 'all', 1)).items[0]!.capabilities.approve).toBe(false);
    Object.assign(row, { assertedByUserId: id(90), memoryClass: 'legacy_unclassified' });
    expect((await h.service.listItems(ctx, 'all', 1)).items[0]!.capabilities.approve).toBe(false);
  });

  it('labels unavailable review counts and the bounded recent-failure window separately from totals', async () => {
    const tx = {
      $queryRawUnsafe: async () => [],
      $queryRaw: async (sql: Prisma.Sql) =>
        sql.sql.includes('SELECT o.id')
          ? []
          : [
              {
                active: 1n,
                failed: 60n,
                deadLetter: 5n,
                pending: 0n,
                running: 0n,
                completed: 0n,
                superseded: 0n,
              },
            ],
    };
    const service = new MemoryGovernanceReadService(
      {
        withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(tx),
      } as unknown as PrismaService,
      {} as MemoryAuthorizationService,
      {
        listReviewable: async () => ({ enabled: false, candidates: [] }),
      } as unknown as MemoryCandidateReviewService,
    );
    expect((await service.overview(ctx)).pendingReviewCountStatus).toBe('unavailable');
    const health = await service.projectionHealth(ctx);
    expect(health.counts.failed).toBe(60);
    expect(health.recentFailuresPage).toEqual({ limit: 50, returned: 0, hasMore: true });
  });
});
