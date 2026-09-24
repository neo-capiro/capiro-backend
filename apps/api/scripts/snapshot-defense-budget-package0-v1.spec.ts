import {
  SNAPSHOT_QUERY_SPECS,
  collectPackage0Snapshot,
  normalizeSnapshotValue,
} from './snapshot-defense-budget-package0-v1';

describe('snapshot-defense-budget-package0-v1', () => {
  it('contains only bounded SELECT inventory queries', () => {
    expect(SNAPSHOT_QUERY_SPECS.length).toBeGreaterThan(10);
    for (const spec of SNAPSHOT_QUERY_SPECS) {
      expect(spec.sql.trim().toUpperCase()).toMatch(/^SELECT/);
      expect(spec.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
      expect(spec.table).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('normalizes bigint and Date values for JSON evidence', () => {
    expect(
      normalizeSnapshotValue({ count: 3n, at: new Date('2026-09-24T00:00:00.000Z') }),
    ).toEqual({ count: 3, at: '2026-09-24T00:00:00.000Z' });
  });

  it('marks an absent release table unavailable without running its query', async () => {
    const executed: string[] = [];
    const client = {
      $executeRawUnsafe: jest.fn(async (query: string) => {
        executed.push(query);
        return 0;
      }),
      $queryRawUnsafe: jest.fn(async (query: string, relation?: string) => {
        if (query.includes('to_regclass')) {
          return [
            {
              relation: relation?.endsWith('defense_budget_ingestion_manifest_v1') ? null : relation,
            },
          ];
        }
        return [];
      }),
    };

    const result = await collectPackage0Snapshot(
      client as unknown as Parameters<typeof collectPackage0Snapshot>[0],
    );
    const tables = result.tables as Record<string, unknown>;

    expect(executed[0]).toBe('SET TRANSACTION READ ONLY');
    expect(tables.governedManifests).toEqual({
      unavailable: true,
      reason: 'relation_missing',
      table: 'defense_budget_ingestion_manifest_v1',
    });
    expect(client.$queryRawUnsafe).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM defense_budget_ingestion_manifest_v1'),
    );
  });
});
