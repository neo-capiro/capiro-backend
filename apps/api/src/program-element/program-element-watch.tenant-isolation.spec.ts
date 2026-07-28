import { ConflictException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { ProgramElementReadService } from './program-element-read.service.js';

const PE = '0603270A';
const USER = '00000000-0000-0000-0000-000000000002';
const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-000000000003';

const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  tenantSlug: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',
  userId: USER,
  clerkUserId: 'user_test',
  role: 'standard_user',
});

interface SqlSnapshot {
  text: string;
  values: unknown[];
}

function snapshot(query: unknown): SqlSnapshot {
  const sql = query as { strings?: readonly string[]; values?: readonly unknown[] };
  return {
    text: [...(sql.strings ?? [])].join('?'),
    values: [...(sql.values ?? [])],
  };
}

function makePrisma(options: { legacyCollision?: boolean } = {}) {
  const rows = new Map<string, string>();
  const queries: SqlSnapshot[] = [];
  const auditLogs: Array<Record<string, unknown>> = [];

  const txQueryRaw = jest.fn(async (query: unknown) => {
    const sql = snapshot(query);
    queries.push(sql);
    const tenantId = sql.values.find((value) => value === TENANT_A || value === TENANT_B) as
      | string
      | undefined;
    const userId = sql.values.find((value) => value === USER) as string | undefined;
    const peCode = sql.values.find((value) => value === PE) as string | undefined;
    const key = tenantId && userId && peCode ? `${tenantId}:${userId}:${peCode}` : null;

    if (/INSERT INTO program_element_watch/.test(sql.text)) {
      if (options.legacyCollision) {
        throw {
          code: 'P2010',
          meta: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "program_element_watch_user_pe_code_key"',
          },
        };
      }
      if (!key) throw new Error('test SQL did not carry tenant/user/PE');
      const id = rows.get(key) ?? `watch-${rows.size + 1}`;
      rows.set(key, id);
      return [{ id }];
    }
    if (/DELETE FROM program_element_watch/.test(sql.text)) {
      if (!key) throw new Error('test SQL did not carry tenant/user/PE');
      const id = rows.get(key);
      rows.delete(key);
      return id ? [{ id }] : [];
    }
    if (/SELECT id[\s\S]*FROM program_element_watch/.test(sql.text)) {
      if (!key) throw new Error('test SQL did not carry tenant/user/PE');
      const id = rows.get(key);
      return id ? [{ id }] : [];
    }
    return [];
  });

  const prisma = {
    __state: { rows, queries, auditLogs },
    programElement: {
      findUnique: jest.fn(async () => ({ peCode: PE })),
    },
    $queryRaw: jest.fn(async () => []),
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: txQueryRaw,
        auditLog: {
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            auditLogs.push(data);
            return data;
          }),
        },
        programElementWatch: { findMany: jest.fn(async () => []) },
        clientCapability: { findMany: jest.fn(async () => []) },
      }),
    ),
  };
  return prisma;
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const service = new ProgramElementReadService(
    prisma as never,
    { predict: jest.fn(async () => null) } as never,
  );
  (service as unknown as {
    detailCache: { set: (key: string, value: Record<string, unknown>) => void };
  }).detailCache.set(PE, { peCode: PE, title: 'Test PE' });
  return service;
}

describe('ProgramElementWatch tenant isolation', () => {
  test('same user and PE maintain independent tenant states; unwatch is tenant-local', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.setWatching(PE, true, ctx(TENANT_A));
    await service.setWatching(PE, true, ctx(TENANT_B));
    expect(prisma.__state.rows.size).toBe(2);

    expect((await service.getProgramElement(PE, ctx(TENANT_A))).currentUserIsWatching).toBe(true);
    expect((await service.getProgramElement(PE, ctx(TENANT_B))).currentUserIsWatching).toBe(true);

    await service.setWatching(PE, false, ctx(TENANT_A));
    expect((await service.getProgramElement(PE, ctx(TENANT_A))).currentUserIsWatching).toBe(false);
    expect((await service.getProgramElement(PE, ctx(TENANT_B))).currentUserIsWatching).toBe(true);

    const inserts = prisma.__state.queries.filter((query) =>
      query.text.includes('INSERT INTO program_element_watch'),
    );
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      expect(insert.text).toContain('ON CONFLICT (tenant_id, user_id, pe_code)');
      expect(insert.text).not.toContain('DO UPDATE SET tenant_id');
    }
    const deletes = prisma.__state.queries.filter((query) =>
      query.text.includes('DELETE FROM program_element_watch'),
    );
    expect(deletes[0]?.text).toMatch(/WHERE tenant_id = .*AND user_id = .*AND pe_code =/s);

    expect(prisma.__state.auditLogs.map((entry) => entry.tenantId)).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_A,
    ]);
    expect(
      prisma.__state.auditLogs.map((entry) => (entry.after as { tenantId?: string }).tenantId),
    ).toEqual([TENANT_A, TENANT_B, TENANT_A]);
  });

  test('detail and watched-only finder carry explicit tenant and user predicates', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.getProgramElement(PE, ctx(TENANT_A));
    await service.listProgramElements({ watched: 'true' }, ctx(TENANT_A));

    const detail = prisma.__state.queries.find((query) =>
      /SELECT id[\s\S]*FROM program_element_watch/.test(query.text),
    );
    expect(detail?.text).toMatch(/WHERE tenant_id = .*AND user_id = .*AND pe_code =/s);
    expect(detail?.values).toEqual(expect.arrayContaining([TENANT_A, USER, PE]));

    const finder = prisma.__state.queries.find((query) => query.text.includes('pw.tenant_id'));
    expect(finder?.text).toContain('pw.tenant_id =');
    expect(finder?.text).toContain('pw.user_id =');
    expect(finder?.values).toEqual(expect.arrayContaining([TENANT_A, USER]));
  });

  test('legacy-key collision fails closed without moving a row or writing an audit event', async () => {
    const prisma = makePrisma({ legacyCollision: true });
    const service = makeService(prisma);

    const promise = service.setWatching(PE, true, ctx(TENANT_B));
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PE_WATCH_TENANT_KEY_ROLLOUT_PENDING' }),
    });
    expect(prisma.__state.rows.size).toBe(0);
    expect(prisma.__state.auditLogs).toHaveLength(0);
  });
});
