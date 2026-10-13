import {
  clientId,
  ctx,
  federalSuggestion,
  harness,
  installHooks,
  now,
  runId,
} from '../../test/fixtures/client-profile-fill-advocacy-history.js';

installHooks();
const firstMatter = '55555555-5555-5555-5555-555555555555';
const secondMatter = '66666666-6666-6666-6666-666666666666';
const oldAt = '2025-01-01T00:00:00.000Z';
const prior = {
  startedAt: oldAt,
  examined: 8,
  candidates: 3,
  checkpoint: { matterId: 'prior-matter' },
};
const scoped = (rows: Record<string, unknown[]> = {}) => ({
  federalMatters: [{ id: firstMatter }],
  ...rows,
});

describe('Federal Register discovery — eligible Matter coverage', () => {
  test('initial tenant/client-scoped coverage uses eligible regulatory links and a 50-Matter keyset page', async () => {
    const suggestion = federalSuggestion();
    const h = harness({ tenantRows: scoped(), correlationRows: { [firstMatter]: [suggestion] } });
    expect(await h.federalRegister(prior)).toMatchObject({
      status: 'complete',
      startedAt: oldAt,
      completedAt: now.toISOString(),
      checkpoint: { matterId: firstMatter },
      historyStart: null,
      examined: 9,
      candidates: 4,
      lastError: null,
      suggestions: [{ matterId: firstMatter, ...suggestion }],
    });
    const query = h.callsOf('federalMatters')[0]!;
    expect(query.args).toEqual([
      ctx.tenantId,
      clientId,
      false,
      '1970-01-01T00:00:00.000Z',
      'prior-matter',
    ]);
    expect(query.sql).toContain('m.tenant_id = $1::uuid AND m.client_id = $2::uuid');
    expect(query.sql).toContain('l.tenant_id = m.tenant_id AND l.matter_id = m.id');
    expect(query.sql).toContain("l.link_type IN ('regulatory_docket', 'regulatory_document')");
    expect(query.sql).toContain('m.id > $5::uuid');
    expect(query.sql).toContain('LIMIT 50');
    expect(h.captures.correlations).toEqual([[ctx, clientId, firstMatter]]);
    expect(h.callsOf('regulatoryAttribution')[0]!.args).toEqual([
      ctx.tenantId,
      clientId,
      firstMatter,
    ]);
  });

  test('completed history performs uncapped incremental updated-Matter and changed-link coverage', async () => {
    const h = harness({ tenantRows: scoped() });
    const checkpoint = { matterId: 'historical-frontier', retained: true };
    expect(
      await h.federalRegister({ ...prior, status: 'complete', lastSuccessAt: oldAt, checkpoint }),
    ).toMatchObject({ status: 'complete', checkpoint, examined: 9, candidates: 3 });
    const query = h.callsOf('federalMatters')[0]!;
    expect(query.args).toEqual([ctx.tenantId, clientId, true, oldAt, 'historical-frontier']);
    expect(query.sql).toContain('m.updated_at > $4::timestamptz');
    expect(query.sql).toContain('changed.tenant_id = m.tenant_id AND changed.matter_id = m.id');
    expect(query.sql).toContain('changed.created_at > $4::timestamptz');
    expect(query.sql).toContain(
      'ORDER BY CASE WHEN $3::boolean THEN m.updated_at END ASC NULLS FIRST, m.id ASC',
    );
    expect(query.sql).not.toContain('LIMIT 50');
  });

  test('exactly 50 initial Matters remain in progress with the last Matter as the frontier', async () => {
    const matters = Array.from({ length: 50 }, (_, index) => ({ id: `matter-${index}` }));
    const h = harness({ tenantRows: { federalMatters: matters } });
    const result = await h.federalRegister(prior);
    expect(result).toMatchObject({
      status: 'in_progress',
      examined: 58,
      candidates: 3,
      checkpoint: { matterId: 'matter-49' },
      suggestions: [],
    });
    expect(result.completedAt).toBeUndefined();
    expect(h.captures.correlations).toHaveLength(50);
    expect(h.callsOf('regulatoryAttribution')).toEqual([]);
  });

  test('empty initial coverage completes and returns a null checkpoint instead of the prior Matter', async () => {
    const h = harness();
    expect(await h.federalRegister(prior)).toMatchObject({
      status: 'complete',
      completedAt: now.toISOString(),
      examined: 8,
      candidates: 3,
      checkpoint: null,
      suggestions: [],
    });
    expect(h.captures.correlations).toEqual([]);
    expect(h.captures.findings).toEqual([]);
  });
});

describe('Federal Register discovery — attribution and the review ledger', () => {
  test('candidate totals include nondeterministic and date-filtered suggestions while only later exact-docket movement emits', async () => {
    const suggestions = [
      federalSuggestion({ documentNumber: 'nondeterministic', matchedDocketIds: [] }),
      federalSuggestion({ documentNumber: 'before', publicationDate: '2024-12-31' }),
      federalSuggestion({ documentNumber: 'same-day', publicationDate: '2025-01-01' }),
      federalSuggestion({
        documentNumber: 'after',
        publicationDate: '2025-01-02',
        matchedDocketIds: ['SCI-1', 'SCI-2'],
      }),
    ];
    const h = harness({ tenantRows: scoped(), correlationRows: { [firstMatter]: suggestions } });
    expect(await h.federalRegister({})).toMatchObject({
      examined: 1,
      candidates: 4,
      status: 'complete',
    });
    expect(h.callsOf('regulatoryAttribution')).toHaveLength(1);
    expect(h.callsOf('regulatoryAttribution')[0]!.sql).toContain(
      'tenant_id = $1::uuid AND client_id = $2::uuid AND matter_id = $3::uuid',
    );
    expect(h.callsOf('regulatoryAttribution')[0]!.sql).toContain(
      "source_type = 'regulatory_comment'",
    );
    expect(h.captures.findings).toHaveLength(1);
    expect(h.captures.findings[0]).toMatchObject({
      runId,
      tenantId: ctx.tenantId,
      clientId,
      kind: 'regulatory_outcome',
      targetKey: `regulatory-outcome:${firstMatter}:after`,
      source: 'federal_register',
      factKind: 'recommendation',
      confidence: 0.95,
      status: 'pending',
      proposedValue: {
        matterId: firstMatter,
        documentNumber: 'after',
        docketId: 'SCI-1',
        matchedDocketIds: ['SCI-1', 'SCI-2'],
        attributableActivityDate: oldAt,
        relationship: 'strongly_aligned',
        matchedOn: 'docket_id',
        causationClaimed: false,
      },
      evidence: [
        {
          metadata: {
            documentNumber: 'after',
            docketId: 'SCI-1',
            matchedOn: 'docket_id',
            causationClaimed: false,
          },
        },
      ],
    });
  });
});

describe('Federal Register discovery — review state and enrichment budget', () => {
  test('a Matter without an attributable regulatory comment records candidates without emitting outcomes', async () => {
    const h = harness({
      tenantRows: scoped({ regulatoryAttribution: [{ earliestActivityDate: null }] }),
      correlationRows: { [firstMatter]: [federalSuggestion()] },
    });
    expect(await h.federalRegister({})).toMatchObject({
      status: 'complete',
      examined: 1,
      candidates: 1,
    });
    expect(h.callsOf('regulatoryAttribution')[0]!.args).toEqual([
      ctx.tenantId,
      clientId,
      firstMatter,
    ]);
    expect(h.captures.findings).toEqual([]);
    expect(h.callsOf('terminal')).toEqual([]);
  });

  test('accepted or rejected outcome hashes stay terminal while coverage still records the suggestion', async () => {
    const h = harness({
      tenantRows: scoped(),
      correlationRows: { [firstMatter]: [federalSuggestion()] },
      terminalResults: [true],
    });
    expect(await h.federalRegister({})).toMatchObject({
      status: 'complete',
      examined: 1,
      candidates: 1,
    });
    expect(h.captures.findings).toEqual([]);
    expect(h.callsOf('retire')).toEqual([]);
    expect(h.callsOf('terminal')[0]!.args.slice(0, 2)).toEqual([ctx.tenantId, clientId]);
    expect(h.callsOf('terminal')[0]!.sql).toContain("status IN ('accepted', 'rejected')");
  });

  test('enrichment does not apply the shared 200-finding discovery budget to regulatory outcomes', async () => {
    const matters = Array.from({ length: 5 }, (_, index) => ({ id: `matter-${index}` }));
    const correlationRows = Object.fromEntries(
      matters.map(({ id }) => [
        id,
        Array.from({ length: 41 }, (_, index) =>
          federalSuggestion({ documentNumber: `${id}-document-${index}` }),
        ),
      ]),
    );
    const h = harness({ tenantRows: { federalMatters: matters }, correlationRows });
    expect(await h.federalRegister({})).toMatchObject({
      status: 'complete',
      examined: 5,
      candidates: 205,
    });
    expect(h.captures.findings).toHaveLength(205);
    expect(h.captures.findings.at(-1)!.targetKey).toBe(
      'regulatory-outcome:matter-4:matter-4-document-40',
    );
    expect(h.callsOf('regulatoryAttribution')).toHaveLength(5);
    expect(h.captures.findings.every((finding) => finding.status === 'pending')).toBe(true);
  });
});

describe('Federal Register discovery — partial failure preserves existing effects', () => {
  test('later correlation failure resets returned coverage but keeps an earlier committed finding', async () => {
    const h = harness({
      tenantRows: { federalMatters: [{ id: firstMatter }, { id: secondMatter }] },
      correlationRows: {
        [firstMatter]: [federalSuggestion()],
        [secondMatter]: new Error('second Matter offline'),
      },
    });
    const result = await h.federalRegister(prior);
    expect(result).toEqual({
      status: 'partial',
      startedAt: oldAt,
      checkpoint: null,
      historyStart: null,
      examined: 0,
      candidates: 0,
      lastError: 'second Matter offline',
    });
    expect(h.captures.correlations).toEqual([
      [ctx, clientId, firstMatter],
      [ctx, clientId, secondMatter],
    ]);
    expect(h.captures.findings).toHaveLength(1);
    const transaction = h.captures.findings[0]!.transaction;
    expect(h.captures.phases.indexOf(`${transaction}:commit`)).toBeLessThan(
      h.captures.phases.lastIndexOf('outside:correlation'),
    );
    expect(h.captures.warnings).toEqual([
      'Federal Register correlation backfill unavailable: second Matter offline',
    ]);
    expect(h.captures.cursors).toEqual([]);
  });

  test('eligible-Matter query failure returns the same reset partial state before any provider or ledger call', async () => {
    const h = harness({ railErrors: { federalMatters: new Error('Matter query offline') } });
    expect(await h.federalRegister(prior)).toEqual({
      status: 'partial',
      startedAt: oldAt,
      checkpoint: null,
      historyStart: null,
      examined: 0,
      candidates: 0,
      lastError: 'Matter query offline',
    });
    expect(h.captures.correlations).toEqual([]);
    expect(h.captures.findings).toEqual([]);
    expect(h.captures.warnings).toEqual([
      'Federal Register correlation backfill unavailable: Matter query offline',
    ]);
  });
});
