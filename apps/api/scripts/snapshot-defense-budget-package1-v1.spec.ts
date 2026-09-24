import {
  collectPackage1QueueInventory,
  normalizePackage1QueueInventoryValue,
  PACKAGE1_QUEUE_INVENTORY_SQL,
} from './snapshot-defense-budget-package1-v1.js';

describe('Package 1 exact queue inventory', () => {
  it('enters a read-only transaction before the one SELECT inventory query', async () => {
    const calls: string[] = [];
    const client = {
      async $executeRawUnsafe(query: string) {
        calls.push(query);
        return 0;
      },
      async $queryRawUnsafe<T = unknown>(query: string): Promise<T> {
        calls.push(query);
        return [{ candidate_count: 0n, available_at: new Date('2026-09-24T00:00:00.000Z') }] as T;
      },
    };

    const result = await collectPackage1QueueInventory(client);
    expect(calls[0]).toBe('SET TRANSACTION READ ONLY');
    expect(calls[1]).toBe(PACKAGE1_QUEUE_INVENTORY_SQL);
    expect(result.transactionMode).toBe('READ ONLY');
    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([{ candidate_count: 0, available_at: '2026-09-24T00:00:00.000Z' }]);
  });

  it('contains no mutation and exposes both manifest and governed-replay gates', () => {
    expect(PACKAGE1_QUEUE_INVENTORY_SQL).toMatch(/^\s*SELECT\b/i);
    expect(PACKAGE1_QUEUE_INVENTORY_SQL).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i,
    );
    expect(PACKAGE1_QUEUE_INVENTORY_SQL).toContain('manifest_eligible_now');
    expect(PACKAGE1_QUEUE_INVENTORY_SQL).toContain('replay_eligible_now');
    expect(PACKAGE1_QUEUE_INVENTORY_SQL).toContain('archive_version_id');
    expect(PACKAGE1_QUEUE_INVENTORY_SQL).not.toContain('last_error AS');
  });

  it('normalizes dates and bigint counts without changing null/unknown states', () => {
    expect(normalizePackage1QueueInventoryValue({ count: 2n, missing: null })).toEqual({
      count: 2,
      missing: null,
    });
  });
});
