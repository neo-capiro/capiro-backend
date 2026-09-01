import {
  ADVOCACY_REVIEW_CARRY_FORWARD_KINDS,
  carryForwardPendingAdvocacyFindings,
} from './client-profile-fill-advocacy-carry-forward.js';

describe('Fill with Meri Advocacy review carry-forward', () => {
  test('carries unresolved Advocacy findings to the new run without touching terminal decisions', async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const tx = {
      $queryRawUnsafe: async <T>(sql: string, ...args: unknown[]): Promise<T> => {
        calls.push({ sql, args });
        return [{ carried: 3, retired: 4 }] as T;
      },
    };

    const result = await carryForwardPendingAdvocacyFindings(
      tx,
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    );

    expect(result).toEqual({ carried: 3, retired: 4 });
    expect(calls).toHaveLength(1);
    const [{ sql, args }] = calls;

    expect(args).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      [...ADVOCACY_REVIEW_CARRY_FORWARD_KINDS],
    ]);

    // Tenant/client/run isolation and only unresolved rows are eligible.
    expect(sql).toContain('f.tenant_id = $1::uuid');
    expect(sql).toContain('f.client_id = $2::uuid');
    expect(sql).toContain('f.run_id <> $3::uuid');
    expect(sql).toContain("f.status = 'pending'");
    expect(sql).toContain('f.kind = ANY($4::text[])');

    // A user decision is terminal across all runs and must never resurrect.
    expect(sql).toContain("terminal.status IN ('accepted', 'rejected')");

    // Multiple historical pending copies collapse to one current review item.
    expect(sql).toContain('DISTINCT ON (pending.content_hash)');
    expect(sql).toContain('ORDER BY pending.content_hash, pending.created_at DESC, pending.id DESC');
    expect(sql).toContain('ON CONFLICT (run_id, content_hash) DO NOTHING');

    // Concurrent review and carry-forward cannot race the same pending row.
    expect(sql).toContain('FOR UPDATE');

    // Old pending rows are audit-preserved and retired only after a new copy exists.
    expect(sql).toContain("SET status = 'informational'");
    expect(sql).toContain('SELECT 1 FROM inserted');
  });

  test('covers every currently applyable Advocacy review kind', () => {
    expect(ADVOCACY_REVIEW_CARRY_FORWARD_KINDS).toEqual([
      'advocacy_record',
      'advocacy_outcome',
      'regulatory_outcome',
    ]);
  });

  test('returns zeros when there is nothing to carry', async () => {
    const tx = {
      $queryRawUnsafe: async <T>(): Promise<T> => [{ carried: 0, retired: 0 }] as T,
    };

    await expect(
      carryForwardPendingAdvocacyFindings(
        tx,
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
      ),
    ).resolves.toEqual({ carried: 0, retired: 0 });
  });
});
