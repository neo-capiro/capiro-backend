import { MeriToolsService } from './meri-tools.service.js';

type Row = Record<string, unknown>;
const economic = MeriToolsService.prototype as unknown as {
  queryEconomicData(input: Record<string, unknown>): Promise<any>;
};
const beaRow = (geoFips: string | null, value: number, overrides: Row = {}) => ({
  datasetName: 'Regional', tableName: 'SAGDP1', description: 'Gross domestic product',
  year: 2025, period: 'Annual', value, units: 'Millions of dollars', geoFips, ...overrides,
});

/** Evaluate the emitted bound query before its limit, so a missing filter
 * returns a wrong-state record rather than merely failing a mock assertion. */
function source(rows: Row[]) {
  const queries: Row[] = [];
  const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]: any) => {
    if (key === 'OR') return value.some((part: Row) => matches(row, part));
    if (key === 'dataPoints') return (row.dataPoints as Row[]).some(point => matches(point, value.some));
    return typeof value === 'object' && value?.contains !== undefined
      ? String(row[key]).toLowerCase().includes(value.contains.toLowerCase()) : row[key] === value;
  });
  const findMany = jest.fn(async (query: any) => {
    queries.push(query);
    return rows.filter(row => matches(row, query.where)).slice(0, query.take).map(row =>
      query.include?.dataPoints ? { ...row, dataPoints: (row.dataPoints as Row[])
        .filter(point => matches(point, query.include.dataPoints.where ?? {}))
        .slice(0, query.include.dataPoints.take) } : row);
  });
  const service = Object.create(MeriToolsService.prototype);
  Object.assign(service, { prisma: { withSystem: async (read: any) => read({
    beaData: { findMany }, blsSeries: { findMany }, censusDistrict: { findMany },
  }) } });
  return { read: (input: Record<string, unknown>) => economic.queryEconomicData.call(service, input), findMany, queries };
}

describe('economic source geography', () => {
  it('filters exact Regional state totals before the page limit, excluding other states and counties', async () => {
    const rows = [...Array.from({ length: 60 }, (_, i) => beaRow('37000', i)),
      beaRow('12001', 900), beaRow('12000', 1700000), beaRow('12000', 12, { year: 2024 })];
    const fixture = source(rows);
    const page = await fixture.read({ source: 'bea', datasetName: 'Regional', state: 'FL', year: 2025, limit: 1 });
    expect(page.data).toEqual([expect.objectContaining({ value: 1700000, geoFips: '12000', state: 'FL' })]);
    expect(page.appliedState).toBe('FL');
    expect(fixture.queries[0]).toMatchObject({ where: { datasetName: 'Regional', geoFips: '12000', year: 2025 }, take: 1 });
  });

  it.each([['AL', '01000'], ['DE', '10000'], ['DC', '11000'], ['PR', '72000'], ['GU', '66000'], ['VI', '78000']])(
    'reuses source FIPS identity for %s without dropping leading zeroes or territories', async (state, geoFips) => {
      const fixture = source([beaRow('00000', 10), beaRow(geoFips!, 20)]);
      const page = await fixture.read({ source: 'BEA', state: state!.toLowerCase(), limit: 1 });
      expect(page.data).toEqual([expect.objectContaining({ value: 20, geoFips, state })]);
      expect(page.appliedState).toBe(state);
      expect(fixture.queries[0]).toMatchObject({ where: { datasetName: 'Regional', geoFips } });
    },
  );

  it('preserves the dataset alias and proves an applied state even when no stored row exists', async () => {
    const page = await source([beaRow('37000', 5)]).read({ source: 'bea', dataset: 'Regional', state: ' FL ' });
    expect(page.data).toEqual([]);
    expect(page.appliedState).toBe('FL');
  });

  it('projects source geography without inventing a state from county, national or missing codes', async () => {
    const page = await source([beaRow('12000', 1), beaRow('12001', 2), beaRow('00000', 3), beaRow('', 4), beaRow(null, 5)])
      .read({ source: 'bea', datasetName: 'Regional' });
    expect(page.data.map((row: any) => [row.geoFips, row.state])).toEqual([
      ['12000', 'FL'], ['12001', null], ['00000', null], ['', null], [null, null],
    ]);
    expect(page).not.toHaveProperty('appliedState');
  });

  it('preserves unscoped national reads and never labels their rows with a requested geography', async () => {
    const fixture = source([beaRow('', 20, { datasetName: 'NIPA' })]);
    const page = await fixture.read({ source: 'bea', datasetName: 'NIPA', state: ' ', district: null });
    expect(page.data).toEqual([expect.objectContaining({ value: 20, geoFips: '', state: null })]);
    expect(page).not.toHaveProperty('appliedState');
    expect(fixture.queries[0]).toMatchObject({ where: { datasetName: 'NIPA' } });
  });

  it.each([
    { source: 'bea', state: 'ZZ' },
    { source: 'bea', datasetName: 'NIPA', state: 'FL' },
    { source: 'bea', dataset: 'Industry', state: 'FL' },
    { source: 'bea', district: '01' },
    { source: 'bls', state: 'FL' },
    { source: 'bls', district: '01' },
    { source: 'bls', datasetName: 'NIPA' },
    { source: 'bea', seriesId: 'BLS-SERIES' },
    { source: 'census', seriesId: 'BLS-SERIES' },
    { source: 'census', query: 'income' },
    { source: 'census', dataset: 'Regional' },
    { source: 'census', year: 0 },
  ])('refuses unsupported source selectors before reading rows: %j', async input => {
    const fixture = source([]);
    await expect(fixture.read(input)).rejects.toMatchObject({ status: 400 });
    expect(fixture.findMany).not.toHaveBeenCalled();
  });

  it.each([0, '0', 2025, '2025', -2147483648, 2147483647])('honors the admitted BEA year %j including zero', async selected => {
    const year = Number(selected), fixture = source([beaRow('', 10, { datasetName: 'NIPA', year: year + 1 }),
      beaRow('', 20, { datasetName: 'NIPA', year })]);
    const page = await fixture.read({ source: 'bea', datasetName: 'NIPA', year: selected, limit: 1 });
    expect(page.data.map((row: any) => row.value)).toEqual([20]);
    expect(page.appliedYear).toBe(year);
  });

  it.each([false, {}, [], 'not-a-year', 1.2, -2147483649, 2147483648])('rejects invalid nonblank year %j before a read', async year => {
    const fixture = source([]);
    await expect(fixture.read({ source: 'bea', year })).rejects.toMatchObject({ status: 400 });
    expect(fixture.findMany).not.toHaveBeenCalled();
  });

  it.each([false, 12, [], {}])('rejects invalid nonnull state type %j before a read', async state => {
    const fixture = source([]);
    await expect(fixture.read({ source: 'bea', state })).rejects.toMatchObject({ status: 400 });
    expect(fixture.findMany).not.toHaveBeenCalled();
  });

  it('filters BLS series and their data points by year before either limit', async () => {
    const series = (id: string, years: number[]) => ({ id, title: 'Synthetic employment', surveyName: 'Synthetic survey',
      periodType: 'Monthly', dataPoints: years.map((year, index) => ({ year, period: `M${index + 1}`, value: year * 100 + index })) });
    const fixture = source([series('wrong-year', [2024]), series('selected', [2026, 2025, 2024])]);
    const page = await fixture.read({ source: 'bls', query: 'employment', year: 2025, limit: 1 });
    expect(page.appliedYear).toBe(2025);
    expect(page.data.map((row: any) => [row.seriesId, row.recentDataPoints])).toEqual([
      ['selected', [{ year: 2025, period: 'M2', value: 202501 }]],
    ]);
  });

  it('binds empty BLS and BEA year pages, including zero', async () => {
    for (const family of ['bls', 'bea']) {
      const page = await source([]).read({ source: family, year: 0 });
      expect(page.data).toEqual([]);
      expect(page.appliedYear).toBe(0);
    }
  });

  it('preserves null/blank selectors and the existing BLS twelve-point window', async () => {
    const points = Array.from({ length: 15 }, (_, i) => ({ year: 2025, period: `M${i}`, value: i }));
    const fixture = source([{ id: 'selected', title: 'Synthetic', surveyName: null, periodType: 'Monthly', dataPoints: points }]);
    const page = await fixture.read({ source: 'bls', seriesId: 'selected', state: null, district: ' ', dataset: '', year: ' ' });
    expect(page.data[0].recentDataPoints).toEqual(points.slice(0, 12));
    expect(page).not.toHaveProperty('appliedYear');
  });

  it('preserves Census state and district filters', async () => {
    const fixture = source([{ id: 'synthetic-nc', state: 'NC', district: '01' },
      { id: 'synthetic-fl', state: 'FL', district: '01' }]);
    const page = await fixture.read({ source: 'census', state: 'fl', district: '01' });
    expect(page.data.map((row: any) => row.id)).toEqual(['synthetic-fl']);
    expect(page).not.toHaveProperty('appliedState');
  });

  it('propagates source failures instead of returning an empty page', async () => {
    const fixture = source([]), failure = new Error('synthetic source unavailable');
    fixture.findMany.mockRejectedValueOnce(failure);
    await expect(fixture.read({ source: 'bea', state: 'FL' })).rejects.toBe(failure);
  });
});
