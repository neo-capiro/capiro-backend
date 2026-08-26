import {
  createIngestionOutboxDrainRepositoryPrismaV1,
  ingestionOutboxClaimSqlV1,
  ingestionOutboxReadinessClaimSqlV1,
} from './ingestion-outbox-drain-repository-prisma-v1.js';

describe('ingestion outbox Prisma repository', () => {
  test('claim is one locking statement with exact eligibility', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const prisma = {
      async $queryRawUnsafe<T>(sql: string, ...values: unknown[]) {
        calls.push({ sql, values });
        return [{ id: '1', observation_id: 'o1', attempts: 2 }] as T;
      },
    };
    const rows = await createIngestionOutboxDrainRepositoryPrismaV1(prisma).claimBatch({
      leaseOwner: 'worker',
      limit: 5,
      now: new Date('2026-01-01'),
    });
    expect(rows).toEqual([{ id: '1', observationId: 'o1', attempts: 2 }]);
    const claim = calls[0]!;
    expect(claim.sql).toMatch(/state" IN \('pending','failed'\).*available_at/s);
    expect(claim.sql).toMatch(/state" = 'leased'.*leased_until/s);
    expect(claim.sql).toContain('FOR UPDATE OF o SKIP LOCKED');
    expect(claim.sql.trim().split(';')).toHaveLength(1);
  });
  test('claim SQL supports lease-expiry recovery', () =>
    expect(ingestionOutboxClaimSqlV1()).toContain('leased_until'));
  test('readiness claim is locking, bounded, and only claims succeeded pending readiness', () => {
    const sql = ingestionOutboxReadinessClaimSqlV1();
    expect(sql).toContain(`o."state"='succeeded'`);
    expect(sql).toContain(`o."metadata_jsonb"->>'readinessPhase'='pending'`);
    expect(sql).toContain(`o."available_at" <= $1::timestamptz`);
    expect(sql).toContain('FOR UPDATE OF o SKIP LOCKED');
    expect(sql).toContain('leased_until');
  });
  test('all terminal/update writes guard state and lease owner', async () => {
    const sql: string[] = [];
    const prisma = {
      async $queryRawUnsafe<T>(query: string) {
        sql.push(query);
        return [{ id: 'matched' }] as T;
      },
    };
    const repo = createIngestionOutboxDrainRepositoryPrismaV1(prisma);
    const now = new Date();
    await repo.markSucceeded('1', 'w', now);
    await repo.markRetryableFailure({
      rowId: '2',
      leasedBy: 'w',
      now,
      attemptsBefore: 0,
      detail: 'x',
    });
    await repo.markGoverned({
      rowId: '3',
      leasedBy: 'w',
      disposition: 'governed_review',
      detail: 'x',
      metadata: { governedDisposition: 'review_required' },
    });
    await repo.markDeadLetterPoison({
      rowId: '4',
      leasedBy: 'w',
      detail: 'x',
      metadata: { governedDisposition: 'retries_exhausted' },
    });
    await repo.markReadinessSucceeded({
      rowId: '5',
      leasedBy: 'w',
      now,
      outcome: { readinessOutcome: 'awaiting_authorization' },
    });
    await repo.markReadinessRetryableFailure({
      rowId: '6',
      leasedBy: 'w',
      now,
      attemptsBefore: 1,
      detail: 'x',
    });
    await repo.markReadinessDeferredCommittee({ rowId: '7', leasedBy: 'w' });
    await repo.markReadinessNotApplicable({ rowId: '8', leasedBy: 'w' });
    expect(sql).toHaveLength(8);
    for (const query of sql.slice(0, 4)) {
      expect(query).toContain(`"state"='leased'`);
      expect(query).toContain(`"leased_by"=$2`);
    }
    for (const query of sql.slice(4)) {
      expect(query).toContain(`"state"='succeeded'`);
      expect(query).toContain(`"metadata_jsonb"->>'readinessPhase'='pending'`);
      expect(query).toContain(`"leased_by"=$2`);
    }
  });
  test('guarded writes report whether RETURNING matched a row', async () => {
    let matches = false;
    const prisma = {
      async $queryRawUnsafe<T>() {
        return (matches ? [{ id: '1' }] : []) as T;
      },
    };
    const repo = createIngestionOutboxDrainRepositoryPrismaV1(prisma);
    const now = new Date();
    await expect(repo.markSucceeded('1', 'w', now)).resolves.toBe(false);
    matches = true;
    await expect(repo.markSucceeded('1', 'w', now)).resolves.toBe(true);
  });
  test('markSucceeded atomically stamps readiness pending and clears the ingestion lease', async () => {
    let query = '';
    const prisma = {
      async $queryRawUnsafe<T>(sql: string) {
        query = sql;
        return [{ id: '1' }] as T;
      },
    };
    await createIngestionOutboxDrainRepositoryPrismaV1(prisma).markSucceeded('1', 'w', new Date());
    expect(query).toContain(`"state"='succeeded'`);
    expect(query).toContain(`'{"readinessPhase":"pending"`);
    expect(query).toContain(`"leased_by"=NULL`);
    expect(query).toContain(`"leased_until"=NULL`);
  });
  test('retry schedules future availability using shared backoff', async () => {
    let values: unknown[] = [];
    const prisma = {
      async $queryRawUnsafe<T>(_q: string, ...v: unknown[]) {
        values = v;
        return [] as T;
      },
    };
    await createIngestionOutboxDrainRepositoryPrismaV1(prisma).markRetryableFailure({
      rowId: '1',
      leasedBy: 'w',
      now: new Date('2026-01-01T00:00:00Z'),
      attemptsBefore: 0,
      detail: 'x',
    });
    expect(values[2]).toBe('2026-01-01T00:00:01.000Z');
  });
  test('readiness retry uses shared backoff and a metadata-specific attempt counter', async () => {
    let values: unknown[] = [];
    const prisma = {
      async $queryRawUnsafe<T>(_q: string, ...v: unknown[]) {
        values = v;
        return [{ id: '1' }] as T;
      },
    };
    await createIngestionOutboxDrainRepositoryPrismaV1(prisma).markReadinessRetryableFailure({
      rowId: '1',
      leasedBy: 'w',
      now: new Date('2026-01-01T00:00:00Z'),
      attemptsBefore: 2,
      detail: 'x',
    });
    expect(values[2]).toContain('"readinessAttempts":3');
    expect(values[3]).toBe('2026-01-01T00:00:04.000Z');
  });
});
