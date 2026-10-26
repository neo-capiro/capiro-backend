import { ClientKbService } from './client-kb.service.js';
import { embedAndUpsert } from './embedder.js';

jest.mock('./embedder.js', () => ({
  embedAndUpsert: jest.fn(),
  normalize: (value: string) => value,
}));

/**
 * MG-06 review finding 1 — attempt ownership.
 *
 * The source-row lock ends before S3 and provider work, so it fences a CHANGED
 * source but cannot separate two overlapping attempts on an unchanged one. These
 * witnesses pin the claim/epoch fence that does: a losing attempt writes nothing
 * at all, and a completed newer attempt keeps its chunks and its stamp.
 */
const NEWER_ATTEMPT = '11111111-2222-3333-4444-555555555555';

type Row = {
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

function fixture(overrides: Partial<Row> = {}) {
  const row: Row = {
    id: 'document-1',
    clientId: 'client-1',
    meetingId: null,
    s3Key: 'tenant/doc',
    viewerMode: 'all',
    lifecycleStatus: 'ready',
    scanStatus: 'clean',
    supersededByAttachmentId: null,
    fileName: 'Evidence.pdf',
    contentType: 'text/plain',
    indexClaimToken: null,
    indexSourceGeneration: 0,
    ...overrides,
  };
  // The claim CAS is decided by the mock: `claimable=false` models another
  // attempt holding an unexpired lease.
  const state = {
    row,
    claimable: true,
    claimedTokens: [] as string[],
    purges: 0,
    chunks: [] as string[],
  };
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const yields: Array<{ where: unknown; data: Record<string, unknown> }> = [];

  const query = jest.fn(async (sql: string, ...params: unknown[]) => {
    if (sql.includes('SET index_claim_token')) {
      if (!state.claimable) return [];
      const token = String(params[1]);
      state.claimedTokens.push(token);
      state.row.indexClaimToken = token;
      return [{ token, generation: state.row.indexSourceGeneration }];
    }
    if (sql.includes('FROM engagement_attachments')) return [{ ...state.row }];
    if (sql.includes('AS allowed')) return [{ allowed: true }];
    return [];
  });
  const execute = jest.fn(async (sql: string) => {
    if (sql.trimStart().startsWith('DELETE')) {
      state.purges += 1;
      state.chunks = [];
    }
    return 1;
  });
  const update = jest.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
    updates.push(args);
    if ('indexClaimToken' in args.data)
      state.row.indexClaimToken = args.data.indexClaimToken as string | null;
    if ('indexSourceGeneration' in args.data) {
      state.row.indexSourceGeneration = args.data.indexSourceGeneration as number;
    }
    return {};
  });
  const updateMany = jest.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
    yields.push(args);
    const filter = args.where as { indexClaimToken?: string };
    if (filter.indexClaimToken !== state.row.indexClaimToken) return { count: 0 };
    state.row.indexClaimToken = null;
    return { count: 1 };
  });
  const tx = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: execute,
    engagementAttachment: {
      findFirst: jest.fn(async () => ({ ...state.row })),
      update,
      updateMany,
    },
    meeting: { findFirst: jest.fn().mockResolvedValue({ subject: 'Meeting' }) },
    client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1', name: 'Client One' }) },
  };
  const service = Object.create(ClientKbService.prototype) as ClientKbService;
  Object.assign(service, {
    config: { get: jest.fn().mockReturnValue(false) },
    prisma: {
      withTenant: jest.fn(async (_tenant: string, fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      withSystem: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    },
    extractAttachmentTextForKb: jest
      .fn()
      .mockResolvedValue({ text: 'Evidence body', truncated: false }),
    countClientChunks: jest.fn().mockResolvedValue(0),
  });
  /** What the row looks like to a later lock — the newer attempt's token, or the
   * source epoch moved on (an A→B→A association change returns the same tuple). */
  const laterAttemptTakesOver = (generation?: number) => {
    state.row.indexClaimToken =
      generation === undefined ? NEWER_ATTEMPT : state.row.indexClaimToken;
    if (generation !== undefined) state.row.indexSourceGeneration = generation;
  };
  return { service, state, updates, yields, query, execute, updateMany, laterAttemptTakesOver };
}

describe('client document indexing attempt ownership', () => {
  beforeEach(() => {
    // Reset (not just clear) so one test's rejection cannot leak into the next.
    jest.mocked(embedAndUpsert).mockReset();
    jest.mocked(embedAndUpsert).mockResolvedValue('inserted');
  });

  it('refuses to start while another attempt holds a live claim, writing nothing at all', async () => {
    const f = fixture();
    f.state.claimable = false;

    const outcome = await f.service.indexAttachment('tenant', 'document-1');

    expect(outcome).toBe('skipped');
    expect(f.state.purges).toBe(0);
    expect(f.updates).toHaveLength(0);
    expect(jest.mocked(embedAndUpsert)).not.toHaveBeenCalled();
    expect(f.state.claimedTokens).toHaveLength(0);
  });

  it('does not let a losing attempt delete or stamp over a newer attempt’s completed index', async () => {
    const f = fixture();
    const embed = jest.mocked(embedAndUpsert);
    embed.mockImplementation(async () => {
      // The newer attempt completed and owns the row before this one's provider
      // call returns an error.
      f.laterAttemptTakesOver();
      throw new Error('bedrock throttled');
    });

    await expect(f.service.indexAttachment('tenant', 'document-1')).rejects.toThrow(
      'bedrock throttled',
    );

    // Only the pre-embed purge of this attempt: no cleanup purge, and no failed
    // stamp overwriting the newer attempt's successful state.
    expect(f.state.purges).toBe(1);
    expect(f.updates.map((call) => call.data)).toEqual([{ indexedAt: null }]);
    expect(f.query.mock.calls.some(([sql]) => String(sql).includes('AS allowed'))).toBe(false);
  });

  it('fences an earlier attempt after an A→B→A source change and gives its claim back', async () => {
    const f = fixture();
    jest.mocked(embedAndUpsert).mockImplementation(async () => {
      // Same association and s3Key as claimed (A→B→A), so only the source epoch
      // can tell this attempt its work is stale.
      f.laterAttemptTakesOver(f.state.row.indexSourceGeneration + 2);
      throw new Error('provider unavailable');
    });

    await expect(f.service.indexAttachment('tenant', 'document-1')).rejects.toThrow(
      'provider unavailable',
    );

    expect(f.state.purges).toBe(1);
    expect(f.updates.map((call) => call.data)).toEqual([{ indexedAt: null }]);
    // The token owner hands its own claim back, so recovery does not wait out the
    // lease — and the filter means a newer attempt's token would never match.
    expect(f.yields).toHaveLength(1);
    expect((f.yields[0]!.where as { indexClaimToken: string }).indexClaimToken).toBe(
      f.state.claimedTokens[0],
    );
    expect(f.state.row.indexClaimToken).toBeNull();
  });

  it('records the failed outcome and releases the claim when the attempt still owns the row', async () => {
    const f = fixture();
    jest.mocked(embedAndUpsert).mockRejectedValue(new Error('bedrock throttled'));

    await expect(f.service.indexAttachment('tenant', 'document-1')).rejects.toThrow(
      'bedrock throttled',
    );

    expect(f.state.purges).toBe(2);
    expect(f.updates.at(-1)!.data).toEqual(
      expect.objectContaining({
        indexedAt: null,
        extractionStatus: 'failed',
        indexClaimToken: null,
        indexClaimExpiresAt: null,
        indexNextAttemptAt: expect.any(Date),
        extractionMetadata: expect.objectContaining({
          indexedChunks: 0,
          reason: 'index_write_failed',
        }),
      }),
    );
  });

  it('releases the claim and leaves nothing due after a completed index', async () => {
    const f = fixture();

    const outcome = await f.service.indexAttachment('tenant', 'document-1');

    expect(outcome).toBe('indexed');
    expect(f.updates.at(-1)!.data).toEqual(
      expect.objectContaining({
        indexedAt: expect.any(Date),
        extractionStatus: 'extracted',
        indexClaimToken: null,
        indexClaimExpiresAt: null,
        indexNextAttemptAt: null,
      }),
    );
  });
});
