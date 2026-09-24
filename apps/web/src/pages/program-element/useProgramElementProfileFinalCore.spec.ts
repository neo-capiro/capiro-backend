import {
  buildProgramElementProfileCsvRows,
  toProgramElementHistoryRows,
} from './useProgramElementProfileFinalCore.js';

describe('Package 7 program-element export contract', () => {
  const detail = {
    peCode: '0600000A',
    title: 'Evidence-backed example',
    description: null,
    service: 'Army',
    budgetActivity: '4',
    appropriationType: 'RDT&E',
    status: 'active',
    firstSeenFy: 2026,
    lastSyncedAt: '2026-09-24T12:00:00.000Z',
    currentUserIsWatching: false,
    years: [
      {
        id: 'year-1',
        fy: 2027,
        request: '12.50',
        hascMark: null,
        sascMark: null,
        hacDMark: '11.00',
        sacDMark: null,
        conference: null,
        ndaaConference: '12.00',
        enacted: null,
        raw: {
          sourceAttribution: {
            request: 'FY27 R-2 exhibit',
            hacDMark: 'HAC-D report',
          },
          datesAdded: { request: '2026-03-01T00:00:00.000Z' },
        },
      },
    ],
  };

  test('preserves source attribution in history rows', () => {
    expect(toProgramElementHistoryRows(detail.years).at(0)?.sourceAttribution).toEqual({
      request: 'FY27 R-2 exhibit',
      hacDMark: 'HAC-D report',
    });
  });

  test('exports every stage with units, as-of time and attribution status', () => {
    const rows = buildProgramElementProfileCsvRows(
      detail,
      '2026-09-24T13:00:00.000Z',
    );

    expect(rows).toContainEqual(['Generated at', '2026-09-24T13:00:00.000Z']);
    expect(rows).toContainEqual([
      2027,
      'executive proposal',
      'President budget request',
      12.5,
      'USD millions',
      '2026-03-01T00:00:00.000Z',
      'source-attributed',
      'FY27 R-2 exhibit',
    ]);
    expect(rows).toContainEqual([
      2027,
      'appropriations',
      'SAC-D mark',
      null,
      'USD millions',
      '2026-09-24T12:00:00.000Z',
      'not reported',
      null,
    ]);
    expect(rows).toContainEqual([
      2027,
      'authorization',
      'NDAA conference',
      12,
      'USD millions',
      '2026-09-24T12:00:00.000Z',
      'unattributed',
      null,
    ]);
  });
});
