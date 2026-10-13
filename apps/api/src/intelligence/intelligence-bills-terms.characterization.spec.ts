import {
  harness,
  clientId,
  tenantId,
  capabilityRow,
  installHooks,
} from '../../test/fixtures/intelligence-bills.js';

installHooks();
const sql = (args: unknown[]) =>
  (args[0] as TemplateStringsArray).join('$1').replace(/\s+/g, ' ').trim();
const autoRows = {
  mappings: [{ externalId: '11', externalName: 'Registrant One' }],
  issueCodes: [{ code: 'DEF' }],
  issueNames: [{ code: 'DEF', name: 'Defense' }],
};

describe('Capability fallback term extraction retains its distinct contract', () => {
  it('preserves sector/word/tag order, raw whitespace and duplicates without acronym expansion', async () => {
    const caps = [
      capabilityRow({
        sector: ' Research ',
        name: 'AI EW space optics abc',
        tags: ['radar', ' EW ', 'abc', 7, null, 'radar'],
      }),
    ];
    const h = harness({ rows: { capabilities: caps } });
    expect(await h.subject.capabilityFallbackTerms(tenantId, clientId)).toEqual([
      ' Research ',
      'space',
      'optics',
      'radar',
      ' EW ',
      'radar',
    ]);
    expect(h.callsOf('capabilities')[0]!.args).toEqual([
      { where: { clientId }, select: { sector: true, name: true, tags: true } },
    ]);
    expect(h.callsOf('capabilities')[0]!.scope).toBe('tenant');
  });
  it('ignores non-array tags but retains truthy blank sectors and four-character words', async () => {
    const h = harness({
      rows: {
        capabilities: [
          capabilityRow({ sector: ' ', name: 'one four', tags: 'ignored tag string' }),
        ],
      },
    });
    expect(await h.subject.capabilityFallbackTerms(tenantId, clientId)).toEqual([' ', 'four']);
  });
  it('returns no terms for an empty capability ledger without other reads', async () => {
    const h = harness({ rows: { capabilities: [] } });
    expect(await h.subject.capabilityFallbackTerms(tenantId, clientId)).toEqual([]);
    expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'capabilities']);
  });
  it('propagates capability-read failure rather than inventing fallback terms', async () => {
    const h = harness({ errors: { capabilities: new Error('capabilities unavailable') } });
    await expect(h.subject.capabilityFallbackTerms(tenantId, clientId)).rejects.toThrow(
      'capabilities unavailable',
    );
  });
});

describe('Client relevance terms union and query scope', () => {
  it('unions every finite LDA registrant with overrides in first-seen order and uses exact global lookups', async () => {
    const h = harness({
      rows: {
        mappings: [{ externalId: '11' }, { externalId: '22' }, { externalId: 'not-a-number' }],
        issueCodes: [{ code: ' DEF ' }, { code: 'AVI' }, { code: ' ' }, { code: null }],
        issueNames: [{ name: ' Defense ' }, { name: 'Aviation' }, { name: 'Taxation' }],
        capabilities: [],
      },
      results: { client: { id: clientId, issueCodes: ['TAX', 'AVI', ' DEF ', ''] } },
    });
    expect(await h.service.getClientRelevanceTerms(clientId, tenantId)).toEqual({
      issueCodes: ['DEF', 'AVI', 'TAX'],
      issueNames: [' Defense ', 'Aviation', 'Taxation'],
      keywordTermsExpanded: ['Defense', 'Aviation', 'Taxation'],
      embeddingPartsClean: ['Defense', 'Aviation', 'Taxation'],
      hasCapabilitySignal: false,
    });
    expect(h.callsOf('mappings')[0]!.args).toEqual([
      { where: { clientId, source: 'lda', confirmed: true }, select: { externalId: true } },
    ]);
    expect(h.callsOf('issueCodes')[0]!.args.slice(1)).toEqual([[11, 22]]);
    expect(sql(h.callsOf('issueCodes')[0]!.args)).toBe(
      'SELECT DISTINCT unnest(issue_codes) AS code FROM lda_client WHERE id = ANY($1::int[]) AND issue_codes IS NOT NULL',
    );
    expect(sql(h.callsOf('issueNames')[0]!.args)).toBe(
      'SELECT name FROM lda_issue_code WHERE code = ANY($1::text[])',
    );
    expect(h.callsOf('issueNames')[0]!.args.slice(1)).toEqual([['DEF', 'AVI', 'TAX']]);
    expect(h.callsOf('issueCodes')[0]!.scope).toBe('global');
  });
  it('accepts manual issue overrides without any LDA mapping and keeps their order', async () => {
    const h = harness({
      rows: {
        mappings: [],
        capabilities: [],
        issueNames: [{ name: 'Taxation' }, { name: 'Defense' }],
      },
      results: { client: { issueCodes: [' TAX ', 'DEF', 'TAX'] } },
    });
    expect((await h.service.getClientRelevanceTerms(clientId, tenantId)).issueCodes).toEqual([
      'TAX',
      'DEF',
    ]);
    expect(h.callsOf('issueCodes')).toEqual([]);
    expect(h.callsOf('client')[0]!.args).toEqual([
      { where: { id: clientId }, select: { issueCodes: true } },
    ]);
  });
  it('skips issue-name lookup when both mapping and override codes are empty', async () => {
    const h = harness({
      rows: { mappings: [], capabilities: [] },
      results: { client: { issueCodes: [] } },
    });
    expect(await h.service.getClientRelevanceTerms(clientId, tenantId)).toEqual({
      issueCodes: [],
      issueNames: [],
      keywordTermsExpanded: [],
      embeddingPartsClean: [],
      hasCapabilitySignal: false,
    });
    expect(h.callsOf('issueNames')).toEqual([]);
  });
});

describe('Client relevance keyword versus semantic evidence', () => {
  it('expands known short tag acronyms while keeping short unknown tags and rich prose semantic-only', async () => {
    const cap = capabilityRow({
      sector: ' Defense ',
      name: 'AI EW sensor platform',
      tags: ['EW', ' AI ', 'xy', ' radar ', 42],
      description: '  Rich mission description. ',
      justification: ' Funding rationale. ',
      districtNexus: ' Regional workforce. ',
    });
    const h = harness({
      rows: { capabilities: [cap], mappings: [] },
      results: { client: { issueCodes: [] } },
    });
    expect(await h.service.getClientRelevanceTerms(clientId, tenantId)).toEqual({
      issueCodes: [],
      issueNames: [],
      keywordTermsExpanded: [
        'Defense',
        'sensor',
        'platform',
        'EW',
        'electronic warfare',
        'AI',
        'artificial intelligence',
        'radar',
      ],
      embeddingPartsClean: [
        'Defense',
        'AI EW sensor platform',
        'EW',
        'AI',
        'xy',
        'radar',
        'Rich mission description.',
        'Funding rationale.',
        'Regional workforce.',
      ],
      hasCapabilitySignal: true,
    });
    expect(h.callsOf('capabilities')[0]!.args).toEqual([
      {
        where: { clientId },
        select: {
          sector: true,
          name: true,
          tags: true,
          description: true,
          justification: true,
          districtNexus: true,
        },
      },
    ]);
  });
});

describe('Client relevance keyword deduplication and independent signal', () => {
  it('case-deduplicates keyword tokens without deduplicating semantic parts', async () => {
    const cap = capabilityRow({
      sector: 'Radar',
      name: 'radar RADAR',
      tags: ['Radar'],
      description: null,
      justification: null,
      districtNexus: null,
    });
    const h = harness({ rows: { capabilities: [cap] }, results: { client: { issueCodes: [] } } });
    const result = await h.service.getClientRelevanceTerms(clientId, tenantId);
    expect(result.keywordTermsExpanded).toEqual(['Radar']);
    expect(result.embeddingPartsClean).toEqual(['Radar', 'radar RADAR', 'Radar']);
  });
  it('reports capability signal independently of whether a capability yields any terms', async () => {
    const cap = capabilityRow({
      sector: null,
      name: null,
      tags: null,
      description: null,
      justification: null,
      districtNexus: null,
    });
    const h = harness({ rows: { capabilities: [cap] }, results: { client: { issueCodes: [] } } });
    expect(await h.service.getClientRelevanceTerms(clientId, tenantId)).toEqual({
      issueCodes: [],
      issueNames: [],
      keywordTermsExpanded: [],
      embeddingPartsClean: [],
      hasCapabilitySignal: true,
    });
  });
});

describe('Relevance and issue-signal read failures retain their separate policy', () => {
  it.each(['mappings', 'issueCodes', 'issueNames'])(
    'propagates fatal %s reads in both real entry points',
    async (operation) => {
      const h = harness({
        rows: autoRows,
        results: { client: { issueCodes: [] } },
        errors: { [operation]: new Error(`${operation} failed`) },
      });
      await expect(h.service.getClientRelevanceTerms(clientId, tenantId)).rejects.toThrow(
        `${operation} failed`,
      );
      await expect(h.service.getIssueCodeSignal(clientId, tenantId)).rejects.toThrow(
        `${operation} failed`,
      );
    },
  );
  it('keeps LDA terms when the best-effort client override read fails', async () => {
    const h = harness({ rows: autoRows, errors: { client: new Error('client read unavailable') } });
    expect((await h.service.getClientRelevanceTerms(clientId, tenantId)).issueCodes).toEqual([
      'DEF',
    ]);
    expect(h.callsOf('capabilities')).toHaveLength(1);
  });
  it('propagates capability-read failure for relevance despite existing LDA terms', async () => {
    const h = harness({
      rows: autoRows,
      errors: { capabilities: new Error('capabilities failed') },
    });
    await expect(h.service.getClientRelevanceTerms(clientId, tenantId)).rejects.toThrow(
      'capabilities failed',
    );
  });
  it.each(['client', 'capabilities'])(
    'keeps LDA-only issue signal when the combined best-effort %s read fails',
    async (operation) => {
      const h = harness({
        rows: autoRows,
        results: { client: { issueCodes: ['TAX'] } },
        errors: { [operation]: new Error('tenant details unavailable') },
      });
      expect(await h.service.getIssueCodeSignal(clientId, tenantId)).toMatchObject({
        codes: [{ code: 'DEF', name: 'Defense', source: 'lda' }],
        overrideCodeCount: 0,
        capabilityTagCount: 0,
        capabilityDescCount: 0,
      });
    },
  );
});

describe('Malformed tenant detail retains partial issue-signal state', () => {
  it('retains overrides assigned before a malformed capability row triggers the best-effort catch', async () => {
    const h = harness({
      rows: { ...autoRows, capabilities: [null] },
      results: { client: { issueCodes: ['TAX'] } },
    });
    expect(await h.service.getIssueCodeSignal(clientId, tenantId)).toMatchObject({
      codes: [
        { code: 'DEF', name: 'Defense', source: 'lda' },
        { code: 'TAX', name: null, source: 'manual' },
      ],
      overrideCodeCount: 1,
      capabilityTagCount: 0,
      capabilityDescCount: 0,
    });
  });
  it('keeps the existing fatal malformed-override behavior for relevance rather than silently filtering it', async () => {
    const h = harness({ results: { client: { issueCodes: [42] } } });
    await expect(h.service.getClientRelevanceTerms(clientId, tenantId)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(h.callsOf('capabilities')).toEqual([]);
  });
});

describe('Issue-code signal classification and supporting evidence counts', () => {
  it('sorts normalized code union, reports both/manual/LDA origin and preserves all registrant labels', async () => {
    const h = harness({
      rows: {
        mappings: [
          { externalId: '11', externalName: 'First' },
          { externalId: '22', externalName: 'Second' },
          { externalId: 'bad', externalName: 'Invalid id label' },
        ],
        issueCodes: [{ code: ' DEF ' }, { code: 'AVI' }, { code: null }],
        issueNames: [
          { code: 'DEF', name: 'Defense' },
          { code: 'AVI', name: 'Aviation' },
        ],
        capabilities: [
          capabilityRow({ tags: ['one', 42, null], description: ' Text ' }),
          capabilityRow({ tags: 'not-array', description: ' ' }),
        ],
      },
      results: { client: { issueCodes: [' TAX ', 'DEF', 'TAX', '', 42] } },
    });
    expect(await h.service.getIssueCodeSignal(clientId, tenantId)).toEqual({
      clientId,
      ldaRegistrantCount: 2,
      ldaRegistrants: ['First', 'Second', 'Invalid id label'],
      codes: [
        { code: 'AVI', name: 'Aviation', source: 'lda' },
        { code: 'DEF', name: 'Defense', source: 'both' },
        { code: 'TAX', name: null, source: 'manual' },
      ],
      overrideCodeCount: 2,
      capabilityTagCount: 3,
      capabilityDescCount: 1,
    });
    expect(h.callsOf('mappings')[0]!.args).toEqual([
      {
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true, externalName: true },
      },
    ]);
    expect(sql(h.callsOf('issueNames')[0]!.args)).toBe(
      'SELECT code, name FROM lda_issue_code WHERE code = ANY($1::text[])',
    );
    expect(h.callsOf('issueNames')[0]!.args.slice(1)).toEqual([['AVI', 'DEF', 'TAX']]);
  });
  it('retains finite numeric coercion and duplicate mapping identities while excluding invalid numeric IDs', async () => {
    const h = harness({
      rows: {
        mappings: [
          { externalId: '11', externalName: 'One' },
          { externalId: '11', externalName: 'Duplicate' },
          { externalId: null, externalName: 'Null id' },
          { externalId: 'bad', externalName: 'Invalid' },
        ],
        issueCodes: [],
        capabilities: [],
      },
      results: { client: { issueCodes: [] } },
    });
    expect(await h.service.getIssueCodeSignal(clientId, tenantId)).toMatchObject({
      ldaRegistrantCount: 3,
      ldaRegistrants: ['One', 'Duplicate', 'Null id', 'Invalid'],
      codes: [],
    });
    expect(h.callsOf('issueCodes')[0]!.args.slice(1)).toEqual([[11, 11, 0]]);
    expect(h.callsOf('issueNames')).toEqual([]);
  });
});
