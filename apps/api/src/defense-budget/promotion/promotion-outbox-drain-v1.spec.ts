/**
 * Phase 7 Workstream L — drain policy, against an in-memory port.
 *
 * The `FOR UPDATE SKIP LOCKED` claim itself is a database behaviour and is
 * proved in the disposable-PostgreSQL rehearsal, not here. What is proved here
 * is everything the database cannot decide: when a row is retried versus
 * quarantined, when a run may call itself COMPLETED, and that a paused drain
 * claims nothing.
 */
import {
  OUTBOX_BACKOFF_CAP_MS_V1,
  OUTBOX_MAX_ATTEMPTS_V1,
  drainBackoffMsV1,
  drainFailureDispositionV1,
  drainPromotionOutboxBatchV1,
  isDrainEligibleV1,
  nextRunStatusAfterDrainV1,
  type OutboxDrainRepositoryV1,
  type OutboxHandlerV1,
  type OutboxRowV1,
} from './promotion-outbox-drain-v1.js';

const NOW = new Date('2026-08-07T12:00:00.000Z');

function row(o: Partial<OutboxRowV1> = {}): OutboxRowV1 {
  return {
    id: 'row-1',
    dedupeKey: 'dedupe-1',
    activationId: 'act-1',
    oldSnapshotId: 'snap-old',
    newSnapshotId: 'snap-new',
    canonicalEntity: 'canonical_om_sag_year',
    canonicalNaturalKey: 'ARMY|OMA|SAG-111',
    family: 'om',
    fiscalYear: 2027,
    fundingField: 'request',
    stage: null,
    oldOriginalValue: '1000',
    oldValueMillions: '1',
    newOriginalValue: '1250',
    newValueMillions: '1.25',
    changeClassification: 'material_change',
    suppressAlert: false,
    isCorrection: false,
    isRollback: false,
    attempts: 0,
    ...o,
  };
}

interface FakeRepository extends OutboxDrainRepositoryV1 {
  done: string[];
  failed: { rowId: string; error: string }[];
  poisoned: { rowId: string; error: string }[];
  runStatus: Record<string, string>;
  claims: number;
  counts: { pending: number; processing: number; failed: number; poison: number };
}

function repository(rows: OutboxRowV1[], opts: { paused?: boolean } = {}): FakeRepository {
  const fake: FakeRepository = {
    done: [],
    failed: [],
    poisoned: [],
    runStatus: {},
    claims: 0,
    counts: { pending: 0, processing: 0, failed: 0, poison: 0 },

    isDrainPaused: async () => opts.paused === true,

    claimBatch: async ({ limit }: { limit: number }) => {
      fake.claims += 1;
      return rows.slice(0, limit);
    },

    markDone: async (rowId: string) => {
      fake.done.push(rowId);
    },

    markFailed: async ({ rowId, error }: { rowId: string; error: string }) => {
      fake.failed.push({ rowId, error });
    },

    markPoison: async ({ rowId, error }: { rowId: string; error: string }) => {
      fake.poisoned.push({ rowId, error });
    },

    countsForActivation: async () => fake.counts,

    setRunSideEffectStatus: async ({
      activationId,
      status,
    }: {
      activationId: string;
      status: string;
    }) => {
      fake.runStatus[activationId] = status;
    },
  };
  return fake;
}

const okHandler: OutboxHandlerV1 = { publish: async () => undefined };
const failHandler = (message = 'downstream refused'): OutboxHandlerV1 => ({
  publish: async () => {
    throw new Error(message);
  },
});

describe('Phase 7 WS L — retry versus quarantine', () => {
  it('retries below the attempt ceiling', () => {
    expect(drainFailureDispositionV1(0)).toBe('retry');
    expect(drainFailureDispositionV1(OUTBOX_MAX_ATTEMPTS_V1 - 3)).toBe('retry');
  });

  it('quarantines on the attempt that reaches the ceiling, not the one after', () => {
    // attemptsBefore is the count held in the database, so the failure being
    // classified is attemptsBefore + 1.
    expect(drainFailureDispositionV1(OUTBOX_MAX_ATTEMPTS_V1 - 2)).toBe('retry');
    expect(drainFailureDispositionV1(OUTBOX_MAX_ATTEMPTS_V1 - 1)).toBe('poison');
    expect(drainFailureDispositionV1(OUTBOX_MAX_ATTEMPTS_V1)).toBe('poison');
  });

  it('honours an explicit ceiling', () => {
    expect(drainFailureDispositionV1(0, 1)).toBe('poison');
    expect(drainFailureDispositionV1(0, 2)).toBe('retry');
  });
});

describe('Phase 7 WS L — backoff', () => {
  it('grows with the attempt count', () => {
    expect(drainBackoffMsV1(1)).toBeLessThan(drainBackoffMsV1(2));
    expect(drainBackoffMsV1(2)).toBeLessThan(drainBackoffMsV1(3));
  });

  it('is capped, so a long outage does not defer a row out of sight', () => {
    expect(drainBackoffMsV1(50)).toBe(OUTBOX_BACKOFF_CAP_MS_V1);
  });

  it('is deterministic — no jitter to make a test flaky', () => {
    expect(drainBackoffMsV1(3)).toBe(drainBackoffMsV1(3));
  });

  it('makes a never-attempted row immediately eligible', () => {
    expect(
      isDrainEligibleV1({ status: 'PENDING', attempts: 0, lastAttemptedAt: null, now: NOW }),
    ).toBe(true);
  });

  it('holds a just-failed row until its backoff elapses', () => {
    const justNow = new Date(NOW.getTime() - 10);
    expect(
      isDrainEligibleV1({ status: 'FAILED', attempts: 2, lastAttemptedAt: justNow, now: NOW }),
    ).toBe(false);

    const longAgo = new Date(NOW.getTime() - OUTBOX_BACKOFF_CAP_MS_V1 - 1);
    expect(
      isDrainEligibleV1({ status: 'FAILED', attempts: 2, lastAttemptedAt: longAgo, now: NOW }),
    ).toBe(true);
  });

  it('never re-claims a done, poisoned, or in-flight row', () => {
    for (const status of ['DONE', 'POISON', 'PROCESSING'] as const) {
      expect(isDrainEligibleV1({ status, attempts: 0, lastAttemptedAt: null, now: NOW })).toBe(
        false,
      );
    }
  });
});

describe('Phase 7 WS L — where a run lands', () => {
  it('completes only when nothing is left', () => {
    expect(nextRunStatusAfterDrainV1({ pending: 0, processing: 0, failed: 0, poison: 0 })).toBe(
      'COMPLETED',
    );
  });

  it('stays pending while anything is still retrying or in flight', () => {
    expect(nextRunStatusAfterDrainV1({ pending: 1, processing: 0, failed: 0, poison: 0 })).toBe(
      'SIDE_EFFECTS_PENDING',
    );
    expect(nextRunStatusAfterDrainV1({ pending: 0, processing: 1, failed: 0, poison: 0 })).toBe(
      'SIDE_EFFECTS_PENDING',
    );
    expect(nextRunStatusAfterDrainV1({ pending: 0, processing: 0, failed: 1, poison: 0 })).toBe(
      'SIDE_EFFECTS_PENDING',
    );
  });

  it('lets one poison row outrank any amount of success', () => {
    expect(nextRunStatusAfterDrainV1({ pending: 0, processing: 0, failed: 0, poison: 1 })).toBe(
      'COMMITTED_WITH_SIDE_EFFECT_FAILURE',
    );
  });

  it('reports failure rather than pending when both are present', () => {
    // A poisoned row is not going to clear on its own, so the run must not sit
    // in a status that implies someone should keep waiting.
    expect(nextRunStatusAfterDrainV1({ pending: 3, processing: 0, failed: 2, poison: 1 })).toBe(
      'COMMITTED_WITH_SIDE_EFFECT_FAILURE',
    );
  });
});

describe('Phase 7 WS L — draining a batch', () => {
  it('publishes and marks each row done', async () => {
    const repo = repository([row(), row({ id: 'row-2', dedupeKey: 'dedupe-2' })]);
    const result = await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW },
      repo,
      okHandler,
    );

    expect(result.claimed).toBe(2);
    expect(result.done).toBe(2);
    expect(repo.done).toEqual(['row-1', 'row-2']);
  });

  it('claims nothing at all while the drain is paused', async () => {
    const repo = repository([row()], { paused: true });
    const result = await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW },
      repo,
      okHandler,
    );

    expect(result.paused).toBe(true);
    expect(result.claimed).toBe(0);
    // The pause is checked BEFORE claiming — a rollback must not race a batch
    // into flight behind it.
    expect(repo.claims).toBe(0);
    expect(repo.done).toEqual([]);
  });

  it('retries a failing row rather than losing it', async () => {
    const repo = repository([row({ attempts: 1 })]);
    const result = await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW },
      repo,
      failHandler(),
    );

    expect(result.retried).toBe(1);
    expect(result.poisoned).toBe(0);
    expect(repo.failed[0]).toMatchObject({ rowId: 'row-1', error: 'downstream refused' });
  });

  it('quarantines a row that has exhausted its attempts, keeping the error', async () => {
    const repo = repository([row({ attempts: OUTBOX_MAX_ATTEMPTS_V1 - 1 })]);
    const result = await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW },
      repo,
      failHandler('still refusing'),
    );

    expect(result.poisoned).toBe(1);
    expect(repo.poisoned[0]).toMatchObject({ rowId: 'row-1', error: 'still refusing' });
  });

  it('does not let one bad row block the good rows behind it', async () => {
    const rows = [row({ id: 'bad' }), row({ id: 'good', dedupeKey: 'dedupe-2' })];
    const handler: OutboxHandlerV1 = {
      publish: async (r) => {
        if (r.id === 'bad') throw new Error('nope');
      },
    };
    const repo = repository(rows);

    const result = await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW },
      repo,
      handler,
    );

    expect(result.done).toBe(1);
    expect(result.retried).toBe(1);
    expect(repo.done).toEqual(['good']);
  });

  it('advances the run to COMPLETED once its outbox is empty', async () => {
    const repo = repository([row()]);
    await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW },
      repo,
      okHandler,
    );
    expect(repo.runStatus['act-1']).toBe('COMPLETED');
  });

  it('advances the run to COMMITTED_WITH_SIDE_EFFECT_FAILURE when a row is poisoned', async () => {
    const repo = repository([row()]);
    repo.counts = { pending: 0, processing: 0, failed: 0, poison: 1 };
    await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW },
      repo,
      okHandler,
    );
    expect(repo.runStatus['act-1']).toBe('COMMITTED_WITH_SIDE_EFFECT_FAILURE');
  });

  it('advances each activation on its own counts, never on another activation behalf', async () => {
    const repo = repository([row(), row({ id: 'row-2', activationId: 'act-2' })]);
    const result = await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW },
      repo,
      okHandler,
    );

    expect(result.runStatuses.map((r) => r.activationId)).toEqual(['act-1', 'act-2']);
  });

  it('does nothing and touches no run when the backlog is empty', async () => {
    const repo = repository([]);
    const result = await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW },
      repo,
      okHandler,
    );

    expect(result).toMatchObject({ claimed: 0, done: 0, paused: false });
    expect(repo.runStatus).toEqual({});
  });

  it('respects a bounded batch size', async () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ id: `row-${i}`, dedupeKey: `d-${i}` }));
    const repo = repository(many);
    const result = await drainPromotionOutboxBatchV1(
      { domain: 'defense_budget', environment: 'test', now: NOW, batchSize: 3 },
      repo,
      okHandler,
    );
    expect(result.claimed).toBe(3);
  });
});
