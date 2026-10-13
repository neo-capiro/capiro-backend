import {
  clientId,
  communityRow,
  ctx,
  harness,
  installHooks,
  runId,
} from '../../test/fixtures/client-profile-fill-advocacy-history.js';

installHooks();
const oldAt = '2025-01-01T00:00:00.000Z';
const scanAt = new Date('2026-01-02T00:00:00.000Z');
const prior = {
  startedAt: oldAt,
  historyStart: oldAt,
  examined: 7,
  candidates: 3,
  checkpoint: { createdAt: oldAt, key: 'prior-key' },
};

describe('Community funding discovery — evidence, ledger and failure state', () => {
  test('provenance stays ordered metadata, uses the first available URL and caps URL evidence at five', async () => {
    const provenance = Array.from({ length: 8 }, (_, index) => ({
      requestId: 'request',
      sourceDocumentId: `doc-${index}`,
      sourcePage: index || null,
      sourceRow: index,
      sourceUrl: index ? `https://example.test/${index}` : null,
      title: index === 2 ? null : `Document ${index}`,
    }));
    const h = harness({
      globalRows: {
        communityScan: [communityRow({ id: 'request' })],
        communityProvenance: provenance,
      },
    });
    expect(await h.community({})).toMatchObject({ count: 1 });
    const finding = h.captures.findings[0]!;
    expect(finding.proposedValue).toMatchObject({
      sourceUrl: 'https://example.test/1',
      metadata: {
        provenanceCount: 8,
        provenance: provenance.map(({ requestId: _id, ...item }) => item),
      },
    });
    expect(finding.evidence).toHaveLength(6);
    expect(finding.evidence.slice(1).map((item) => item.url)).toEqual(
      [1, 2, 3, 4, 5].map((index) => `https://example.test/${index}`),
    );
    expect(finding.evidence[2]!.label).toBe('Source row 2');
    const query = h.captures.global.find((call) => call.rail === 'communityProvenance')!;
    expect(query.args).toEqual([['request']]);
    expect(query.sql).toContain('ORDER BY s.request_id, s.source_page NULLS FIRST, s.source_row');
  });

  test('unavailable provenance remains silent and preserves the canonical count without multiplying findings', async () => {
    const h = harness({
      globalRows: { communityScan: [communityRow({ id: 'request', provenanceCount: 7 })] },
      railErrors: { communityProvenance: new Error('provenance offline') },
    });
    expect(await h.community({})).toMatchObject({
      count: 1,
      backfill: { status: 'complete', lastError: null },
    });
    expect(h.captures.findings[0]).toMatchObject({
      proposedValue: { sourceUrl: null, metadata: { provenanceCount: 7, provenance: [] } },
    });
    expect(h.captures.findings[0]!.evidence).toHaveLength(1);
    expect(h.captures.warnings).toEqual([]);
  });
});

describe('Community funding discovery — shared finding ledger', () => {
  test('candidate counts reflect successful inserts while real ledger hashes retire earlier pending rows', async () => {
    const h = harness({
      globalRows: {
        communityScan: [communityRow({ id: 'duplicate' }), communityRow({ id: 'fresh' })],
      },
      insertResults: [false, true],
    });
    expect(await h.community({})).toMatchObject({
      count: 1,
      backfill: { candidates: 1, examined: 2 },
    });
    expect(h.captures.findings).toHaveLength(2);
    expect(h.captures.findings.every((finding) => /^[a-f0-9]{64}$/.test(finding.contentHash))).toBe(
      true,
    );
    const retires = h.captures.tenant.filter((call) => call.rail === 'retire');
    expect(retires).toHaveLength(2);
    expect(retires[0]!.args).toEqual([
      ctx.tenantId,
      clientId,
      h.captures.findings[0]!.contentHash,
      runId,
    ]);
    expect(retires[0]!.sql).toContain("run_id <> $4::uuid AND status = 'pending'");
  });

  test('an accepted or rejected hash prevents retirement and insertion without reducing examined coverage', async () => {
    const h = harness({
      globalRows: { communityScan: [communityRow({ id: 'terminal' })] },
      terminalResults: [true],
    });
    expect(await h.community({})).toMatchObject({
      count: 0,
      backfill: { examined: 1, candidates: 0 },
    });
    expect(h.captures.findings).toEqual([]);
    expect(h.captures.tenant.some((call) => call.rail === 'retire')).toBe(false);
    expect(h.captures.tenant.find((call) => call.rail === 'terminal')!.sql).toContain(
      "status IN ('accepted', 'rejected')",
    );
  });
});

describe('Community funding discovery — partial rail failure', () => {
  test('a confirmed rail failure after a committed finding preserves its count and records partial scan progress', async () => {
    const h = harness({
      confirmedKeys: { community_funding: ['first', 'second'] },
      globalRows: {
        communityConfirmed: [communityRow({ id: 'first' }), communityRow({ id: 'second' })],
        communityScan: [
          communityRow({
            id: 'unmatched',
            createdAt: scanAt,
            recipientNormalized: 'other',
            recipientName: 'Other',
            recipientSimilarity: 0,
          }),
        ],
      },
      insertResults: [true, new Error('insert failed')],
    });
    expect(await h.community({ priorState: prior })).toMatchObject({
      count: 1,
      newestCreatedAt: null,
      newestKey: null,
      backfill: {
        status: 'partial',
        examined: 10,
        candidates: 4,
        lastError: 'insert failed',
        checkpoint: { createdAt: scanAt.toISOString(), key: 'unmatched' },
      },
    });
    expect(h.captures.warnings[0]).toContain('confirmed-mapping rail unavailable: insert failed');
    expect(h.captures.findings).toHaveLength(2);
  });

  test('scan failure retains previously inserted confirmed findings and the prior frontier and published watermarks', async () => {
    const h = harness({
      confirmedKeys: { community_funding: ['confirmed'] },
      globalRows: { communityConfirmed: [communityRow({ id: 'confirmed' })] },
      railErrors: { communityScan: new Error('scan offline') },
    });
    expect(
      await h.community({ lastCreatedAt: oldAt, lastKey: 'published-key', priorState: prior }),
    ).toMatchObject({
      count: 1,
      newestCreatedAt: oldAt,
      newestKey: 'published-key',
      backfill: {
        status: 'partial',
        examined: 8,
        candidates: 4,
        checkpoint: prior.checkpoint,
        lastError: 'scan offline',
        limitation: 'Canonical CPF/CDS table unavailable or not yet migrated',
      },
    });
    expect(h.captures.warnings[0]).toContain('scan rail unavailable: scan offline');
    expect(h.captures.global.some((call) => call.rail === 'communityCoverage')).toBe(false);
  });
});

describe('Community funding discovery — canonical coverage honesty', () => {
  test.each([
    {
      coverage: [],
      error: undefined,
      expected:
        'Canonical community_funding_request table is empty — run CPF/CDS ingestion before expecting matches.',
    },
    {
      coverage: [{ chamber: 'house', fiscalYear: 2026, n: 12 }],
      error: undefined,
      expected:
        'Canonical coverage present for house FY2026:12. Match is recipient-primary; requester is never treated as the client.',
    },
    {
      coverage: [],
      error: new Error('coverage offline'),
      expected: 'Retained coverage limitation',
    },
  ])(
    'coverage honesty preserves the expected limitation: $expected',
    async ({ coverage, error, expected }) => {
      const h = harness({
        globalRows: { communityCoverage: coverage },
        railErrors: error ? { communityCoverage: error } : {},
      });
      expect(
        await h.community({ priorState: { limitation: 'Retained coverage limitation' } }),
      ).toMatchObject({ count: 0, backfill: { status: 'complete', limitation: expected } });
      expect(h.captures.warnings).toEqual([]);
      expect(h.captures.global.find((call) => call.rail === 'communityCoverage')!.sql).toContain(
        'GROUP BY chamber, fiscal_year',
      );
    },
  );
});
