import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClientKbService } from './client-kb.service.js';
import { embedAndUpsert } from './embedder.js';
import { AttachmentIndexWorkerService } from '../engagement-workers/attachment-index-worker.service.js';

jest.mock('./embedder.js', () => ({
  embedAndUpsert: jest.fn(),
  normalize: (value: string) => value,
}));

/**
 * MG-06 correction2 witnesses.
 *
 * F1  a paused exclusion must not delete a row that became indexable again, and a
 *     legitimate exclusion must write truthful visible status in the purge's own
 *     transaction; the absent-row path re-checks absence before purging.
 * F3  the attempt is bound to the epoch its snapshot was read at, so a source
 *     change (including an A→B→A one) between read and claim publishes nothing.
 * F4  discovery agrees with the readiness rule execution enforces, and a refused
 *     row never stops the batch behind it.
 * F5  a real source change persists due work on the row itself (trigger), while an
 *     unchanged completed metadata-only row stays excluded.
 * F6  a destroyed worker never starts the next claim in an active batch.
 */
type Snapshot = {
  id: string;
  clientId: string | null;
  meetingId: string | null;
  s3Key: string;
  viewerMode: string;
  lifecycleStatus: string;
  scanStatus: string | null;
  supersededByAttachmentId: string | null;
  fileName: string;
  contentType: string | null;
  indexClaimToken: string | null;
  indexSourceGeneration: number;
};

function eligible(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'document-1',
    clientId: 'client-1',
    meetingId: null,
    s3Key: 'tenant/doc',
    viewerMode: 'all',
    lifecycleStatus: 'ready',
    scanStatus: 'clean',
    supersededByAttachmentId: null,
    fileName: 'Evidence.txt',
    contentType: 'text/plain',
    indexClaimToken: null,
    indexSourceGeneration: 0,
    ...overrides,
  };
}

function fixture(snapshot: Snapshot | null, locked: Snapshot | null = snapshot) {
  const state = {
    snapshot,
    locked,
    present: locked !== null,
    claimable: true,
    claimGeneration: snapshot?.indexSourceGeneration ?? 0,
    purges: 0,
    advisoryLocks: 0,
  };
  const updates: Array<Record<string, unknown>> = [];
  const yields: Array<Record<string, unknown>> = [];
  const query = jest.fn(
    async (
      sql: string,
      ...params: unknown[]
    ): Promise<
      Array<
        | Snapshot
        | { token: string; generation: number }
        | { present: boolean }
        | { tenantId: string; id: string }
      >
    > => {
      if (sql.includes('SET index_claim_token')) {
        if (!state.claimable) return [];
        const token = String(params[1]);
        // Mirror the database: the claim is now the row's current claim, so the
        // later lock sees this attempt as the owner.
        if (state.locked) state.locked.indexClaimToken = token;
        return [{ token, generation: state.claimGeneration }];
      }
      if (sql.includes('AS present')) return [{ present: state.present }];
      if (sql.includes('FOR UPDATE')) return state.locked ? [{ ...state.locked }] : [];
      return [];
    },
  );
  const execute = jest.fn(async (sql: string) => {
    if (sql.includes('pg_advisory_xact_lock')) state.advisoryLocks += 1;
    if (sql.trimStart().startsWith('DELETE')) state.purges += 1;
    return 1;
  });
  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    updates.push(data);
    return {};
  });
  const tx = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: execute,
    engagementAttachment: {
      findFirst: jest.fn(async () => state.snapshot),
      update,
      updateMany: jest.fn(async ({ where }: { where: { indexClaimToken?: string } }) => {
        yields.push(where as unknown as Record<string, unknown>);
        return { count: 1 };
      }),
    },
    client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1', name: 'Client One' }) },
    meeting: { findFirst: jest.fn().mockResolvedValue({ subject: 'Meeting' }) },
  };
  const service = Object.create(ClientKbService.prototype) as ClientKbService;
  const configValues: Record<string, unknown> = {
    CLIO_CLIENT_KB_ENABLED: true,
    ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED: true,
  };
  Object.assign(service, {
    // scanRequired = true unless a test says otherwise.
    config: { get: jest.fn((key: string) => configValues[key] ?? false) },
    prisma: {
      withTenant: jest.fn(async (_t: string, fn: (arg: unknown) => Promise<unknown>) => fn(tx)),
      withSystem: jest.fn(async (fn: (arg: unknown) => Promise<unknown>) => fn(tx)),
    },
    extractAttachmentTextForKb: jest
      .fn()
      .mockResolvedValue({ text: 'Evidence body', truncated: false }),
    countClientChunks: jest.fn().mockResolvedValue(0),
    logger: { warn: jest.fn(), log: jest.fn() },
  });
  return { service, state, updates, yields, query, execute };
}

describe('MG-06 correction2 exclusion, epoch binding and recovery', () => {
  beforeEach(() => {
    jest.mocked(embedAndUpsert).mockReset();
    jest.mocked(embedAndUpsert).mockResolvedValue('inserted');
  });

  it('F1 refuses a stale exclusion once the row is indexable again, writing nothing', async () => {
    // The first read saw a restricted document (so this run decided to exclude);
    // by the time the locked re-read happens the row is indexable again - a newer
    // attempt may already have published it.
    const f = fixture(eligible({ viewerMode: 'restricted' }), eligible());

    const outcome = await f.service.indexAttachment('tenant', 'document-1');

    expect(outcome).toBe('skipped');
    expect(f.state.purges).toBe(0);
    expect(f.updates).toHaveLength(0);
    expect(jest.mocked(embedAndUpsert)).not.toHaveBeenCalled();
  });

  it('F1 refuses a stale exclusion when the row’s client identity moved', async () => {
    const f = fixture(
      eligible({ viewerMode: 'restricted' }),
      eligible({ viewerMode: 'restricted', clientId: 'client-2' }),
    );

    expect(await f.service.indexAttachment('tenant', 'document-1')).toBe('skipped');
    expect(f.state.purges).toBe(0);
    expect(f.updates).toHaveLength(0);
  });

  it('F1 purges and clears the success badge atomically for a still-excluded row', async () => {
    const f = fixture(eligible({ viewerMode: 'restricted' }));

    expect(await f.service.indexAttachment('tenant', 'document-1')).toBe('skipped');
    expect(f.state.purges).toBe(1);
    expect(f.updates).toEqual([{ indexedAt: null }]);
    expect(jest.mocked(embedAndUpsert)).not.toHaveBeenCalled();
  });

  it.each([
    ['restricted', { viewerMode: 'restricted' }],
    ['quarantined', { lifecycleStatus: 'quarantined', scanStatus: 'pending' }],
    ['threat', { scanStatus: 'threat' }],
    ['unscanned', { scanStatus: null }],
    ['superseded', { supersededByAttachmentId: 'replacement' }],
    ['clientless', { clientId: null }],
  ] as const)(
    'F1 cleans up a %s row without any provider call and with a truthful badge',
    async (_label, overrides) => {
      const f = fixture(eligible(overrides));

      expect(await f.service.indexAttachment('tenant', 'document-1')).toBe('skipped');
      expect(f.state.purges).toBe(1);
      expect(f.updates).toEqual([{ indexedAt: null }]);
      expect(jest.mocked(embedAndUpsert)).not.toHaveBeenCalled();
    },
  );

  it('F1 re-checks absence under the document identity lock before purging residual chunks', async () => {
    const gone = fixture(null);
    expect(await gone.service.indexAttachment('tenant', 'document-1')).toBe('skipped');
    expect(gone.state.advisoryLocks).toBe(1);
    expect(gone.state.purges).toBe(1);

    // The document reappeared (the idempotent path reuses the id): the newer
    // document's evidence is never purged by a stale run.
    const reappeared = fixture(null);
    reappeared.state.present = true;
    expect(await reappeared.service.indexAttachment('tenant', 'document-1')).toBe('skipped');
    expect(reappeared.state.purges).toBe(0);
  });

  it('F3 refuses a pre-claim A→B→A source change and hands its claim back', async () => {
    // Snapshot read at epoch 0 with an unchanged client/meeting/s3 tuple; the row
    // went A→B→A before the claim, so the row itself - and therefore every later
    // lock - reads epoch 2. Only the epoch the SNAPSHOT was taken at can tell this
    // attempt its filename/MIME/client inputs are a stale revision.
    const f = fixture(
      eligible({ indexSourceGeneration: 0 }),
      eligible({ indexSourceGeneration: 2 }),
    );
    f.state.claimGeneration = 2;

    const outcome = await f.service.indexAttachment('tenant', 'document-1');

    expect(outcome).toBe('skipped');
    expect(f.state.purges).toBe(0);
    expect(f.updates).toHaveLength(0);
    expect(jest.mocked(embedAndUpsert)).not.toHaveBeenCalled();
    // Token-filtered hand-back so the row is due again immediately.
    expect(f.yields).toHaveLength(1);
  });

  it('F3 publishes normally when the epoch the snapshot read is still the claimed epoch', async () => {
    const f = fixture(eligible({ indexSourceGeneration: 4 }));
    f.state.claimGeneration = 4;

    expect(await f.service.indexAttachment('tenant', 'document-1')).toBe('indexed');
    expect(f.updates.at(-1)).toEqual(expect.objectContaining({ indexedAt: expect.any(Date) }));
  });

  it('F4 discovery applies the same readiness rule execution uses, and a refused row does not stop the batch', async () => {
    const f = fixture(eligible());
    f.query.mockResolvedValue([]);
    await f.service.runDueAttachmentIndexSweep();

    const sql = String(f.query.mock.calls[0]![0]);
    // Scan readiness is part of discovery, with the switch bound as a parameter.
    expect(sql).toContain("($1::boolean AND scan_status = 'clean')");
    expect(sql).toContain("(NOT $1::boolean AND (scan_status IS NULL OR scan_status <> 'threat'))");
    // Ordering still bounds the batch and never lets one row monopolize it.
    expect(sql).toContain('ORDER BY index_next_attempt_at ASC NULLS FIRST, created_at ASC, id ASC');
    expect(sql).toContain('LIMIT 25');
    expect(f.query.mock.calls[0]![1]).toBe(true);

    // Progress: the first row is refused, the eligible one behind it still runs.
    const index = jest.fn().mockResolvedValueOnce('skipped').mockResolvedValueOnce('indexed');
    f.service.indexAttachment = index;
    f.query.mockResolvedValue([
      { tenantId: 'tenant-1', id: 'excluded-row' },
      { tenantId: 'tenant-1', id: 'eligible-row' },
    ]);
    const result = await f.service.runDueAttachmentIndexSweep();
    expect(result).toEqual({ selected: 2, indexed: 1, metadataOnly: 0, failed: 0 });
    expect(index.mock.calls).toEqual([
      ['tenant-1', 'excluded-row'],
      ['tenant-1', 'eligible-row'],
    ]);
  });

  it('F4 keeps a completed metadata-only row out of the NULL-due branch', async () => {
    const f = fixture(eligible());
    f.query.mockResolvedValue([]);
    await f.service.runDueAttachmentIndexSweep();
    const sql = String(f.query.mock.calls[0]![0]);
    // Only an explicit due marker may pick an empty row back up (see F5).
    expect(sql).toContain(
      "(index_next_attempt_at IS NULL AND indexed_at IS NULL\n                    AND coalesce(extraction_status, '') <> 'empty')",
    );
    expect(sql).toContain(
      'index_next_attempt_at IS NOT NULL AND index_next_attempt_at <= clock_timestamp()',
    );
  });

  it('F5 persists due work for a source change and never for the attempt’s own writes', () => {
    // The trigger is the durable scheduling half; the real proof is the PG gate.
    const sql = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20261026140000_attachment_index_claim/migration.sql',
      ),
      'utf8',
    );
    const generationBranch =
      /IF \(to_jsonb\(NEW\) - ignored\) IS DISTINCT FROM \(to_jsonb\(OLD\) - ignored\) THEN([\s\S]*?)ELSE/.exec(
        sql,
      );
    expect(generationBranch).not.toBeNull();
    expect(generationBranch![1]).toContain(
      'NEW.index_source_generation := OLD.index_source_generation + 1',
    );
    expect(generationBranch![1]).toContain('NEW.index_next_attempt_at := clock_timestamp()');
    // The ignored set excludes the claim and status columns, so those writes cannot
    // schedule work or move the epoch.
    for (const column of [
      'index_claim_token',
      'index_claim_expires_at',
      'index_next_attempt_at',
      'indexed_at',
      'extraction_status',
      'extraction_metadata_jsonb',
    ]) {
      expect(sql).toContain(`'${column}'`);
    }
    // The ELSE branch must not overwrite a claim's own due marker.
    const elseBranch = /ELSE([\s\S]*?)END IF;/.exec(sql);
    expect(elseBranch![1]).not.toContain('index_next_attempt_at');
  });

  it('F6 never starts the next claim when the worker is destroyed during the batch', async () => {
    jest.useFakeTimers();
    const started: string[] = [];
    const kb = { runDueAttachmentIndexSweep: jest.fn() };
    const runtime = { backgroundWorkersEnabled: () => true, assertBackgroundOwner: jest.fn() };
    const service = new AttachmentIndexWorkerService(kb as never, runtime as never);
    service.onModuleInit();

    // The sweep the worker actually drives: two rows, with the destroy landing
    // during the first. The worker's canceller must stop the second claim.
    kb.runDueAttachmentIndexSweep.mockImplementation(
      async (_limit: unknown, options?: { shouldContinue?: () => boolean }) => {
        for (const row of ['first', 'second']) {
          if (options?.shouldContinue && !options.shouldContinue()) break;
          started.push(row);
          if (row === 'first') service.onModuleDestroy();
        }
        return { selected: 2, indexed: started.length, metadataOnly: 0, failed: 0 };
      },
    );

    await (service as unknown as { tick: () => Promise<void> }).tick();

    expect(started).toEqual(['first']);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
