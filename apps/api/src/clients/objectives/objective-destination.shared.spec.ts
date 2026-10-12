import {
  ClientObjectiveDestinationError,
  normalizeClientObjectiveDestination,
  requireClientObjectiveDestinationRevision,
} from '@capiro/shared';

const actor = { tenantId: '11111111-1111-4111-8111-111111111111', clerkUserId: 'user_synthetic' };
const userId = '22222222-2222-4222-8222-222222222222';
const input = {
  clientId: '44444444-4444-4444-8444-444444444444',
  objectiveId: '55555555-5555-4555-8555-555555555555',
  objectiveVersion: 3,
};
const revisionId = '66666666-6666-4666-8666-666666666666';

function fixture(
  overrides: {
    scope?: unknown[];
    grants?: unknown[];
    objectives?: unknown[];
    revisions?: unknown[];
  } = {},
) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: async <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const sql = strings.join('?');
      queries.push({ sql, values });
      if (sql.includes('FROM tenants'))
        return (overrides.scope ?? [{ userId, memoryWall: true }]) as T;
      if (sql.includes('FROM client_memory_access'))
        return (overrides.grants ?? [{ id: 'grant' }]) as T;
      if (sql.includes('FROM client_objectives'))
        return (overrides.objectives ?? [{ version: 3 }]) as T;
      if (sql.includes('FROM client_objective_revisions'))
        return (overrides.revisions ?? [{ id: revisionId }]) as T;
      throw new Error('Unexpected SQL');
    },
  };
  return { tx, queries, run: () => requireClientObjectiveDestinationRevision(tx, actor, input) };
}

describe('Shared canonical Objective authority seam (synthetic tagged SQL only)', () => {
  it('resolves current Clerk subject to Core UUID, then locks the actual grant/revision', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({ ...input, objectiveRevisionId: revisionId });
    expect(f.queries[0]!.values).toEqual([actor.tenantId, null, actor.clerkUserId, input.clientId]);
    expect(f.queries[0]!.sql).toContain('m.user_id::text AS "userId"');
    expect(f.queries[0]!.sql).toContain('u.clerk_user_id=?');
    expect(f.queries[0]!.sql).not.toContain('clerk_user_id=?::uuid');
    expect(f.queries[0]!.sql).toContain('FOR SHARE OF t,m,u,c');
    expect(f.queries[1]!.values).toEqual([actor.tenantId, input.clientId, userId]);
    expect(f.queries[1]!.sql).toContain('FOR SHARE');
    expect(f.queries[3]!.values).toEqual([actor.tenantId, input.clientId, input.objectiveId, 3]);
  });

  it('Core retains its additional exact UUID/Clerk membership pin', async () => {
    const f = fixture();
    await requireClientObjectiveDestinationRevision(f.tx, { ...actor, userId }, input);
    expect(f.queries[0]!.values).toEqual([
      actor.tenantId,
      userId,
      actor.clerkUserId,
      input.clientId,
    ]);
    expect(f.queries[0]!.sql).toContain('m.user_id=COALESCE(?::uuid,u.id)');
  });

  it.each([{ scope: [] }, { grants: [] }, { objectives: [] }, { revisions: [] }])(
    'fails closed for missing current canonical rows %p',
    async (state) => {
      await expect(fixture(state).run()).rejects.toMatchObject({
        code: 'OBJECTIVE_DESTINATION_NOT_FOUND',
      });
    },
  );

  it('keeps stale-version conflict distinct without reading an old revision', async () => {
    const f = fixture({ objectives: [{ version: 4 }] });
    await expect(f.run()).rejects.toMatchObject({ code: 'OBJECTIVE_VERSION_CONFLICT' });
    expect(f.queries).toHaveLength(3);
  });

  it('normalizes UUID identity and bounds versions without accepting coercions', () => {
    const mixed = 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF';
    expect(normalizeClientObjectiveDestination({ ...input, clientId: mixed })).toMatchObject({
      clientId: mixed.toLowerCase(),
    });
    for (const objectiveVersion of [0, -1, 1.5, Infinity, 2147483648, '3']) {
      expect(() =>
        normalizeClientObjectiveDestination({ ...input, objectiveVersion } as never),
      ).toThrow(ClientObjectiveDestinationError);
    }
    for (const clientId of [null, [input.clientId], { toString: () => input.clientId }]) {
      expect(() => normalizeClientObjectiveDestination({ ...input, clientId } as never)).toThrow(
        ClientObjectiveDestinationError,
      );
    }
  });
});
