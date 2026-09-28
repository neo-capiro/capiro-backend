import { DefenseResearchService } from './defense-research.service.js';
// Scratch proposal: copy into the existing defense-research test directory only
// after review. Baseline must fail these regression expectations; proposed repair passes.
describe('DefenseResearchService cell evidence and calendar regressions', () => {
  test('binds request proof only to its exact year, stage and current value, retaining unproved figures', async () => {
    const source = {
      id: 'source',
      yearId: 'year',
      fy: 2026,
      sourceDocumentId: 'doc',
      sourceUrl: 'https://official.mil/pb26.pdf',
      pageNumber: 1,
      sourceDocument: {
        sha256: 'a'.repeat(64),
        title: 'PB26',
        sourceKey: 'PB26',
        ingestedAt: new Date('2025-06-01'),
      },
      sourceSpanHash: 'b'.repeat(64),
      metadata: {
        writerVersion: 'procurement_line_writer_v1',
        artifactId: 'artifact',
        artifactContentSha256: 'c'.repeat(64),
        sourcePdfSha256: 'a'.repeat(64),
        fundingField: 'request',
        field: 'request',
        assertionKind: 'funding',
        assertionId: 'request-proof',
        valueMillions: '0.000',
      },
    };
    const year = {
      id: 'year',
      fy: 2026,
      request: '0',
      enacted: '2',
      hascMark: null,
      sascMark: null,
      hacDMark: null,
      sacDMark: null,
      conference: null,
      actuals: null,
      sources: [source],
    };
    const prisma = {
      procurementLine: {
        findUnique: jest.fn(async ({ include }: any) =>
          include ? { id: 'line', title: 'Line', years: [year] } : { id: 'line', title: 'Line' },
        ),
      },
    };
    const service = new DefenseResearchService(prisma as never);
    const cells = (await service.fundingMatrix('budget_line', 'line')).cells;
    expect(cells.find((cell) => cell.basis.stage === 'request')).toMatchObject({
      value: '0',
      disposition: 'observed',
    });
    expect(cells.find((cell) => cell.basis.stage === 'request')?.evidence).toHaveLength(1);
    expect(cells.find((cell) => cell.basis.stage === 'enacted')).toMatchObject({
      value: '2',
      disposition: 'partial',
      evidence: [],
    });
    const originalMetadata = { ...source.metadata };
    for (const change of [
      { writerVersion: 'untrusted' },
      { fundingField: 'enacted' },
      { sourcePdfSha256: 'd'.repeat(64) },
      { artifactContentSha256: '' },
    ]) {
      source.metadata = { ...originalMetadata, ...change };
      expect(
        (await service.fundingMatrix('budget_line', 'line')).cells.find(
          (cell) => cell.basis.stage === 'request',
        ),
      ).toMatchObject({ value: '0', disposition: 'partial', evidence: [] });
    }
    source.metadata = { ...originalMetadata, valueMillions: '1' };
    expect(
      (await service.fundingMatrix('budget_line', 'line')).cells.find(
        (cell) => cell.basis.stage === 'request',
      ),
    ).toMatchObject({ value: '0', disposition: 'partial', evidence: [] });
  });
  test('retains calendar-month fields independently of fiscal fields without fabricating an exact date', async () => {
    const period = {
      id: 'period',
      periodRole: 'planned',
      rawText: 'March 2028',
      periodKind: 'calendar_month',
      fiscalYear: null,
      fiscalQuarter: null,
      calendarYear: 2028,
      calendarMonth: 3,
      calendarQuarter: null,
      exactDate: null,
      rangeStart: null,
      rangeEnd: null,
      sourceUrl: null,
      pageNumber: null,
      metadata: {},
      createdAt: new Date('2026-01-01'),
    };
    const prisma = {
      programElement: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            title: 'PE',
            milestones: [
              {
                id: 'milestone',
                milestoneType: 'Development',
                status: 'planned',
                lastSyncedAt: new Date('2026-01-01'),
                schedulePeriods: [period],
              },
            ],
          }),
      },
    };
    const result = await new DefenseResearchService(prisma as never).milestones(
      'program_element',
      '0600000A',
    );
    expect(result.milestones[0]?.periods[0]).toMatchObject({
      precision: 'calendar_month',
      calendarYear: 2028,
      calendarMonth: 3,
      calendarQuarter: null,
      fiscalYear: null,
      fiscalQuarter: null,
      exactDate: null,
    });
  });
});
