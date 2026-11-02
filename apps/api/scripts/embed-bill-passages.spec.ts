/** Failure-boundary checks: the provider is mocked, the cursor/lease ordering is real worker code. */
describe('bill passage worker recovery', () => {
  const oldArgs = process.argv;
  const oldUrl = process.env.DATABASE_URL;
  const oldHost = process.env.DB_HOST;
  afterEach(() => {
    process.argv = oldArgs;
    process.env.DATABASE_URL = oldUrl;
    process.env.DB_HOST = oldHost;
    jest.restoreAllMocks();
  });
  async function setup(
    options: {
      dry?: boolean;
      leasedElsewhere?: boolean;
      providerFailure?: boolean;
      loseLease?: boolean;
      cursor?: { id: string; chunk: number };
      source?: 'federal' | 'state';
      initializationFailure?: boolean;
      phase?: 'extract' | 'embed';
      incomplete?: boolean;
      states?: string;
    } = {},
  ) {
    jest.resetModules();
    process.argv = [
      'node',
      'embed-bill-passages',
      '--source',
      options.source ?? 'federal',
      '--phase',
      options.phase ?? 'embed',
      '--limit',
      '1',
      ...(options.dry ? [] : ['--commit', '--expected-host', 'preview']),
      ...(options.states ? ['--states', options.states] : []),
    ];
    process.env.DATABASE_URL = 'postgresql://fixture:unused@preview/bill_test';
    process.env.DB_HOST = 'preview';
    let durable = options.cursor ?? { id: '', chunk: -1 };
    const events: string[] = [];
    const doc = {
      id: 'abc',
      billId: '119-hr-1',
      sourceUrl: 'https://www.govinfo.gov/test',
      version: 'ih',
      hash: 'source-hash',
      documentHash: 'original-byte-hash',
      versionId: 'text:7',
      providerDocumentId: '7',
      state: options.source === 'state' ? 'CA' : undefined,
      evidence: {
        sections: [
          {
            locator: 'document#0',
            extractionId: 'extraction-abc',
            offsetBasis: 'structured_document_text',
            text: 'The full state legislative provision.',
          },
        ],
      },
      text: 'The complete legislative text. '.repeat(400),
    };
    const db: any = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
        if (sql.startsWith('INSERT INTO federal_evidence_checkpoint'))
          return options.leasedElsewhere ? [] : [{ cursor: durable }];
        if (
          sql.includes('FROM federal_evidence_revision') ||
          sql.includes('FROM state_bill_published_record')
        )
          return String(args[0]) <= 'abc' ? [doc] : [];
        if (sql.includes('FOR UPDATE')) return options.loseLease ? [] : [{ ok: 1 }];
        throw Error('UNEXPECTED_TEST_QUERY');
      }),
      $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
        if (sql.includes('SET cursor_jsonb')) {
          durable = JSON.parse(String(args[2]));
          events.push('checkpoint:' + durable.chunk);
        }
        if (sql.includes('SET metadata_jsonb')) events.push('metadata');
        return 1;
      }),
      $transaction: jest.fn(async (fn: (tx: any) => unknown) => fn(db)),
      $disconnect: jest.fn(async () => {}),
    };
    const embed = jest.fn(async (_db: any, args: any) => {
      events.push('provider');
      if (options.providerFailure) throw Error('PROVIDER_FAILURE');
      if (!(await args.beforeWrite(db))) return 'skipped';
      events.push('vector');
      return 'inserted';
    });
    const construct = jest.fn(() => db);
    jest.doMock('@prisma/client', () => ({ PrismaClient: construct }));
    jest.doMock('../src/ingestion/bill-passage-embedding.js', () => ({ embedBillPassage: embed }));
    const { structureText } = await import('../src/ingestion/bill-document-structure');
    const extract = jest.fn(async () => ({
      id: 'extraction-abc',
      completeness: options.incomplete ? 'failed' : 'complete',
      structure: structureText(
        options.incomplete
          ? ''
          : options.source === 'state'
            ? 'The full state legislative provision.'
            : doc.text,
      ),
    }));
    jest.doMock('../src/ingestion/bill-text-extraction.js', () => ({
      ensureBillTextExtraction: extract,
    }));
    const provider = jest.fn(() => {
      if (options.initializationFailure) throw Error('PROVIDER_INITIALIZATION_FAILED');
      return { metadata: { model: 'test' } };
    });
    jest.doMock('../src/embeddings/embedding-provider.factory.js', () => ({
      getDefaultEmbeddingProvider: provider,
    }));
    jest.doMock('../src/ingestion/sync-run.helper.js', () => ({
      runWithSyncRun: async (_db: any, _source: string, fn: () => unknown) => fn(),
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { main } = await import('./embed-bill-passages');
    return { main, db, embed, extract, construct, provider, events, durable: () => durable };
  }
  it('imports without allocating Prisma or requiring CLI configuration', async () => {
    const h = await setup();
    expect(h.construct).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
  });
  it.each(['extract', 'embed'] as const)(
    'uses a distinct Florida %s cursor and parameterized filter',
    async (phase) => {
      const h = await setup({ source: 'state', phase, states: 'FL' });
      await h.main();
      const checkpoint = h.db.$queryRawUnsafe.mock.calls.find((a: any[]) =>
        a[0].startsWith('INSERT INTO federal_evidence_checkpoint'),
      );
      expect(checkpoint[1]).toMatch(/:states:FL$/);
      const query = h.db.$queryRawUnsafe.mock.calls.find((a: any[]) =>
        a[0].includes('FROM state_bill_published_record'),
      );
      expect(query[0]).toContain('b.state=ANY($2::text[])');
      expect(query[2]).toEqual(['FL']);
    },
  );
  it('rejects missing database configuration before resource allocation', async () => {
    const h = await setup({ dry: true });
    delete process.env.DATABASE_URL;
    await expect(h.main()).rejects.toThrow('DATABASE_URL_REQUIRED');
    expect(h.construct).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
  });
  it('cleans up Prisma when provider initialization fails', async () => {
    const h = await setup({ initializationFailure: true });
    await expect(h.main()).rejects.toThrow('PROVIDER_INITIALIZATION_FAILED');
    expect(h.db.$disconnect).toHaveBeenCalledTimes(1);
    expect(h.db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('keeps state revision, original byte hash and section citation with the vector', async () => {
    const h = await setup({ source: 'state' });
    await h.main();
    expect(h.embed.mock.calls[0]![1].sourceType).toBe('state_bill_passage');
    const update = h.db.$executeRawUnsafe.mock.calls.find((a: any[]) =>
      a[0].includes('SET metadata_jsonb'),
    );
    expect(JSON.parse(update[4])).toMatchObject({
      revisionId: 'abc',
      versionId: 'text:7',
      providerDocumentId: '7',
      documentHash: 'original-byte-hash',
      revisionHash: 'source-hash',
      jurisdiction: 'CA',
      locator: 'document#0',
      extractionId: 'extraction-abc',
      offsetBasis: 'structured_document_text',
      startOffset: 0,
      endOffset: 'The full state legislative provision.'.length,
      offsetUnit: 'UTF-16',
    });
  });
  it('dry run calls neither provider nor database writes', async () => {
    const h = await setup({ dry: true });
    await h.main();
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('does not run when another writer owns the lease', async () => {
    const h = await setup({ leasedElsewhere: true });
    await expect(h.main()).rejects.toThrow('BILL_TEXT_LEASE_NOT_ACQUIRED');
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('saves the chunk only after both vector and citation metadata persist', async () => {
    const h = await setup();
    await h.main();
    expect(h.events).toEqual(['checkpoint:-1', 'provider', 'vector', 'metadata', 'checkpoint:0']);
    expect(h.durable()).toEqual({ id: 'abc', chunk: 0, extractionId: 'extraction-abc' });
  });
  it('resumes at the next chunk of the exact immutable revision', async () => {
    const h = await setup({ cursor: { id: 'abc', chunk: 0 } });
    await h.main();
    expect(h.embed.mock.calls[0]![1].sourceId).toMatch(/:extraction-abc:1$/);
    expect(h.durable().chunk).toBe(1);
  });
  it('does not advance past a provider failure and always disconnects', async () => {
    const h = await setup({ providerFailure: true });
    await expect(h.main()).rejects.toThrow('PROVIDER_FAILURE');
    expect(h.durable()).toEqual({ id: '', chunk: -1 });
    expect(h.db.$disconnect).toHaveBeenCalled();
  });
  it('extracts with a distinct durable phase and no provider initialization', async () => {
    const h = await setup({ phase: 'extract' });
    await h.main();
    expect(h.provider).not.toHaveBeenCalled();
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.extract).toHaveBeenCalledTimes(1);
    expect(h.durable()).toEqual({ id: 'abc~', chunk: -1 });
    expect(h.db.$queryRawUnsafe.mock.calls[0][1]).toContain(':extract:');
  });
  it('advances failed extraction attempts so subsequent versions are not starved', async () => {
    const h = await setup({ phase: 'extract', incomplete: true });
    await h.main();
    expect(h.durable()).toEqual({ id: 'abc~', chunk: -1 });
    expect(h.embed).not.toHaveBeenCalled();
  });
  it('cannot advance or attach metadata after losing its lease', async () => {
    const h = await setup({ loseLease: true });
    await expect(h.main()).rejects.toThrow('BILL_TEXT_LEASE_LOST');
    expect(h.events).not.toContain('metadata');
    expect(h.durable()).toEqual({ id: '', chunk: -1 });
  });
});
