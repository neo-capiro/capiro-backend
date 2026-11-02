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
      reuseVector?: boolean;
      limit?: number;
      text?: string;
      datasetBusy?: boolean;
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
      String(options.limit ?? 1),
      ...(options.dry ? [] : ['--commit', '--expected-host', 'preview']),
      ...(options.states ? ['--states', options.states] : []),
    ];
    process.env.DATABASE_URL = 'postgresql://fixture:unused@preview/bill_test';
    process.env.DB_HOST = 'preview';
    let durable = options.cursor ?? { id: '', chunk: -1 };
    const events: string[] = [];
    let datasetLost = false;
    const vectorMetadata = new Map<string, Record<string, unknown>>([
      ['historical-v1:0', { extractionVersion: 'bill-structure-v1' }],
    ]);
    const proofs = new Map<
      string,
      import('../src/ingestion/bill-passage-embedding.js').ProvenBillPassage
    >();
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
    const documents = [doc];
    const { structureText } = await import('../src/ingestion/bill-document-structure.js');
    const { passages, sha256 } = await import('../src/ingestion/bill-text-passages.js');
    const structure = structureText(
      options.text ??
        (options.incomplete
          ? ''
          : options.source === 'state'
            ? 'The full state legislative provision.'
            : doc.text),
    );
    const chunks = passages(structure.sections);
    const db: any = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
        if (sql.startsWith('INSERT INTO federal_evidence_checkpoint')) {
          if (String(args[0]).startsWith('bill-text:'))
            return options.leasedElsewhere ? [] : [{ cursor: durable }];
          return options.datasetBusy ? [] : [{ source: args[0] }];
        }
        if (sql.includes('SELECT source FROM federal_evidence_checkpoint'))
          return datasetLost ? [] : (args[0] as string[]).map((source) => ({ source }));
        if (
          sql.includes('FROM federal_evidence_revision') ||
          sql.includes('FROM state_bill_published_record')
        )
          return documents
            .filter((item) => item.id >= String(args[0]))
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, 10);
        if (sql.includes('FROM bill_text_extraction e JOIN bill_text_passage'))
          return [...proofs.entries()]
            .filter(([id]) => id.includes(`:${args[0]}:`))
            .map(([, proof]) => proof);
        if (sql.includes('FOR UPDATE')) return options.loseLease ? [] : [{ ok: 1 }];
        throw Error('UNEXPECTED_TEST_QUERY');
      }),
      $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
        if (options.reuseVector && sql.startsWith('INSERT INTO context_embeddings')) {
          vectorMetadata.set(String(args[1]), {});
          events.push('reused-vector');
        }
        if (sql.includes('SET cursor_jsonb')) {
          durable = JSON.parse(String(args[2]));
          events.push('checkpoint:' + durable.chunk);
        }
        if (sql.includes('SET metadata_jsonb')) {
          events.push('metadata');
          const metadata = JSON.parse(String(args[3]));
          vectorMetadata.set(String(args[1]), metadata);
          const chunk = chunks[Number(String(args[1]).split(':').at(-1))]!;
          proofs.set(String(args[1]), {
            ordinal: chunk.ordinal,
            start: chunk.start,
            end: chunk.end,
            contentHash: sha256(chunk.text),
            metadata,
          });
        }
        return 1;
      }),
      $transaction: jest.fn(async (fn: (tx: any) => unknown) => fn(db)),
      $disconnect: jest.fn(async () => {}),
    };
    const embed = jest.fn(async (_db: any, args: any, embeddingProvider: any) => {
      if (options.reuseVector) {
        const actual = jest.requireActual<
          typeof import('../src/ingestion/bill-passage-embedding.js')
        >('../src/ingestion/bill-passage-embedding.js');
        return actual.embedBillPassage(_db, args, embeddingProvider);
      }
      events.push('provider');
      if (options.providerFailure) throw Error('PROVIDER_FAILURE');
      if (!(await args.beforeWrite(db))) return 'skipped';
      events.push('vector');
      return 'inserted';
    });
    const construct = jest.fn(() => db);
    jest.doMock('@prisma/client', () => ({ PrismaClient: construct }));
    jest.doMock('../src/ingestion/bill-passage-embedding.js', () => ({
      ...jest.requireActual<typeof import('../src/ingestion/bill-passage-embedding.js')>(
        '../src/ingestion/bill-passage-embedding.js',
      ),
      embedBillPassage: embed,
    }));
    const extract = jest.fn(async (_db: unknown, input: { revisionId: string }) => ({
      id: 'extraction-' + input.revisionId,
      completeness: options.incomplete ? 'failed' : 'complete',
      structure,
    }));
    jest.doMock('../src/ingestion/bill-text-extraction.js', () => ({
      ensureBillTextExtraction: extract,
    }));
    const providerEmbed = jest.fn(async () => {
      throw Error('UNEXPECTED_PROVIDER_INVOCATION');
    });
    const provider = jest.fn(() => {
      if (options.initializationFailure) throw Error('PROVIDER_INITIALIZATION_FAILED');
      return { metadata: { model: 'test', dimensions: 1024 }, embed: providerEmbed };
    });
    jest.doMock('../src/embeddings/embedding-provider.factory.js', () => ({
      getDefaultEmbeddingProvider: provider,
    }));
    jest.doMock('../src/ingestion/sync-run.helper.js', () => ({
      runWithSyncRun: async (_db: any, _source: string, fn: () => unknown) => fn(),
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { main } = await import('./embed-bill-passages.js');
    return {
      main,
      db,
      embed,
      extract,
      construct,
      provider,
      providerEmbed,
      vectorMetadata,
      events,
      proofs,
      chunks,
      documents,
      setCursor: (next: { id: string; chunk: number }) => {
        durable = next;
      },
      loseDatasetLease: () => {
        datasetLost = true;
      },
      durable: () => durable,
    };
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
      const checkpoint = h.db.$queryRawUnsafe.mock.calls.find(
        (a: any[]) =>
          a[0].startsWith('INSERT INTO federal_evidence_checkpoint') &&
          String(a[1]).startsWith('bill-text:'),
      );
      expect(checkpoint[1]).toMatch(/:states:FL$/);
      expect(checkpoint[1]).toContain(`:${phase}:bill-structure-v2:`);
      if (phase === 'embed')
        expect(checkpoint[1]).toMatch(/:bill-structure-v2:[0-9a-f]{12}:bill-structured-utf16-v2:/);
      const query = h.db.$queryRawUnsafe.mock.calls.find((a: any[]) =>
        a[0].includes('FROM state_bill_published_record'),
      );
      expect(query[0]).toContain('b.state=ANY($2::text[])');
      expect(query[2]).toEqual(['FL']);
      const acquisitions = h.db.$queryRawUnsafe.mock.calls
        .filter((call: unknown[]) =>
          String(call[0]).startsWith('INSERT INTO federal_evidence_checkpoint'),
        )
        .map((call: unknown[]) => call[1]);
      expect(acquisitions).toEqual(['state-bills:FL', checkpoint[1]]);
    },
  );
  it.each(['extract', 'embed'] as const)(
    'holds all states for the global %s writer',
    async (phase) => {
      const h = await setup({ source: 'state', phase });
      await h.main();
      const { ALL_US_STATE_CODES } = await import('../src/external/legiscan/us-states.js');
      const acquisitions = h.db.$queryRawUnsafe.mock.calls
        .filter((call: unknown[]) =>
          String(call[0]).startsWith('INSERT INTO federal_evidence_checkpoint'),
        )
        .map((call: unknown[]) => String(call[1]));
      expect(acquisitions.slice(0, -1)).toEqual(
        ALL_US_STATE_CODES.map((state) => 'state-bills:' + state).sort(),
      );
      expect(acquisitions).toHaveLength(52);
      expect(acquisitions.at(-1)).toContain(`bill-text:fy26:state:${phase}:`);
    },
  );
  it.each(['extract', 'embed'] as const)(
    'shares the federal dataset owner for %s',
    async (phase) => {
      const h = await setup({ phase });
      await h.main();
      const acquisitions = h.db.$queryRawUnsafe.mock.calls
        .filter((call: unknown[]) =>
          String(call[0]).startsWith('INSERT INTO federal_evidence_checkpoint'),
        )
        .map((call: unknown[]) => String(call[1]));
      expect(acquisitions).toHaveLength(2);
      expect(acquisitions[0]).toBe('congress-bills');
      expect(acquisitions[1]).toContain(`bill-text:fy26:federal:${phase}:`);
    },
  );
  it.each(['federal', 'state'] as const)(
    'refuses a busy %s dataset before extraction or progress acquisition',
    async (source) => {
      const h = await setup({ source, datasetBusy: true });
      await expect(h.main()).rejects.toThrow(
        `${source === 'state' ? 'STATE' : 'FEDERAL'}_WRITER_ALREADY_RUNNING`,
      );
      expect(h.extract).not.toHaveBeenCalled();
      expect(h.embed).not.toHaveBeenCalled();
      expect(
        h.db.$queryRawUnsafe.mock.calls.some((call: unknown[]) =>
          String(call[1]).startsWith('bill-text:'),
        ),
      ).toBe(false);
      expect(h.db.$executeRawUnsafe).not.toHaveBeenCalled();
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
      extractionVersion: 'bill-structure-v2',
      offsetBasis: 'structured_document_text',
      startOffset: 0,
      endOffset: 'The full state legislative provision.'.length,
      offsetUnit: 'UTF-16',
    });
  });
  it('stamps the current extraction generation after exact-vector reuse without altering the old source metadata', async () => {
    const h = await setup({ source: 'state', reuseVector: true });
    await h.main();
    expect(h.providerEmbed).not.toHaveBeenCalled();
    expect(h.events).toEqual(['checkpoint:-1', 'reused-vector', 'metadata', 'checkpoint:0']);
    const copy = h.db.$executeRawUnsafe.mock.calls.find((call: unknown[]) =>
      String(call[0]).startsWith('INSERT INTO context_embeddings'),
    );
    expect(copy[0]).toContain('AND model=$3 AND content_hash=$4 AND content_text=$5');
    expect(copy[0]).not.toContain('extractionVersion');
    expect(copy[0]).not.toContain('metadata_jsonb');
    expect(h.vectorMetadata.get('historical-v1:0')).toEqual({
      extractionVersion: 'bill-structure-v1',
    });
    expect(h.vectorMetadata.get('bill-structured-utf16-v2:extraction-abc:0')).toMatchObject({
      extractionVersion: 'bill-structure-v2',
      extractionId: 'extraction-abc',
      revisionId: 'abc',
    });
  });
  it('dry run calls neither provider nor database writes', async () => {
    const h = await setup({ dry: true, datasetBusy: true });
    await h.main();
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(
      h.db.$queryRawUnsafe.mock.calls.some((call: unknown[]) =>
        String(call[0]).startsWith('INSERT'),
      ),
    ).toBe(false);
  });
  it('fences metadata and progress when the dataset owner expires during the provider request', async () => {
    const h = await setup({ source: 'state', states: 'FL' });
    h.embed.mockImplementationOnce(async () => {
      h.loseDatasetLease();
      return 'inserted';
    });
    await expect(h.main()).rejects.toThrow('STATE_WRITER_LEASE_LOST');
    expect(h.events).toEqual(['checkpoint:-1']);
    expect(h.durable()).toEqual({ id: '', chunk: -1 });
    const releases = h.db.$executeRawUnsafe.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('SET lease_token=NULL'),
    );
    expect(releases).toHaveLength(2);
    expect(String(releases[0][1])).toContain('bill-text:');
    expect(releases[1][1]).toEqual(['state-bills:FL']);
  });
  it('does not run when another writer owns the lease', async () => {
    const h = await setup({ leasedElsewhere: true });
    await expect(h.main()).rejects.toThrow('BILL_TEXT_LEASE_NOT_ACQUIRED');
    expect(h.embed).not.toHaveBeenCalled();
    expect(
      h.db.$executeRawUnsafe.mock.calls.some((call: unknown[]) =>
        /SET cursor_jsonb|SET metadata_jsonb/.test(String(call[0])),
      ),
    ).toBe(false);
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
  it('skips a fully proven document with one document checkpoint and no per-passage writes', async () => {
    const h = await setup({ limit: 1000 });
    await h.main();
    expect(h.proofs.size).toBe(h.chunks.length);
    h.events.length = 0;
    h.embed.mockClear();
    h.db.$executeRawUnsafe.mockClear();
    await h.main();
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.events).toEqual(['checkpoint:-1', 'checkpoint:-1']); // document successor, then wrap
    expect(
      h.db.$executeRawUnsafe.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes('SET metadata_jsonb'),
      ),
    ).toBe(false);
    expect(h.durable()).toEqual({ id: '', chunk: -1 });
    const summary = (console.log as jest.Mock).mock.calls.map(([text]) => JSON.parse(text)).at(-1);
    expect(summary).toMatchObject({
      processed: 0,
      skipped: h.chunks.length,
      scanned: 1,
      complete: true,
    });
  });
  it('spends cap one on the missing passage after proven passages in the same long document', async () => {
    const h = await setup({ limit: 1000 });
    await h.main();
    h.proofs.delete('bill-structured-utf16-v2:extraction-abc:2');
    h.embed.mockClear();
    const args = process.argv.slice(2);
    args[args.indexOf('--limit') + 1] = '1';
    await h.main(args);
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.embed.mock.calls[0]![1].sourceId).toBe('bill-structured-utf16-v2:extraction-abc:2');
    expect(h.durable()).toEqual({ id: 'abc', chunk: 2, extractionId: 'extraction-abc' });
  });
  it.each([
    'contentHash',
    'start',
    'end',
    'metadataOffset',
    'generation',
    'citation',
    'extraMetadata',
  ])('does not skip a passage with stale %s proof or citation metadata', async (field) => {
    const h = await setup({ source: 'state', limit: 1000 });
    await h.main();
    const proof = h.proofs.get('bill-structured-utf16-v2:extraction-abc:0')!;
    const metadata = proof.metadata as Record<string, unknown>;
    if (field === 'contentHash') proof.contentHash = 'wrong';
    else if (field === 'start') proof.start++;
    else if (field === 'end') proof.end++;
    else if (field === 'metadataOffset') metadata.startOffset = 999;
    else if (field === 'generation') metadata.extractionVersion = 'bill-structure-v1';
    else if (field === 'citation') delete metadata.sourceUrl;
    else metadata.unexpected = 'stale';
    h.embed.mockClear();
    await h.main();
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.proofs.get('bill-structured-utf16-v2:extraction-abc:0')!.metadata).toMatchObject({
      startOffset: 0,
      extractionVersion: 'bill-structure-v2',
      sourceUrl: 'https://www.govinfo.gov/test',
    });
  });
  it('discovers a newly retained lower key after the existing end-of-pass reset', async () => {
    const h = await setup({ source: 'state', limit: 1000 });
    await h.main();
    h.setCursor({ id: 'abc~', chunk: -1 });
    h.documents.push({ ...h.documents[0]!, id: 'aaa' });
    h.embed.mockClear();
    await h.main(); // finish the in-flight pass, preserving its reset semantics
    expect(h.durable()).toEqual({ id: '', chunk: -1 });
    expect(h.embed).not.toHaveBeenCalled();
    await h.main();
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.embed.mock.calls[0]![1].sourceId).toBe('bill-structured-utf16-v2:extraction-aaa:0');
  });
  it('keeps the document scan cap when every selected document is already proven', async () => {
    const h = await setup({ source: 'state', limit: 1000 });
    h.documents.splice(
      0,
      1,
      ...Array.from({ length: 11 }, (_, index) => ({
        ...h.documents[0]!,
        id: 'doc' + String(index).padStart(2, '0'),
      })),
    );
    await h.main();
    h.embed.mockClear();
    const args = process.argv.slice(2);
    args[args.indexOf('--limit') + 1] = '1';
    await h.main(args);
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.durable()).toEqual({ id: 'doc09~', chunk: -1 });
    const summary = (console.log as jest.Mock).mock.calls.map(([text]) => JSON.parse(text)).at(-1);
    expect(summary).toMatchObject({ processed: 0, scanned: 10, complete: false });
  });
  it('keeps lexical-only short sections without consuming embedding capacity or stalling', async () => {
    const h = await setup({ text: 'Short', limit: 1 });
    await h.main();
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.durable()).toEqual({ id: '', chunk: -1 });
    const summary = (console.log as jest.Mock).mock.calls.map(([text]) => JSON.parse(text)).at(-1);
    expect(summary).toMatchObject({ processed: 0, scanned: 1, skipped: 1, complete: true });
  });
  it('cannot advance a proven-only document after losing its lease', async () => {
    const h = await setup({ source: 'state', limit: 1000 });
    await h.main();
    h.embed.mockClear();
    h.db.$executeRawUnsafe.mockImplementation(async (sql: string) =>
      sql.includes('SET cursor_jsonb') ? 0 : 1,
    );
    await expect(h.main()).rejects.toThrow('BILL_TEXT_LEASE_LOST');
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.durable()).toEqual({ id: '', chunk: -1 });
  });
  it('retains the last proven frontier when the next missing passage fails', async () => {
    const h = await setup({ limit: 1000 });
    await h.main();
    h.proofs.delete('bill-structured-utf16-v2:extraction-abc:2');
    h.embed.mockRejectedValueOnce(Error('PROVIDER_FAILURE'));
    await expect(h.main()).rejects.toThrow('PROVIDER_FAILURE');
    expect(h.durable()).toEqual({ id: '', chunk: -1 });
    await h.main();
    expect(h.proofs.has('bill-structured-utf16-v2:extraction-abc:2')).toBe(true);
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
    expect(
      h.db.$queryRawUnsafe.mock.calls.some((call: unknown[]) =>
        String(call[1]).includes(':extract:'),
      ),
    ).toBe(true);
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
