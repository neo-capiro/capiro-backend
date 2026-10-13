import {
  clientId,
  runId,
  base,
  apiKey,
  now,
  fetchMock,
  detail,
  response,
  search,
  harness,
  expectProgress,
  installCharacterizationHooks,
} from '../../test/fixtures/client-profile-fill-regulatory-comments.js';

// Preserve the BEFORE test cases while retaining the service facade entry points.
describe('Regulatory comment discovery and detail-cache characterization', () => {
  installCharacterizationHooks();

  test('an exhausted shared budget retains prior progress without source work', async () => {
    const h = harness();
    const prior = {
      startedAt: 'original-start',
      examined: 9,
      candidates: 4,
      checkpoint: { nextPage: 3, offset: 2 },
    };
    expect(await h.gather(200, prior)).toEqual({
      count: 0,
      backfill: {
        status: 'in_progress',
        startedAt: 'original-start',
        completedAt: undefined,
        checkpoint: prior.checkpoint,
        historyStart: null,
        examined: 9,
        candidates: 4,
        lastError: null,
        limitation: null,
      },
    });
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
    expect(h.prisma.regulatoryComment.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('missing credentials report partial availability before tenant or HTTP work', async () => {
    delete process.env.REGULATIONS_GOV_API_KEY;
    const h = harness();
    const checkpoint = { nextPage: 2, offset: 3 };
    await expectProgress(h.gather(0, { checkpoint, examined: 5 }), 0, {
      status: 'partial',
      checkpoint,
      examined: 5,
      candidates: 0,
      lastError: 'REGULATIONS_GOV_API_KEY not configured',
    });
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('an absent client name completes without mapping, detail or HTTP reads', async () => {
    const h = harness(null);
    await expectProgress(h.gather(), 0, {
      status: 'complete',
      checkpoint: null,
      completedAt: now.toISOString(),
      historyStart: null,
    });
    expect(h.tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: clientId },
      select: { id: true, name: true },
    });
    expect(h.prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(h.tx.clientIntelMapping.findMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('search quotes the client phrase and binds saved pagination, sorting and timeout', async () => {
    const h = harness();
    search([], 0);
    await h.gather(0, { checkpoint: { nextPage: 4, offset: 2 } });
    const [url, options] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(base);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      api_key: apiKey,
      'filter[searchTerm]': '"Acme & Partners"',
      'page[size]': '10',
      'page[number]': '4',
      sort: '-postedDate',
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(h.tx.clientIntelMapping.findMany).toHaveBeenCalledWith({
      where: { clientId, source: 'regulatory_comment', confirmed: true },
      select: { externalId: true },
    });
  });
  test('confirmed IDs precede unconfirmed hits and share the scoped pending-finding pipeline', async () => {
    const h = harness(undefined, ['confirmed']);
    search(['unconfirmed', 'confirmed'], 2);
    await expectProgress(h.gather(), 2, { status: 'complete', examined: 1, candidates: 2 });
    expect(
      h.prisma.regulatoryComment.findUnique.mock.calls.map(([arg]) => arg.where.commentId),
    ).toEqual(['confirmed', 'unconfirmed']);
    const calls = h.writes();
    for (const [index, id] of ['confirmed', 'unconfirmed'].entries()) {
      const call = calls[index]!;
      const confidence = index === 0 ? 1 : 0.75;
      expect(call.slice(1, 9)).toEqual([
        runId,
        'tenant-1',
        clientId,
        'advocacy_record',
        `advocacy:regulatory-comment:${id}`,
        'advocacy_history',
        index === 0 ? 'fact' : 'recommendation',
        'null',
      ]);
      expect(JSON.parse(call[9] as string)).toEqual({
        externalKey: `regulatory-comment:${id}`,
        recordType: 'regulatory_comment',
        title: 'Public comment — Carl McNair on DOD-2026-1',
        summary: detail(id).commentText.slice(0, 500),
        activityDate: '2026-01-02T00:00:00.000Z',
        status: null,
        outcome: null,
        sourceType: 'regulatory_comment',
        sourceId: id,
        sourceUrl: `${base}/${id}`,
        evidenceClass: 'PUBLIC_VERIFIED',
        confidence,
        metadata: {
          commentId: id,
          docketId: 'DOD-2026-1',
          agencyId: 'DOD',
          organization: 'Acme & Partners',
          firstName: 'Carl',
          lastName: 'McNair',
          city: 'Arlington',
          stateProvince: 'VA',
          country: 'USA',
          clientMatch: {
            method: index === 0 ? 'confirmed_client_intel_mapping' : 'full_text_search',
            confidence,
          },
        },
      });
      expect(JSON.parse(call[10] as string)).toEqual([
        {
          label: 'Public comment — Carl McNair on DOD-2026-1',
          source: 'Regulations.gov public comment',
          metadata: { commentId: id, docketId: 'DOD-2026-1' },
        },
      ]);
      expect(call.slice(11, 13)).toEqual([confidence, 'pending']);
      expect(call[13]).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(
      h.tx.$queryRawUnsafe.mock.calls.every(
        (call) => call[1] === 'tenant-1' && call[2] === clientId,
      ),
    ).toBe(true);
    expect(calls[0]![0]).toContain('ON CONFLICT (run_id, content_hash) DO NOTHING');
  });
  test('budget counts actual inserts and the resume offset adds only processed unconfirmed hits', async () => {
    const h = harness(undefined, ['confirmed'], [1, 0, 1]);
    search(['ignored-before-offset', 'confirmed', 'duplicate', 'inserted', 'later'], 20);
    await expectProgress(
      h.gather(198, { checkpoint: { nextPage: 2, offset: 1 }, examined: 7, candidates: 3 }),
      2,
      {
        status: 'in_progress',
        checkpoint: { nextPage: 2, offset: 3 },
        examined: 9,
        candidates: 5,
      },
    );
    expect(
      h.prisma.regulatoryComment.findUnique.mock.calls.map(([arg]) => arg.where.commentId),
    ).toEqual(['confirmed', 'duplicate', 'inserted']);
    expect(h.writes()).toHaveLength(3);
  });
  test('accepted or rejected content is examined without writes or candidate increments', async () => {
    const h = harness();
    h.tx.$queryRawUnsafe.mockResolvedValue([{ id: 'terminal-finding' }]);
    search(['terminal'], 1);
    await expectProgress(h.gather(), 0, { status: 'complete', examined: 1, candidates: 0 });
    expect(h.tx.$queryRawUnsafe.mock.calls[0]![0]).toContain("status IN ('accepted', 'rejected')");
    expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  test.each([false, true])(
    'search failure retains confirmed discoveries (HTTP failure: %s)',
    async (httpFailure) => {
      const h = harness(undefined, ['confirmed']);
      if (httpFailure) fetchMock.mockResolvedValueOnce(response({}, 503));
      else fetchMock.mockRejectedValueOnce(new Error('search unavailable'));
      await expectProgress(
        h.gather(0, { checkpoint: { nextPage: 3, offset: 2 }, examined: 8, candidates: 5 }),
        1,
        {
          status: 'partial',
          checkpoint: { nextPage: 4, offset: 0 },
          examined: 8,
          candidates: 6,
          lastError: httpFailure
            ? 'Regulations.gov comments search HTTP 503'
            : 'search unavailable',
        },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1); // Confirmations do not skip search.
      expect(h.writes()).toHaveLength(1);
    },
  );
  test('failed search without confirmations retains the prior checkpoint and skips details', async () => {
    const h = harness();
    fetchMock.mockRejectedValueOnce(new Error('search unavailable'));
    await expectProgress(h.gather(0, { checkpoint: { nextPage: 2, offset: 1 } }), 0, {
      status: 'partial',
      checkpoint: { nextPage: 2, offset: 1 },
      lastError: 'search unavailable',
    });
    expect(h.prisma.regulatoryComment.findUnique).not.toHaveBeenCalled();
  });
  test('failed details count as examined and advance the page despite partial availability', async () => {
    const h = harness();
    h.prisma.regulatoryComment.findUnique.mockResolvedValue(null as never);
    search(['missing'], 1);
    fetchMock.mockResolvedValueOnce(response({}, 404));
    await expectProgress(
      h.gather(0, {
        startedAt: 'original',
        examined: '4',
        candidates: '2',
        historyStart: 'old-history',
      }),
      0,
      {
        status: 'partial',
        startedAt: 'original',
        checkpoint: { nextPage: 2, offset: 0 },
        historyStart: null,
        examined: 5,
        candidates: 2,
        lastError: '1 comment detail request(s) unavailable',
      },
    );
  });
  test.each([
    [1, undefined, 'in_progress', { nextPage: 2, offset: 0 }, null],
    [25, 251, 'partial', null, 'Exact-phrase search capped at 250 of 251 results'],
    [25, 250, 'complete', null, null],
    [25, undefined, 'in_progress', null, null],
  ])(
    'full page %s with total %s keeps existing ceiling semantics',
    async (page, total, status, checkpoint, limitation) => {
      const h = harness();
      search(
        Array.from({ length: 10 }, (_, i) => `id-${i}`),
        total,
      );
      await expectProgress(
        h.gather(0, { checkpoint: { nextPage: page, offset: 0 }, examined: 20 }),
        10,
        {
          status,
          checkpoint,
          limitation,
          examined: 30,
          candidates: 10,
        },
      );
    },
  );
  test('a short successful page completes and retains accumulated counts and start identity', async () => {
    const h = harness();
    search(['one'], 30);
    await expectProgress(h.gather(0, { startedAt: 'original', examined: 12, candidates: 4 }), 1, {
      status: 'complete',
      completedAt: now.toISOString(),
      startedAt: 'original',
      checkpoint: null,
      examined: 13,
      candidates: 5,
    });
  });
  test('source warnings redact credential-shaped errors and retain the current length clamp', async () => {
    const h = harness();
    fetchMock.mockRejectedValueOnce(new Error(`api_key=secret-value ${'x'.repeat(900)}`));
    const result = await h.gather();
    expect(result.backfill.lastError).toHaveLength(800);
    expect(result.backfill.lastError).toMatch(/^api_key=\[redacted\]/);
    expect(h.warning.mock.calls[0]![0]).not.toContain('secret-value');
  });
});
