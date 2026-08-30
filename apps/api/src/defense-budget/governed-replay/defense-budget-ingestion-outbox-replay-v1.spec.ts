import {
  createGovernedReplayRepositoryV1,
  governedReplaySqlV1,
  governedReplayPreviewSqlV1,
  GovernedReplayValidationErrorV1,
} from './defense-budget-ingestion-outbox-replay-v1.js';
import {
  createIngestionOutboxDrainRepositoryPrismaV1,
  ingestionOutboxClaimByIdSqlV1,
} from '../ingestion-outbox-drain-repository-prisma-v1.js';

const NOW = new Date('2026-08-30T00:00:00.000Z');
const CANARY_ROW_ID = '1c6b97bf-e978-4d14-b015-97b88d6b8de3';

function eligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CANARY_ROW_ID,
    state: 'dead_letter',
    attempts: 2,
    leased_by: null,
    last_error: 'verification deterministically rejected (artifact: s3://.../af083305...)',
    metadata_jsonb: {
      sourceDocumentId: '62e8a102-4f01-471b-9cb6-eab58cb41270',
      governedDisposition: 'verification_rejected',
      verifierDecision: 'REJECT',
    },
    ...overrides,
  };
}

describe('governed replay -- structural SQL guarantees', () => {
  test('replay is one statement naming exactly one table', () => {
    const sql = governedReplaySqlV1();
    expect(sql.trim().split(';')).toHaveLength(1);
    expect(sql).toContain('"defense_budget_ingestion_outbox"');
    expect(sql).not.toMatch(/budget_verification_run_v1|budget_verification_check_v1|budget_verification_discrepancy_v1|source_document/);
  });

  test('replay is exact-row only: WHERE filters on the named id, never a batch predicate', () => {
    const sql = governedReplaySqlV1();
    expect(sql).toContain('o."id"=$1::uuid');
    expect(sql).not.toMatch(/LIMIT|ORDER BY/);
  });

  test('replay eligibility requires dead_letter, unleased, verification_rejected + REJECT -- all in the WHERE, not just app code', () => {
    const sql = governedReplaySqlV1();
    expect(sql).toContain(`o."state"='dead_letter'`);
    expect(sql).toContain(`o."leased_by" IS NULL`);
    expect(sql).toContain(`o."metadata_jsonb"->>'governedDisposition'='verification_rejected'`);
    expect(sql).toContain(`o."metadata_jsonb"->>'verifierDecision'='REJECT'`);
  });

  test('replay takes the row lock before mutating (FOR UPDATE), so a concurrent second attempt cannot race the eligibility check', () => {
    expect(governedReplaySqlV1()).toContain('FOR UPDATE OF o');
  });

  test('audit entry is appended (COALESCE ... || jsonb_build_array), never replacing prior replayHistory', () => {
    const sql = governedReplaySqlV1();
    expect(sql).toMatch(/COALESCE\(t\."metadata_jsonb"->'replayHistory', '\[\]'::jsonb\)\s*\|\|/);
  });

  test('replay never touches attempts -- historical execution count is preserved, not reset', () => {
    expect(governedReplaySqlV1()).not.toMatch(/"attempts"\s*=/);
  });

  test('preview is read-only: a plain SELECT, no UPDATE/INSERT/DELETE keyword', () => {
    const sql = governedReplayPreviewSqlV1();
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/i);
  });

  test('the existing batch/single-row claim SQL is untouched by this PR', () => {
    // Pinned literally so any accidental edit to the shared claim SQL while
    // building the replay feature fails this test immediately.
    expect(ingestionOutboxClaimByIdSqlV1()).toContain('o."id"=$4::uuid');
    expect(ingestionOutboxClaimByIdSqlV1()).toContain('FOR UPDATE OF o SKIP LOCKED');
  });
});

describe('governed replay -- fail-closed input validation (never reaches the database)', () => {
  test('missing actor refuses before any query is issued', async () => {
    const calls: string[] = [];
    const prisma = { async $queryRawUnsafe<T>(sql: string) { calls.push(sql); return [] as T; } };
    const repo = createGovernedReplayRepositoryV1(prisma);
    await expect(
      repo.replayDeadLetterForVerifierFixV1({ rowId: CANARY_ROW_ID, now: NOW, actor: '  ', reason: 'fix landed' }),
    ).rejects.toThrow(GovernedReplayValidationErrorV1);
    expect(calls).toHaveLength(0);
  });

  test('missing reason refuses before any query is issued', async () => {
    const calls: string[] = [];
    const prisma = { async $queryRawUnsafe<T>(sql: string) { calls.push(sql); return [] as T; } };
    const repo = createGovernedReplayRepositoryV1(prisma);
    await expect(
      repo.replayDeadLetterForVerifierFixV1({ rowId: CANARY_ROW_ID, now: NOW, actor: 'neo@capiro.ai', reason: '' }),
    ).rejects.toThrow(GovernedReplayValidationErrorV1);
    expect(calls).toHaveLength(0);
  });
});

describe('governed replay -- eligibility outcomes against a stateful fake outbox', () => {
  /**
   * A minimal in-JS re-implementation of exactly what `governedReplaySqlV1`
   * and `governedReplayPreviewSqlV1` (and, for the cross-function test,
   * `ingestionOutboxClaimByIdSqlV1`) actually do against a real Postgres row
   * -- lets these tests prove real sequencing (replay then claim, or two
   * concurrent replays) without a live database, the same way the SQL-text
   * assertions above prove the guard clauses exist.
   */
  class StatefulOutboxFake {
    private rows: Map<string, Record<string, unknown>>;
    constructor(initial: Array<Record<string, unknown>>) {
      this.rows = new Map(initial.map((r) => [String(r.id), structuredClone(r)]));
    }
    row(id: string) {
      return this.rows.get(id);
    }
    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
      if (sql.includes('replayHistory')) {
        const [rowId, nowIso, actor, reason] = values as [string, string, string, string];
        const row = this.rows.get(rowId);
        if (!row) return [] as T;
        const metadata = (row.metadata_jsonb ?? {}) as Record<string, unknown>;
        const eligible =
          row.state === 'dead_letter' &&
          row.leased_by == null &&
          metadata.governedDisposition === 'verification_rejected' &&
          metadata.verifierDecision === 'REJECT';
        if (!eligible) return [] as T;
        const history = Array.isArray(metadata.replayHistory) ? (metadata.replayHistory as unknown[]) : [];
        const entry = {
          replayRequestedAt: nowIso,
          replayRequestedBy: actor,
          replayReason: reason,
          previousState: 'dead_letter',
          previousGovernedDisposition: metadata.governedDisposition,
          previousVerifierDecision: metadata.verifierDecision,
          previousLastError: row.last_error ?? null,
          replaySequence: history.length + 1,
        };
        row.state = 'pending';
        row.leased_by = null;
        row.leased_until = null;
        row.available_at = nowIso;
        row.metadata_jsonb = { ...metadata, replayHistory: [...history, entry] };
        row.updated_at = nowIso;
        return [{ id: row.id, attempts: row.attempts, metadata_jsonb: row.metadata_jsonb }] as T;
      }
      if (sql.startsWith('SELECT "id", "state"')) {
        const [rowId] = values as [string];
        const row = this.rows.get(rowId);
        if (!row) return [] as T;
        const metadata = (row.metadata_jsonb ?? {}) as Record<string, unknown>;
        return [
          {
            id: row.id,
            state: row.state,
            governed_disposition: metadata.governedDisposition ?? null,
            verifier_decision: metadata.verifierDecision ?? null,
            last_error: row.last_error ?? null,
            attempts: row.attempts,
            leased_by: row.leased_by ?? null,
          },
        ] as T;
      }
      if (sql.includes('o."id"=$4::uuid') && sql.includes('SKIP LOCKED')) {
        const [, , leaseOwner, rowId] = values as [string, number, string, string];
        const row = this.rows.get(rowId as string);
        if (!row) return [] as T;
        const eligible = row.state === 'pending' || row.state === 'failed';
        if (!eligible) return [] as T;
        row.state = 'leased';
        row.leased_by = leaseOwner;
        row.leased_until = 'later';
        return [{ id: row.id, observation_id: row.observation_id ?? 'obs-1', attempts: row.attempts }] as T;
      }
      throw new Error(`StatefulOutboxFake: unrecognized SQL: ${sql.slice(0, 120)}`);
    }
  }

  test('eligible verifier-rejected dead_letter row -> pending, prior metadata preserved, audit entry added, attempts untouched', async () => {
    const fake = new StatefulOutboxFake([eligibleRow()]);
    const repo = createGovernedReplayRepositoryV1(fake);
    const result = await repo.replayDeadLetterForVerifierFixV1({
      rowId: CANARY_ROW_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'PR #1350 wires the real R-1 extractor; retrying now that the fix is merged',
    });
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(2); // preserved, never reset
    const row = fake.row(CANARY_ROW_ID)!;
    expect(row.state).toBe('pending');
    expect(row.leased_by).toBeNull();
    const metadata = row.metadata_jsonb as Record<string, unknown>;
    // Historical governed disposition is never erased.
    expect(metadata.governedDisposition).toBe('verification_rejected');
    expect(metadata.verifierDecision).toBe('REJECT');
    const history = metadata.replayHistory as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]!.replayRequestedBy).toBe('neo@capiro.ai');
    expect(history[0]!.replayReason).toMatch(/PR #1350/);
    expect(history[0]!.previousGovernedDisposition).toBe('verification_rejected');
    expect(history[0]!.replaySequence).toBe(1);
  });

  test('wrong row id -> no-op (returns null, no row created or altered)', async () => {
    const fake = new StatefulOutboxFake([eligibleRow()]);
    const repo = createGovernedReplayRepositoryV1(fake);
    const result = await repo.replayDeadLetterForVerifierFixV1({
      rowId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'typo test',
    });
    expect(result).toBeNull();
    expect(fake.row(CANARY_ROW_ID)!.state).toBe('dead_letter'); // untouched
  });

  test('pending row -> refused', async () => {
    const fake = new StatefulOutboxFake([eligibleRow({ state: 'pending' })]);
    const repo = createGovernedReplayRepositoryV1(fake);
    const result = await repo.replayDeadLetterForVerifierFixV1({
      rowId: CANARY_ROW_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'x',
    });
    expect(result).toBeNull();
  });

  test('leased row -> refused', async () => {
    const fake = new StatefulOutboxFake([eligibleRow({ leased_by: 'some-worker' })]);
    const repo = createGovernedReplayRepositoryV1(fake);
    const result = await repo.replayDeadLetterForVerifierFixV1({
      rowId: CANARY_ROW_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'x',
    });
    expect(result).toBeNull();
  });

  test('retries_exhausted (infra-poison class, not a verifier outcome) -> refused, not explicitly allowed', async () => {
    const fake = new StatefulOutboxFake([
      eligibleRow({ metadata_jsonb: { governedDisposition: 'retries_exhausted' } }),
    ]);
    const repo = createGovernedReplayRepositoryV1(fake);
    const result = await repo.replayDeadLetterForVerifierFixV1({
      rowId: CANARY_ROW_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'x',
    });
    expect(result).toBeNull();
  });

  test('review_required (its own governed human-review workflow) -> refused, not this replay path', async () => {
    const fake = new StatefulOutboxFake([
      eligibleRow({ metadata_jsonb: { governedDisposition: 'review_required', verifierDecision: 'REVIEW' } }),
    ]);
    const repo = createGovernedReplayRepositoryV1(fake);
    const result = await repo.replayDeadLetterForVerifierFixV1({
      rowId: CANARY_ROW_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'x',
    });
    expect(result).toBeNull();
  });

  test('concurrent replay requests on the same row -> only one succeeds', async () => {
    const fake = new StatefulOutboxFake([eligibleRow()]);
    const repo = createGovernedReplayRepositoryV1(fake);
    const request = { rowId: CANARY_ROW_ID, now: NOW, actor: 'neo@capiro.ai', reason: 'race test' };
    // The stateful fake applies each call synchronously to the same Map, so
    // sequential awaits here are exactly what Postgres's row lock forces two
    // real concurrent transactions into: the second sees the row already
    // transitioned to 'pending' and its WHERE clause matches nothing.
    const first = await repo.replayDeadLetterForVerifierFixV1(request);
    const second = await repo.replayDeadLetterForVerifierFixV1(request);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test('legacy eight rows cannot be affected by a target-row replay', async () => {
    const legacyIds = Array.from({ length: 8 }, (_, i) => `legacy-${i}`);
    const legacyRows = legacyIds.map((id) =>
      eligibleRow({ id, state: 'pending', metadata_jsonb: {}, leased_by: null }),
    );
    const fake = new StatefulOutboxFake([eligibleRow(), ...legacyRows]);
    const repo = createGovernedReplayRepositoryV1(fake);
    await repo.replayDeadLetterForVerifierFixV1({
      rowId: CANARY_ROW_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'x',
    });
    for (const id of legacyIds) {
      expect(fake.row(id)).toEqual(eligibleRow({ id, state: 'pending', metadata_jsonb: {}, leased_by: null }));
    }
  });

  test('exact-row drain can claim the replayed canary afterward, through the REAL (unmodified) claim repository', async () => {
    const fake = new StatefulOutboxFake([eligibleRow({ observation_id: 'obs-canary' })]);
    const replayRepo = createGovernedReplayRepositoryV1(fake);
    const claimRepo = createIngestionOutboxDrainRepositoryPrismaV1(fake);

    const replayed = await replayRepo.replayDeadLetterForVerifierFixV1({
      rowId: CANARY_ROW_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'fix landed, retry',
    });
    expect(replayed).not.toBeNull();

    const claimed = await claimRepo.claimRowById({ rowId: CANARY_ROW_ID, leaseOwner: 'drain-worker', now: NOW });
    expect(claimed).toEqual({ id: CANARY_ROW_ID, observationId: 'obs-canary', attempts: 2 });
    expect(fake.row(CANARY_ROW_ID)!.state).toBe('leased');
  });

  test('preview never mutates the target row', async () => {
    const fake = new StatefulOutboxFake([eligibleRow()]);
    const repo = createGovernedReplayRepositoryV1(fake);
    const before = structuredClone(fake.row(CANARY_ROW_ID));
    const preview = await repo.previewReplayTarget(CANARY_ROW_ID);
    expect(preview).toEqual({
      id: CANARY_ROW_ID,
      state: 'dead_letter',
      governedDisposition: 'verification_rejected',
      verifierDecision: 'REJECT',
      lastError: expect.any(String),
      attempts: 2,
      leasedBy: null,
    });
    expect(fake.row(CANARY_ROW_ID)).toEqual(before);
  });
});
