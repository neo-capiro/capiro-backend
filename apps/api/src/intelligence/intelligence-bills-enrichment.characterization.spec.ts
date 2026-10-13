import {
  clientId,
  deferred,
  harness,
  installHooks,
  tenantId,
  type TrackedBill,
} from '../../test/fixtures/intelligence-bills.js';

const publication = new Date('2026-10-01T00:00:00.000Z');
const actionDate = new Date('2026-09-30T00:00:00.000Z');
const bundle = (bills: ReturnType<typeof tracked>[]) => ({
  total: 99,
  issueCodes: ['DEF'],
  bills,
});
function regulation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reg-1',
    document_number: '2026-1',
    type: 'PROPOSED_RULE',
    title: 'Defense rule',
    agency_names: ['Synthetic agency'],
    topics: ['Defense'],
    comment_end_date: publication,
    publication_date: publication,
    effective_date: null,
    significant_rule: false,
    html_url: null,
    ...overrides,
  };
}
function gao(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gao-1',
    title: 'Synthetic GAO',
    publish_date: publication,
    topics: ['Defense'],
    report_type: null,
    recommendations: null,
    url: null,
    ...overrides,
  };
}
function crs(overrides: Record<string, unknown> = {}) {
  return {
    id: 'crs-1',
    title: 'Synthetic CRS',
    date: publication,
    topics: ['Defense'],
    authors: ['Synthetic author'],
    html_url: null,
    ...overrides,
  };
}
function tracked(
  subjectNames = ['Defense'],
  identifier = '119-hr-1234',
): TrackedBill & { isManual: boolean } {
  return {
    identifier,
    title: 'Synthetic bill',
    subjectNames,
    isManual: false,
    latestActionDate: actionDate,
    latestActionText: null,
    sponsorName: null,
    sponsorParty: null,
  };
}
installHooks();

it('getBillRegulationLinks resolves the actual tracked-bill source once and refuses catalog reads for an empty list', async () => {
  const h = harness();
  const source = h.override('getTrackedBills', bundle([]));
  await expect(h.service.getBillRegulationLinks(clientId, tenantId)).resolves.toEqual({
    links: [],
    totalBills: 0,
    totalRegulations: 0,
  });
  expect(source).toHaveBeenCalledTimes(1);
  expect(source).toHaveBeenCalledWith(clientId, tenantId);
  expect(h.callsOf('regulations')).toHaveLength(0);
});

it('getBillRegulationLinks uses a precomputed value as the authority instead of starting another tracked-bill request', async () => {
  const h = harness({ results: { regulations: [regulation()] } });
  const source = h.override('getTrackedBills', () => {
    throw new Error('Unexpected tracked read');
  });
  const value = bundle([tracked()]);
  const result = await h.service.getBillRegulationLinks(clientId, tenantId, value);
  expect(source).not.toHaveBeenCalled();
  expect(result.totalBills).toBe(1);
  expect(result.links[0]!.bill.latestActionDate).toBe(actionDate);
  expect(h.callsOf('regulations')).toHaveLength(1);
});

it('getBillRegulationLinks waits for a precomputed promise without another tracked call or premature SQL', async () => {
  const h = harness({ results: { regulations: [regulation()] } });
  const source = h.override('getTrackedBills', bundle([]));
  const pending = deferred<ReturnType<typeof bundle>>();
  const result = h.service.getBillRegulationLinks(clientId, tenantId, pending.promise);
  expect(source).not.toHaveBeenCalled();
  expect(h.callsOf('regulations')).toHaveLength(0);
  pending.resolve(bundle([tracked()]));
  expect((await result).links).toHaveLength(1);
  expect(source).not.toHaveBeenCalled();
});

it('getBillRegulationLinks propagates a rejected precomputed promise without falling back or querying catalogs', async () => {
  const h = harness();
  const source = h.override('getTrackedBills', bundle([tracked()]));
  const failure = new Error('Precomputed failure');
  await expect(
    h.service.getBillRegulationLinks(clientId, tenantId, Promise.reject(failure)),
  ).rejects.toBe(failure);
  expect(source).not.toHaveBeenCalled();
  expect(h.callsOf('regulations')).toHaveLength(0);
});

it('getBillRegulationLinks deduplicates subjects in insertion order and preserves case-sensitive topic projection', async () => {
  const h = harness({
    results: {
      regulations: [
        regulation({ topics: ['Defense'] }),
        regulation({ id: 'upper', document_number: 'upper', title: 'Other', topics: ['DEFENSE'] }),
      ],
    },
  });
  h.override(
    'getTrackedBills',
    bundle([tracked(['Defense', 'defense', 'Defense']), tracked(['defense'], 'bad-key')]),
  );
  const result = await h.service.getBillRegulationLinks(clientId, tenantId);
  const query = h.callsOf('regulations')[0]!.query!;
  expect(query.values).toEqual([
    ['Defense', 'defense'],
    ['%HR 1234%', '%HR1234%'],
    ['%HR 1234%', '%HR1234%'],
  ]);
  expect(query.values[1]).toBe(query.values[2]);
  expect(query.sql).toContain('topics &&');
  expect(result.links).toHaveLength(1);
  expect(result.links[0]!.regulations.map((r) => r.documentNumber)).toEqual(['2026-1']);
  expect(result.totalBills).toBe(2);
  expect(result.totalRegulations).toBe(2);
});

it('getBillRegulationLinks qualifies abstract text in SQL while projecting only identifier mentions in the title', async () => {
  const h = harness({
    results: {
      regulations: [
        regulation({ title: 'Other', topics: [], abstract: 'HR1234' }),
        regulation({
          id: 'title',
          document_number: 'title',
          title: 'Rule for hr 1234',
          topics: [],
        }),
      ],
    },
  });
  h.override('getTrackedBills', bundle([tracked([])]));
  const result = await h.service.getBillRegulationLinks(clientId, tenantId);
  const query = h.callsOf('regulations')[0]!.query!;
  expect(query.sql).toContain('title ILIKE ANY');
  expect(query.sql).toContain('abstract ILIKE ANY');
  expect(result.links[0]!.regulations.map((r) => r.documentNumber)).toEqual(['title']);
  expect(result.links[0]!.regulations[0]!.matchedTopics).toEqual([]);
  expect(result.totalRegulations).toBe(2);
});

it('getBillRegulationLinks still queries for malformed identifiers and an empty subject set without inventing patterns', async () => {
  const h = harness({ results: { regulations: [regulation()] } });
  h.override('getTrackedBills', bundle([tracked([], 'malformed')]));
  await expect(h.service.getBillRegulationLinks(clientId, tenantId)).resolves.toEqual({
    links: [],
    totalBills: 1,
    totalRegulations: 1,
  });
  expect(h.callsOf('regulations')[0]!.query!.values).toEqual([[], [], []]);
});

it('getBillRegulationLinks preserves the 200-row SQL bound and counts the catalog before each ten-row display cap', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => regulation({ document_number: `reg-${i}` }));
  rows.push(regulation({ title: 'Other', topics: ['Other'] }));
  const h = harness({ results: { regulations: rows } });
  h.override('getTrackedBills', bundle([tracked(), tracked(['Unknown'], 'bad-key')]));
  const result = await h.service.getBillRegulationLinks(clientId, tenantId);
  expect(h.callsOf('regulations')[0]!.query!.sql).toContain('LIMIT 200');
  expect(h.callsOf('regulations')[0]!.query!.sql).toContain('ORDER BY publication_date DESC');
  expect(result.links).toHaveLength(1);
  expect(result.links[0]!.regulations.map((r) => r.documentNumber)).toEqual(
    Array.from({ length: 10 }, (_, i) => `reg-${i}`),
  );
  expect(result).toMatchObject({ totalBills: 2, totalRegulations: 13 });
});

it('getBillRegulationLinks keeps source Date and agency-array references while projecting a fresh matched-topic array', async () => {
  const row = regulation();
  const h = harness({ results: { regulations: [row] } });
  h.override('getTrackedBills', bundle([tracked()]));
  const result = await h.service.getBillRegulationLinks(clientId, tenantId);
  const view = result.links[0]!.regulations[0]!;
  expect(view.publicationDate).toBe(publication);
  expect(view.commentEndDate).toBe(publication);
  expect(view.agencyNames).toBe(row.agency_names);
  expect(view.matchedTopics).toEqual(['Defense']);
  expect(view.matchedTopics).not.toBe(row.topics);
  expect(view).toMatchObject({ effectiveDate: null, significantRule: false, htmlUrl: null });
});

it('getBillRegulationLinks propagates regulation catalog failure without a fabricated empty success', async () => {
  const failure = new Error('Regulation catalog failed');
  const h = harness({ errors: { regulations: failure } });
  h.override('getTrackedBills', bundle([tracked()]));
  await expect(h.service.getBillRegulationLinks(clientId, tenantId)).rejects.toBe(failure);
  expect(h.callsOf('regulations')).toHaveLength(1);
});

it('getBillResearchAttachments returns a zero-bill empty envelope without report queries', async () => {
  const h = harness();
  const source = h.override('getTrackedBills', bundle([]));
  await expect(h.service.getBillResearchAttachments(clientId, tenantId)).resolves.toEqual({
    attachments: [],
    totalBills: 0,
    totalReports: 0,
  });
  expect(source).toHaveBeenCalledWith(clientId, tenantId);
  expect(h.callsOf('gaoReports')).toHaveLength(0);
  expect(h.callsOf('crsReports')).toHaveLength(0);
});

it('getBillResearchAttachments retains actual bill count but skips both catalogs when tracked subjects are empty', async () => {
  const h = harness();
  h.override('getTrackedBills', bundle([tracked([]), tracked([], '119-s-2')]));
  await expect(h.service.getBillResearchAttachments(clientId, tenantId)).resolves.toEqual({
    attachments: [],
    totalBills: 2,
    totalReports: 0,
  });
  expect(h.callsOf('gaoReports')).toHaveLength(0);
  expect(h.callsOf('crsReports')).toHaveLength(0);
});

it('getBillResearchAttachments starts GAO then CRS eagerly before either resolves and preserves catalog projection order', async () => {
  const gaoRead = deferred<ReturnType<typeof gao>[]>();
  const crsRead = deferred<ReturnType<typeof crs>[]>();
  const h = harness({ results: { gaoReports: gaoRead.promise, crsReports: crsRead.promise } });
  h.override('getTrackedBills', bundle([tracked()]));
  const pending = h.service.getBillResearchAttachments(clientId, tenantId);
  await h.started('gaoReports');
  await h.started('crsReports');
  expect(
    h.calls
      .filter((c) => ['gaoReports', 'crsReports'].includes(c.operation))
      .map((c) => c.operation),
  ).toEqual(['gaoReports', 'crsReports']);
  crsRead.resolve([crs()]);
  gaoRead.resolve([gao()]);
  const result = await pending;
  expect(result.attachments[0]!.gao[0]!.id).toBe('gao-1');
  expect(result.attachments[0]!.crs[0]!.id).toBe('crs-1');
});

it('getBillResearchAttachments preserves subject bindings, case-sensitive overlap, both 150-row bounds and CRS active-only SQL', async () => {
  const h = harness({
    results: {
      gaoReports: [gao(), gao({ id: 'upper', topics: ['DEFENSE'] })],
      crsReports: [crs(), crs({ id: 'unknown', topics: ['Unknown'] })],
    },
  });
  h.override('getTrackedBills', bundle([tracked(['Defense', 'defense', 'Defense'])]));
  const result = await h.service.getBillResearchAttachments(clientId, tenantId);
  for (const op of ['gaoReports', 'crsReports']) {
    expect(h.callsOf(op)[0]!.query!.values).toEqual([['Defense', 'defense']]);
    expect(h.callsOf(op)[0]!.scope).toBe('global');
    expect(h.callsOf(op)[0]!.query!.sql).toContain('LIMIT 150');
    expect(h.callsOf(op)[0]!.query!.sql).toContain('DESC NULLS LAST');
  }
  expect(h.callsOf('crsReports')[0]!.query!.sql).toContain('AND active = true');
  expect(result.attachments[0]!.gao.map((r) => r.id)).toEqual(['gao-1']);
  expect(result.attachments[0]!.crs.map((r) => r.id)).toEqual(['crs-1']);
  expect(result.totalReports).toBe(4);
});

it('getBillResearchAttachments caps each report rail at eight while totals include unprojected rows and bills', async () => {
  const h = harness({
    results: {
      gaoReports: Array.from({ length: 10 }, (_, i) => gao({ id: `gao-${i}` })),
      crsReports: Array.from({ length: 11 }, (_, i) => crs({ id: `crs-${i}` })),
    },
  });
  h.override('getTrackedBills', bundle([tracked(), tracked(['Absent'], '119-s-2')]));
  const result = await h.service.getBillResearchAttachments(clientId, tenantId);
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments[0]!.gao.map((r) => r.id)).toEqual(
    Array.from({ length: 8 }, (_, i) => `gao-${i}`),
  );
  expect(result.attachments[0]!.crs.map((r) => r.id)).toEqual(
    Array.from({ length: 8 }, (_, i) => `crs-${i}`),
  );
  expect(result).toMatchObject({ totalBills: 2, totalReports: 21 });
});

it('getBillResearchAttachments preserves Date/authors references and explicit null report fields without cloning source rows', async () => {
  const gaoRow = gao();
  const crsRow = crs();
  const h = harness({ results: { gaoReports: [gaoRow], crsReports: [crsRow] } });
  h.override('getTrackedBills', bundle([tracked()]));
  const result = await h.service.getBillResearchAttachments(clientId, tenantId);
  const attachment = result.attachments[0]!;
  expect(attachment.bill.latestActionDate).toBe(actionDate);
  expect(attachment.gao[0]!.publishDate).toBe(publication);
  expect(attachment.crs[0]!.date).toBe(publication);
  expect(attachment.crs[0]!.authors).toBe(crsRow.authors);
  expect(attachment.gao[0]).toMatchObject({ reportType: null, recommendations: null, url: null });
  expect(attachment.crs[0]).toMatchObject({ htmlUrl: null });
  expect(attachment.gao[0]!.topics).not.toBe(gaoRow.topics);
});

it('getBillResearchAttachments keeps catalog totals even when no report projects into any tracked bill', async () => {
  const h = harness({
    results: {
      gaoReports: [gao({ topics: ['Other'] })],
      crsReports: [crs({ topics: ['Other'] })],
    },
  });
  h.override('getTrackedBills', bundle([tracked()]));
  await expect(h.service.getBillResearchAttachments(clientId, tenantId)).resolves.toEqual({
    attachments: [],
    totalBills: 1,
    totalReports: 2,
  });
});

it.each(['gaoReports', 'crsReports'])(
  'getBillResearchAttachments propagates %s failure after starting both eager reads',
  async (operation) => {
    const failure = new Error(`${operation} failed`);
    const gate = deferred<unknown[]>();
    const h = harness({ results: { gaoReports: [], crsReports: [], [operation]: gate.promise } });
    h.override('getTrackedBills', bundle([tracked()]));
    const pending = h.service.getBillResearchAttachments(clientId, tenantId);
    await h.started('gaoReports');
    await h.started('crsReports');
    const assertion = expect(pending).rejects.toBe(failure);
    gate.reject(failure);
    await assertion;
    expect(h.callsOf('gaoReports')).toHaveLength(1);
    expect(h.callsOf('crsReports')).toHaveLength(1);
  },
);

it('getBillResearchAttachments propagates tracked-source failure before either report catalog starts', async () => {
  const h = harness();
  const failure = new Error('Tracked source failed');
  h.override('getTrackedBills', Promise.reject(failure));
  await expect(h.service.getBillResearchAttachments(clientId, tenantId)).rejects.toBe(failure);
  expect(h.callsOf('gaoReports')).toHaveLength(0);
  expect(h.callsOf('crsReports')).toHaveLength(0);
});
