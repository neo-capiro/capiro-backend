import { MeriToolsService } from './meri-tools.service.js';
import { withMeriReadObservation } from './meri-funding-read-observation.js';

type Row = Record<string, any>;
type Family = 'state' | 'federal' | 'gao' | 'grants' | 'bls' | 'bea';
const clocks = { operationId: 'get_state_rule_status' as const, stageAsOf: '2026-10-12T01:00:00.000Z', commentAsOf: '2026-10-12T01:00:00.000Z' };
const ctx = { tenantId: '00000000-0000-4000-8000-000000000001' };

/** PostgreSQL LIKE semantics, independently evaluated on emitted bound
 * contains values. This intentionally differs from JS includes. */
function contains(text: unknown, pattern: string): boolean {
  if (typeof text !== 'string') return false;
  const quote = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const like = `%${pattern}%`;
  let regex = '';
  for (let index = 0; index < like.length; index++) {
    const char = like[index]!;
    if (char === '\\' && index + 1 < like.length) regex += quote(like[++index]!);
    else regex += char === '%' ? '[\\s\\S]*' : char === '_' ? '[\\s\\S]' : quote(char);
  }
  return new RegExp(`^${regex}$`, 'i').test(text);
}
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((part: Row) => matches(row, part));
    if (value && typeof value === 'object' && 'contains' in value) return contains(row[key], value.contains);
    if (value && typeof value === 'object' && 'hasSome' in value) return value.hasSome.some((part: string) => row[key]?.includes(part));
    return row[key] === value;
  });
}
function row(id: string, title: string): Row {
  return { id, documentNumber: id, state: 'FL', title, description: title, abstract: null, summary: null,
    agency: 'Synthetic Agency', agencyNames: ['Synthetic Agency'], topics: [], agencies: [], reportType: 'Report',
    publishDate: null, recommendations: 0, url: 'https://example.test/source', sourceUrl: 'https://example.test/source',
    htmlUrl: 'https://example.test/source', pdfUrl: null, type: 'Proposed Rule', ruleType: 'proposed',
    publicationDate: null, commentStartDate: null, commentEndDate: null, effectiveDate: null,
    docketId: null, docketIds: [], linkedBillKeys: [], eligibility: [], status: 'posted',
    closeDate: null, openDate: null, responseDateDesc: null, surveyName: null, periodType: 'Monthly', dataPoints: [],
    datasetName: 'Regional', tableName: 'SAGDP1', year: 2025, period: 'Annual', value: id === 'target' ? 1 : 0, units: 'Synthetic', geoFips: null };
}
function fixture(family: Family, rows: Row[], exact?: Row) {
  const calls: Row[] = [];
  const port = {
    findUnique: jest.fn(async () => exact ?? null),
    findMany: jest.fn(async (query: Row) => { calls.push(query); return rows.filter(value => matches(value, query.where)).slice(0, query.take); }),
    count: jest.fn(async (query: Row) => rows.filter(value => matches(value, query.where)).length),
  };
  const empty = { findUnique: async () => null, findMany: async () => [] };
  const service = Object.create(MeriToolsService.prototype) as Row;
  service.prisma = { stateRule: family === 'state' ? port : empty,
    federalRegisterDocument: family === 'federal' ? port : empty,
    withSystem: async (read: (tx: Row) => unknown) => read({ gaoReport: port, federalGrant: port, blsSeries: port, beaData: port }) };
  const read = (input: Row) => family === 'state' || family === 'federal'
    ? withMeriReadObservation(clocks, () => service.getStateRuleStatus({ ...input, ...(family === 'state' ? { state: 'FL' } : {}) }))
    : family === 'gao' ? service.searchGaoReports(input)
    : family === 'grants' ? service.searchFederalGrants(ctx, input)
    : service.queryEconomicData({ ...input, source: family });
  return { read, port, calls };
}

describe('literal public-source keyword searches', () => {
  for (const family of ['state', 'federal', 'gao', 'grants', 'bls', 'bea'] as const) {
    it.each([
      ['95% accuracy', '95 percent accuracy'], ['unmanned_aircraft', 'unmanned aircraft'],
      ['path\\to', 'pathto'], ['OrDiNaRy', 'unrelated'],
    ])(`${family} preserves literal %s before the page limit`, async (query, unrelated) => {
      const rows = [...Array.from({ length: 60 }, (_, index) => row(`unrelated-${index}`, unrelated)), row('target', `Stored ${query} notice`)];
      const page = await fixture(family, rows).read({ query, limit: 1 });
      if (family === 'state' || family === 'federal') expect(page).toMatchObject({ found: true, id: 'target' });
      else {
        expect(page.data).toHaveLength(1);
        if (family === 'bea') expect(page.data[0].value).toBe(1);
        else expect(page.data[0][family === 'bls' ? 'seriesId' : 'id']).toBe('target');
        if (family === 'gao' || family === 'grants') expect(page.total).toBe(1);
      }
    });
    it(`${family} preserves an omitted or blank query`, async () => {
      const data = fixture(family, [row('target', 'Ordinary notice')]);
      const page = await data.read({ query: ' ', limit: 1 });
      if (family === 'state' || family === 'federal') {
        expect(page.found).toBe(false);
        expect(data.port.findMany).not.toHaveBeenCalled();
      } else {
        expect(page.data).toHaveLength(1);
        expect(data.calls[0]?.where).toEqual({});
      }
    });
  }

  it.each(['state', 'federal'] as const)('preserves the %s exact identifier lookup', async family => {
    const exact = row(family === 'state' ? 'FL-123' : '2026-00001', 'No matching keyword');
    const data = fixture(family, [], exact);
    const page = await data.read({ query: exact.id });
    expect(page).toMatchObject({ found: true, id: exact.id });
    expect(data.port.findUnique).toHaveBeenCalledWith({ where: family === 'state' ? { id: exact.id } : { documentNumber: exact.id } });
    expect(data.port.findMany).not.toHaveBeenCalled();
  });

  it('keeps GAO array tags and report-type equality literal without escaping their stored identity', async () => {
    const data = fixture('gao', [{ ...row('target', 'Unrelated title'), topics: ['95% accuracy'], reportType: 'Report_One' }]);
    const page = await data.read({ query: '95% accuracy', reportType: 'Report_One', limit: 1 });
    expect(page.data[0].id).toBe('target');
    expect(page.total).toBe(1);
  });

  it('preserves grant agency punctuation and exact status while sharing the count filter', async () => {
    const data = fixture('grants', [
      { ...row('wrong-agency', 'Ordinary'), agency: 'Agency One' },
      { ...row('wrong-status', 'Ordinary'), agency: 'Agency_One', status: 'closed' },
      { ...row('target', 'Ordinary'), agency: 'Agency_One' },
    ]);
    const page = await data.read({ agency: 'Agency_One', status: 'posted', limit: 1 });
    expect(page.data.map((value: Row) => value.id)).toEqual(['target']);
    expect(page.total).toBe(1);
  });
});
