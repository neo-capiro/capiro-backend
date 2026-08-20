/**
 * Phase 7 Workstream L — the drain adapter, against a fake Prisma.
 *
 * What a fake cannot prove: that `FOR UPDATE SKIP LOCKED` actually partitions a
 * backlog between concurrent drainers, or that the claim's eligibility SQL
 * agrees with the policy row-for-row. Both are proved against a real database
 * in the disposable-PostgreSQL rehearsal.
 *
 * What is proved here is everything that fails silently otherwise: that the
 * generated backoff SQL is derived from the policy rather than restated, that
 * the claim is one statement rather than a select followed by an update, that
 * money never comes back through a float, and that each mark is guarded on the
 * row still being the caller's to mark.
 *
 * Writing this suite is also how the Workstream K adapter's NUMERIC padding
 * defect was found. It is the reason the E adapter's missing spec is still an
 * open P1.
 */
import {
  createOutboxDrainRepositoryPrismaV1,
  exactDecimalFromColumnV1,
  outboxBackoffCaseSqlV1,
  outboxClaimSqlV1,
  outboxRowFromClaimV1,
  type OutboxDrainPrismaLikeV1,
} from './promotion-outbox-drain-repository-prisma-v1.js';
import {
  drainBackoffMsV1,
  OUTBOX_BACKOFF_CAP_MS_V1,
  OUTBOX_MAX_ATTEMPTS_V1,
  OUTBOX_PROCESSING_LEASE_MS_V1,
} from './promotion-outbox-drain-v1.js';

const NOW = new Date('2026-08-07T12:00:00.000Z');

interface Call {
  sql: string;
  params: unknown[];
}

function fakePrisma(results: Record<string, unknown>[][] = []): {
  prisma: OutboxDrainPrismaLikeV1;
  calls: Call[];
  pause: { paused: boolean } | null;
} {
  const calls: Call[] = [];
  const queued = [...results];
  const state = { pause: null as { paused: boolean } | null };
  const prisma: OutboxDrainPrismaLikeV1 = {
    async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
      calls.push({ sql, params });
      return (queued.shift() ?? []) as T;
    },
    defenseBudgetSideEffectDrainPause: {
      async findUnique() {
        return state.pause;
      },
      async upsert() {
        state.pause = { paused: true };
        return {};
      },
      async updateMany() {
        const had = state.pause?.paused === true;
        state.pause = had ? { paused: false } : state.pause;
        return { count: had ? 1 : 0 };
      },
    },
  };
  return {
    prisma,
    calls,
    get pause() {
      return state.pause;
    },
  };
}

function claimedRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    dedupe_key: 'dedupe-1',
    activation_id: 'act-1',
    old_snapshot_id: 'snap-old',
    new_snapshot_id: 'snap-new',
    canonical_entity: 'canonical_om_sag_year',
    canonical_natural_key: 'ARMY|OMA|SAG-111',
    family: 'om',
    fiscal_year: 2027,
    funding_field: 'request',
    stage: null,
    old_original_value: '1000',
    old_value_millions: '1.000000000',
    new_original_value: '1250',
    new_value_millions: '1.250000000',
    change_classification: 'material_change',
    suppress_alert: false,
    is_correction: false,
    is_rollback: false,
    attempts: 0,
    ...o,
  };
}

describe('Workstream L — the eligibility SQL is generated from the policy', () => {
  it('emits one arm per attempt count, each calling drainBackoffMsV1', () => {
    const sql = outboxBackoffCaseSqlV1();
    for (let attempts = 0; attempts <= OUTBOX_MAX_ATTEMPTS_V1; attempts += 1) {
      expect(sql).toContain(`WHEN ${attempts} THEN ${drainBackoffMsV1(attempts)}`);
    }
  });

  it('falls to the capped delay beyond the retry ceiling', () => {
    expect(outboxBackoffCaseSqlV1()).toContain(`ELSE ${OUTBOX_BACKOFF_CAP_MS_V1} END`);
  });

  it('changes when the policy changes, which is the point of generating it', () => {
    // A shorter ceiling must produce different SQL. If this passed with an
    // unchanged string, the SQL would be a hard-coded copy and free to drift.
    expect(outboxBackoffCaseSqlV1(2)).not.toEqual(outboxBackoffCaseSqlV1(5));
  });
});

describe('Workstream L — the claim statement', () => {
  const sql = outboxClaimSqlV1();

  it('locks with FOR UPDATE SKIP LOCKED so concurrent drainers partition the backlog', () => {
    expect(sql).toContain('FOR UPDATE OF o SKIP LOCKED');
  });

  it('claims and marks in one statement, not a select followed by an update', () => {
    // Two statements can both select the same row before either marks it. The
    // CTE feeding the UPDATE is what makes that impossible.
    expect(sql.match(/UPDATE "defense_budget_promotion_outbox"/g)).toHaveLength(1);
    expect(sql.indexOf('WITH eligible AS')).toBeLessThan(
      sql.indexOf('UPDATE "defense_budget_promotion_outbox"'),
    );
  });

  it('checks the pause inside the same statement', () => {
    expect(sql).toContain('"defense_budget_side_effect_drain_pause"');
    expect(sql).toContain('p."paused" = true');
    expect(sql).toContain('NOT EXISTS');
  });

  it('reclaims a PROCESSING row only after the lease has expired', () => {
    expect(sql).toContain(`(${OUTBOX_PROCESSING_LEASE_MS_V1} * INTERVAL '1 millisecond')`);
    expect(sql).toContain(`o."status" = 'PROCESSING'`);
  });

  it('never claims a DONE or POISON row', () => {
    expect(sql).toContain(`o."status" IN ('PENDING', 'FAILED')`);
    expect(sql).not.toContain(`'DONE'`);
    expect(sql).not.toContain(`'POISON'`);
  });

  it('resolves both sides of the money from the two snapshots without overwriting', () => {
    // COALESCE, not assignment: a future writer that does populate these
    // columns must win over this fallback.
    expect(sql).toContain(`COALESCE(t."old_original_value", prior."money_original_value")`);
    expect(sql).toContain(`COALESCE(t."new_value_millions",  curr."money_value_millions")`);
    expect(sql).toContain('LEFT JOIN "defense_budget_canonical_row" prior');
    expect(sql).toContain('LEFT JOIN "defense_budget_canonical_row" curr');
  });

  it('joins the canonical rows on the identity unique key', () => {
    for (const alias of ['prior', 'curr']) {
      expect(sql).toContain(`${alias}."canonical_entity" = e."canonical_entity"`);
      expect(sql).toContain(`${alias}."canonical_natural_key" = e."canonical_natural_key"`);
    }
  });

  it('scopes the batch to the domain and environment of the activation', () => {
    expect(sql).toContain(
      'JOIN "defense_budget_promotion_activation" a ON a."id" = o."activation_id"',
    );
    expect(sql).toContain('a."domain" = $1');
    expect(sql).toContain('a."environment" = $2');
  });

  it('does not increment attempts when claiming', () => {
    // The policy reads attempts *before* the failure to decide retry versus
    // quarantine. Incrementing here would quarantine every row one attempt
    // early.
    expect(sql).not.toContain('"attempts" = "attempts" + 1');
  });
});

describe('Workstream L — reading a claimed row', () => {
  it('normalizes NUMERIC padding back to canonical decimal form', () => {
    const row = outboxRowFromClaimV1(claimedRow());
    expect(row.oldValueMillions).toBe('1');
    expect(row.newValueMillions).toBe('1.25');
  });

  it('refuses money that arrived as a JavaScript number', () => {
    expect(() => exactDecimalFromColumnV1(1.25, 'new_value_millions')).toThrow(
      /must not pass through a float/,
    );
  });

  it('accepts a Decimal-like object by its string form', () => {
    expect(exactDecimalFromColumnV1({ toString: () => '2.500000000' }, 'x')).toBe('2.5');
  });

  it('keeps null as null rather than zero', () => {
    // A row with no money is not a row worth nothing.
    expect(exactDecimalFromColumnV1(null, 'x')).toBeNull();
    const row = outboxRowFromClaimV1(
      claimedRow({ old_value_millions: null, old_original_value: null }),
    );
    expect(row.oldValueMillions).toBeNull();
    expect(row.oldOriginalValue).toBeNull();
  });
});

describe('Workstream L — the adapter', () => {
  it('claims with the caller instant and limit', async () => {
    const { prisma, calls } = fakePrisma([[claimedRow()]]);
    const repository = createOutboxDrainRepositoryPrismaV1(prisma);
    const rows = await repository.claimBatch({
      domain: 'defense_budget',
      environment: 'test',
      limit: 25,
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(calls[0]?.params).toEqual(['defense_budget', 'test', NOW.toISOString(), 25]);
  });

  it('marks done only while the row is still PROCESSING', async () => {
    const { prisma, calls } = fakePrisma();
    await createOutboxDrainRepositoryPrismaV1(prisma).markDone('row-1', NOW);
    expect(calls[0]?.sql).toContain(`"status" = 'DONE'`);
    expect(calls[0]?.sql).toContain(`AND "status" = 'PROCESSING'`);
  });

  it('increments attempts and stamps the instant on failure and on poison', async () => {
    const { prisma, calls } = fakePrisma();
    const repository = createOutboxDrainRepositoryPrismaV1(prisma);
    await repository.markFailed({ rowId: 'row-1', error: 'downstream 503', attemptedAt: NOW });
    await repository.markPoison({ rowId: 'row-2', error: 'malformed', attemptedAt: NOW });
    for (const call of calls) {
      expect(call.sql).toContain('"attempts" = "attempts" + 1');
      expect(call.sql).toContain('"last_attempted_at" = $3::timestamptz');
      expect(call.sql).toContain(`AND "status" = 'PROCESSING'`);
    }
    expect(calls[0]?.sql).toContain(`'FAILED'`);
    expect(calls[1]?.sql).toContain(`'POISON'`);
  });

  it('truncates a runaway error rather than refusing to record the failure', async () => {
    const { prisma, calls } = fakePrisma();
    await createOutboxDrainRepositoryPrismaV1(prisma).markFailed({
      rowId: 'row-1',
      error: 'x'.repeat(10_000),
      attemptedAt: NOW,
    });
    expect(String(calls[0]?.params[1]).length).toBe(4_000);
  });

  it('reports zero for statuses the activation has none of', async () => {
    const { prisma } = fakePrisma([
      [
        { status: 'DONE', count: 3 },
        { status: 'POISON', count: 1 },
      ],
    ]);
    const counts = await createOutboxDrainRepositoryPrismaV1(prisma).countsForActivation('act-1');
    expect(counts).toEqual({ pending: 0, processing: 0, failed: 0, poison: 1 });
  });

  it('refuses to move a run that never reached the outbox', async () => {
    const { prisma, calls } = fakePrisma();
    await createOutboxDrainRepositoryPrismaV1(prisma).setRunSideEffectStatus({
      activationId: 'act-1',
      status: 'COMPLETED',
    });
    // FAILED_PRECOMMIT and CANCELLED are absent from the permitted set, so a
    // drain cannot report side effects complete for a run that never committed.
    expect(calls[0]?.sql).toContain(`'COMMITTED', 'SIDE_EFFECTS_PENDING'`);
    expect(calls[0]?.sql).not.toContain('FAILED_PRECOMMIT');
    expect(calls[0]?.sql).not.toContain('CANCELLED');
  });

  it('reads the pause state through the shared module', async () => {
    const { prisma } = fakePrisma();
    const repository = createOutboxDrainRepositoryPrismaV1(prisma);
    expect(await repository.isDrainPaused('defense_budget', 'test')).toBe(false);
    await prisma.defenseBudgetSideEffectDrainPause.upsert({});
    expect(await repository.isDrainPaused('defense_budget', 'test')).toBe(true);
  });

  it('lets the rehearsal shorten the lease without touching the policy default', () => {
    const sql = outboxClaimSqlV1({ processingLeaseMs: 250 });
    expect(sql).toContain(`(250 * INTERVAL '1 millisecond')`);
    expect(outboxClaimSqlV1()).toContain(
      `(${OUTBOX_PROCESSING_LEASE_MS_V1} * INTERVAL '1 millisecond')`,
    );
  });
});
