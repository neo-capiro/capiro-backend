import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { normalizeObjectiveDestination } from './objective-destination.js';
import { ClientObjectivesService } from './objectives.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_synthetic',
  role: 'standard_user',
};
const input = {
  clientId: '33333333-3333-4333-8333-333333333333',
  objectiveId: '44444444-4444-4444-8444-444444444444',
  objectiveVersion: 7,
};
const revisionId = '55555555-5555-4555-8555-555555555555';

function harness(
  overrides: {
    scope?: unknown[];
    grants?: unknown[];
    objectives?: unknown[];
    revisions?: unknown[];
  } = {},
) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      calls.push({ sql, values });
      if (sql.includes('FROM tenants')) return overrides.scope ?? [{ memoryWall: true }];
      if (sql.includes('FROM client_memory_access')) return overrides.grants ?? [{ id: 'grant' }];
      if (sql.includes('FROM client_objectives')) return overrides.objectives ?? [{ version: 7 }];
      if (sql.includes('FROM client_objective_revisions'))
        return overrides.revisions ?? [{ id: revisionId }];
      throw new Error('Unexpected SQL');
    }),
  };
  const service = new ClientObjectivesService({} as PrismaService);
  return {
    calls,
    tx,
    run: () =>
      service.requireDestinationRevisionWithinTx(
        tx as unknown as Prisma.TransactionClient,
        ctx,
        input,
      ),
  };
}

describe('Objective destination current revision authority (synthetic SQL boundary)', () => {
  it('uses the existing immutable revision and parameterized current tenant/member/client authority', async () => {
    const h = harness();
    await expect(h.run()).resolves.toEqual({ ...input, objectiveRevisionId: revisionId });
    expect(h.calls[0]!.values).toEqual([ctx.tenantId, ctx.userId, ctx.clerkUserId, input.clientId]);
    expect(h.calls[0]!.sql).toContain("t.status::text='active'");
    expect(h.calls[0]!.sql).toContain("m.status::text='active'");
    expect(h.calls[0]!.sql).toContain(
      "m.role::text IN ('standard_user','user_admin','capiro_admin')",
    );
    expect(h.calls[0]!.sql).toContain('u.clerk_user_id=?');
    expect(h.calls[0]!.sql).toContain("c.status::text<>'archived'");
    expect(h.calls[0]!.sql).toContain('FOR SHARE OF t,m,u,c');
    expect(h.calls[1]!.sql).toContain('FOR SHARE');
    expect(h.calls[1]!.values).toEqual([ctx.tenantId, input.clientId, ctx.userId]);
    expect(h.calls[2]!.sql).toContain('deleted_at IS NULL FOR SHARE');
    expect(h.calls[3]!.values).toEqual([
      ctx.tenantId,
      input.clientId,
      input.objectiveId,
      input.objectiveVersion,
    ]);
    expect(h.calls[3]!.sql).not.toMatch(/\bFOR\s+(?:SHARE|UPDATE|KEY|NO)\b/i);
  });

  it.each([
    ['missing current scope', { scope: [] }],
    ['walled client without actual grant', { grants: [] }],
    ['foreign/deleted objective', { objectives: [] }],
    ['missing immutable revision', { revisions: [] }],
  ])('fails closed for %s', async (_name, state) => {
    await expect(harness(state).run()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not let administrator context bypass the current grant', async () => {
    const h = harness({ grants: [] });
    const service = new ClientObjectivesService({} as PrismaService);
    await expect(
      service.requireDestinationRevisionWithinTx(
        h.tx as unknown as Prisma.TransactionClient,
        { ...ctx, role: 'capiro_admin' },
        input,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('conflicts on a changed revision before returning any historical snapshot', async () => {
    const h = harness({ objectives: [{ version: 8 }] });
    await expect(h.run()).rejects.toBeInstanceOf(ConflictException);
    expect(h.calls).toHaveLength(3);
  });

  it('permits an unwalled client without inventing a grant', async () => {
    const h = harness({ scope: [{ memoryWall: false }], grants: [] });
    await expect(h.run()).resolves.toMatchObject({ objectiveRevisionId: revisionId });
    expect(h.calls.some((c) => c.sql.includes('FROM client_memory_access'))).toBe(false);
  });

  it('normalizes UUID letter case and rejects unbounded versions/invalid IDs at the service seam', () => {
    const mixed = 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF';
    expect(
      normalizeObjectiveDestination({ ...input, clientId: mixed, objectiveId: mixed }),
    ).toEqual({
      clientId: mixed.toLowerCase(),
      objectiveId: mixed.toLowerCase(),
      objectiveVersion: 7,
    });
    for (const objectiveVersion of [0, -1, 1.5, NaN, Infinity, 2147483648, '7', null]) {
      expect(() => normalizeObjectiveDestination({ ...input, objectiveVersion } as never)).toThrow(
        BadRequestException,
      );
    }
    for (const clientId of ['', '33333333-3333-4333-8333-333333333333 OR 1=1', null]) {
      expect(() => normalizeObjectiveDestination({ ...input, clientId } as never)).toThrow(
        BadRequestException,
      );
    }
  });
});
