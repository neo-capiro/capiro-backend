import { DefenseResearchService } from './defense-research.service.js';

const at = new Date('2026-09-01T00:00:00Z');
const office = (extra: Record<string, unknown> = {}) => ({
  id: 'office',
  name: 'Office',
  officeType: 'pm',
  service: 'ARMY',
  parentOfficeId: null,
  parentOffice: null,
  status: 'active',
  validFrom: null,
  validTo: null,
  metadata: {},
  createdAt: at,
  updatedAt: at,
  sourceUrl: null,
  roles: [],
  programLinks: [],
  ...extra,
});
const service = (prisma: Record<string, unknown>) => new DefenseResearchService(prisma as never);
// Deliberately apply the submitted Prisma predicates before sorting, paging and
// counting. This exercises returned records and totals rather than a DTO-only
// filter that could hide a wrong native query after the 50-row limit.
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'AND') return value.every((v: any) => matches(row, v));
    if (key === 'OR') return value.some((v: any) => matches(row, v));
    if (key === 'sourceUrl')
      return value && typeof value === 'object'
        ? row.sourceUrl !== value.not
        : row.sourceUrl === value;
    if (key === 'id' && value && Array.isArray(value.in)) return value.in.includes(row.id);
    if (key === 'service') return row.service.toLowerCase() === value.equals.toLowerCase();
    return row[key] === value;
  });
}
function directory(rows: any[]) {
  const count = jest.fn(async ({ where }: any) => rows.filter((row) => matches(row, where)).length);
  const findMany = jest.fn(async ({ where, skip, take }: any) =>
    rows
      .filter((row) => matches(row, where))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(skip, skip + take),
  );
  return { reader: service({ programOffice: { count, findMany } }), count, findMany };
}
const period = (extra: Record<string, unknown> = {}) => ({
  id: 'period',
  periodRole: 'planned',
  rawText: 'Q2 FY2028',
  periodKind: 'fiscal_quarter',
  fiscalYear: 2028,
  fiscalQuarter: 2,
  calendarYear: null,
  calendarMonth: null,
  calendarQuarter: null,
  exactDate: null,
  rangeStart: null,
  rangeEnd: null,
  sourceUrl: 'https://example.invalid/owned-source.pdf',
  pageNumber: 3,
  sourceDocumentId: 'opaque-existing-source',
  sourceDocument: {
    sha256: 'a'.repeat(64),
    title: 'Owned source',
    sourceKey: 'owned-edition',
    ingestedAt: at,
  },
  createdAt: at,
  ...extra,
});
function schedule(periods: any[]) {
  return service({
    programElement: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          title: 'Synthetic PE',
          milestones: [
            {
              id: 'milestone',
              milestoneType: 'Testing',
              status: 'planned',
              lastSyncedAt: at,
              schedulePeriods: periods,
            },
          ],
        }),
    },
  });
}

describe('Defense research read honesty', () => {
  afterEach(() => jest.useRealTimers());
  test('partial filters select only the partial rows before paging and counting', async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) =>
        office({
          id: 'available-' + i,
          name: 'A' + String(i).padStart(2, '0'),
          sourceUrl: 'https://example.invalid/' + i,
        }),
      ),
      office({ id: 'missing', name: 'Z1' }),
      office({ id: 'empty', name: 'Z2', sourceUrl: '' }),
    ];
    const { reader, findMany, count } = directory(rows);
    const result = await reader.listOffices({
      availability: 'partial',
      page: 2,
      limit: 1,
      agency: 'ARMY',
    });
    expect(result).toMatchObject({
      total: 2,
      page: 2,
      items: [{ id: 'empty', availability: 'partial' }],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 1,
        take: 1,
        where: expect.objectContaining({ service: { equals: 'ARMY', mode: 'insensitive' } }),
      }),
    );
    const findCall = findMany.mock.calls[0],
      countCall = count.mock.calls[0];
    expect(findCall).toBeDefined();
    expect(countCall).toBeDefined();
    if (!findCall || !countCall) throw new Error('Expected native count and page query calls');
    expect(findCall[0].where).toEqual(countCall[0].where);
  });
  test('available is metadata availability while URL-only proof remains partial', async () => {
    const result = await directory([
      office({ id: 'url', sourceUrl: 'https://example.invalid/context' }),
      office({ id: 'missing' }),
      office({ id: 'empty', sourceUrl: '' }),
    ]).reader.listOffices({ availability: 'available' });
    expect(result).toMatchObject({
      total: 1,
      items: [
        {
          id: 'url',
          availability: 'available',
          evidence: [{ availability: 'partial', contentHash: null, sourceDocumentId: null }],
        },
      ],
    });
  });
  test('unavailable returns no persisted rows when every persisted office is available or partial', async () => {
    const result = await directory([
      office(),
      office({ sourceUrl: 'https://example.invalid/context' }),
    ]).reader.listOffices({ availability: 'unavailable' });
    expect(result).toMatchObject({ total: 0, items: [] });
  });
  test('speculative parent edges are visible only with explicit inclusion', async () => {
    const reader = service({
      programOffice: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            office({ parentOffice: { id: 'parent', name: 'Parent', service: 'ARMY' } }),
          ]),
      },
    });
    expect(await reader.getRelationships({ includeSpeculative: false })).toMatchObject({
      total: 0,
      items: [],
    });
    expect(await reader.getRelationships({ includeSpeculative: true })).toMatchObject({
      total: 1,
      items: [{ reviewStatus: 'candidate', sourceStated: false, evidence: [] }],
    });
  });
  test('accepted future roles are unresolved until their effective start and ordinary current roles remain valid', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const role = (id: string, start: string, end: string | null = null) => ({
      id,
      person: { id: 'person-' + id, fullName: id },
      program: null,
      reviewStatus: 'accepted',
      source: 'owned_directory',
      sourceUrl: 'https://example.invalid/role',
      observedAt: at,
      effectiveStart: new Date(start),
      effectiveEnd: end ? new Date(end) : null,
    });
    const reader = service({
      programOffice: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            office({
              roles: [
                role('future', '2027-01-01'),
                role('current', '2026-09-01'),
                role('past', '2025-01-01', '2026-08-01'),
              ],
            }),
          ]),
      },
    });
    const result = await reader.getRelationships({});
    expect(result.items.find((row) => row.id === 'person-role:future')).toMatchObject({
      validity: 'unresolved',
      reviewStatus: 'accepted',
      supersessionImpact: expect.stringContaining('effective start'),
    });
    expect(result.items.find((row) => row.id === 'person-role:current')).toMatchObject({
      validity: 'valid',
    });
    expect(result.items.find((row) => row.id === 'person-role:past')).toMatchObject({
      validity: 'superseded',
    });
  });
  test.each([
    {
      periodKind: 'text_only',
      rawText: 'TBD',
      sourceUrl: null,
      sourceDocument: null,
      sourceDocumentId: null,
    },
    { periodKind: 'unknown', rawText: 'Unknown' },
    { fiscalQuarter: 0 },
    { fiscalQuarter: 5 },
    { fiscalYear: null },
    { periodKind: 'exact_date', exactDate: null },
    { periodKind: 'calendar_month', calendarYear: 2028, calendarMonth: 13 },
    { periodKind: 'range', rangeStart: new Date('2028-02-01'), rangeEnd: new Date('2028-01-01') },
    { pageNumber: 0 },
    { pageNumber: -1 },
    { sourceDocument: { sha256: 'not-an-archive-digest' } },
    { sourceDocumentId: null },
  ])(
    'preserves raw milestone and history but marks invalid or unproven schedule partial %j',
    async (extra) => {
      const raw = period(extra);
      const result = await schedule([raw]).milestones('program_element', '0600000A');
      expect(result.coverage).toMatchObject({ state: 'partial', reason: expect.any(String) });
      expect(result.milestones).toHaveLength(1);
      expect(result.milestones[0]?.periods[0]?.rawText).toBe(raw.rawText);
      expect(result.milestones[0]?.history[0]?.periods).toEqual(result.milestones[0]?.periods);
    },
  );
  test.each([
    {},
    { periodKind: 'exact_date', exactDate: new Date('2028-03-02') },
    { periodKind: 'calendar_month', calendarYear: 2028, calendarMonth: 3 },
    { periodKind: 'calendar_quarter', calendarYear: 2028, calendarQuarter: 2 },
    { periodKind: 'fiscal_year', fiscalYear: 2028 },
    { periodKind: 'range', rangeStart: new Date('2028-02-01'), rangeEnd: new Date('2028-03-01') },
  ])(
    'retains available typed schedule with immutable archived positive page proof %j',
    async (extra) => {
      const result = await schedule([period(extra)]).milestones('program_element', '0600000A');
      expect(result.coverage).toEqual({ state: 'available', reason: null });
      expect(result.milestones[0]?.periods[0]?.evidence[0]).toMatchObject({
        contentHash: 'a'.repeat(64),
        sourceDocumentId: 'opaque-existing-source',
        nativeLocator: { page: 3 },
        availability: 'available',
      });
    },
  );
  test('mixed supported and raw schedules are partial, and no periods cannot imply availability', async () => {
    expect(
      (
        await schedule([
          period(),
          period({ id: 'unqualified', periodKind: 'text_only', rawText: 'TBD' }),
        ]).milestones('program_element', '0600000A')
      ).coverage.state,
    ).toBe('partial');
    expect((await schedule([]).milestones('program_element', '0600000A')).coverage.state).toBe(
      'partial',
    );
    const empty = service({
      programElement: {
        findUnique: jest.fn().mockResolvedValue({ title: 'Synthetic PE', milestones: [] }),
      },
    });
    expect((await empty.milestones('program_element', '0600000A')).coverage).toMatchObject({
      state: 'unavailable',
    });
  });
});
