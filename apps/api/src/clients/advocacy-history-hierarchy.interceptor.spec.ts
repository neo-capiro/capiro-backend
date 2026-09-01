import { presentAdvocacyHierarchy } from './advocacy-history-hierarchy.interceptor.js';

describe('Advocacy History Matter / Timeline hierarchy', () => {
  test('uses the Matter title as the record headline while preserving the event and source titles', () => {
    const original = {
      id: 'matter-1',
      title: '2021 first_quarter — BUD',
      records: [
        {
          id: 'record-1',
          recordType: 'federal_lobbying',
          sourceType: 'lda',
          title: 'FY2022 NDAA — GBSD & Space Propulsion',
          status: 'LDA · Q1 2021 · BUD',
          metadata: {
            presentation: {
              sourceTitle: '2021 first_quarter — BUD',
              sourceStatus: 'Q1',
              topics: ['FY2022 NDAA', 'GBSD', 'Space Propulsion'],
            },
          },
        },
      ],
    };

    const presented = presentAdvocacyHierarchy(
      '/api/clients/client-1/advocacy-matters/matter-1',
      original,
    ) as {
      title: string;
      records: Array<{
        title: string;
        status: string;
        metadata: {
          presentation: {
            matterTitle: string;
            eventTitle: string;
            sourceTitle: string;
            topics: string[];
          };
        };
      }>;
    };

    expect(presented.title).toBe('2021 first_quarter — BUD');
    expect(presented.records[0]?.title).toBe('2021 first_quarter — BUD');
    expect(presented.records[0]?.status).toBe('LDA · Q1 2021 · BUD');
    expect(presented.records[0]?.metadata.presentation.matterTitle).toBe('2021 first_quarter — BUD');
    expect(presented.records[0]?.metadata.presentation.eventTitle).toBe(
      'FY2022 NDAA — GBSD & Space Propulsion',
    );
    expect(presented.records[0]?.metadata.presentation.sourceTitle).toBe(
      '2021 first_quarter — BUD',
    );
    expect(presented.records[0]?.metadata.presentation.topics).toContain('GBSD');

    // Read presentation is non-destructive: callers that hold the durable
    // service result still see its original record title.
    expect(original.records[0]?.title).toBe('FY2022 NDAA — GBSD & Space Propulsion');
  });

  test('applies the same hierarchy to non-LDA records without losing their event title', () => {
    const presented = presentAdvocacyHierarchy(
      '/api/clients/client-1/advocacy-matters/matter-1',
      {
        title: 'FY27 Ground Robotics Funding',
        records: [
          {
            id: 'meeting-1',
            recordType: 'advocacy_meeting',
            sourceType: 'meeting',
            title: 'Meeting with HASC staff',
            metadata: {},
          },
        ],
      },
    ) as {
      records: Array<{
        title: string;
        metadata: { presentation: { matterTitle: string; eventTitle: string } };
      }>;
    };

    expect(presented.records[0]?.title).toBe('FY27 Ground Robotics Funding');
    expect(presented.records[0]?.metadata.presentation.eventTitle).toBe('Meeting with HASC staff');
  });

  test('turns LDA timeline rows into dated events instead of a second Matter headline', () => {
    const presented = presentAdvocacyHierarchy(
      '/api/clients/client-1/advocacy-matters/timeline',
      [
        {
          id: 'record-1',
          kind: 'record',
          subtype: 'federal_lobbying',
          title: 'Federal budget & appropriations — Q1 2021',
          date: '2021-04-19T00:00:00.000Z',
          matterId: 'matter-1',
          matterTitle: '2021 first_quarter — BUD',
        },
      ],
    ) as Array<{ title: string; matterTitle: string }>;

    expect(presented[0]?.title).toBe('Quarterly lobbying disclosure — Q1 2021');
    expect(presented[0]?.matterTitle).toBe('2021 first_quarter — BUD');
  });

  test('preserves specific non-LDA event titles on Timeline', () => {
    const entry = {
      id: 'meeting-1',
      kind: 'record',
      subtype: 'advocacy_meeting',
      title: 'Meeting with HASC staff',
      date: '2026-01-18T00:00:00.000Z',
      matterId: 'matter-1',
      matterTitle: 'FY27 Ground Robotics Funding',
    };

    const presented = presentAdvocacyHierarchy(
      '/api/clients/client-1/advocacy-matters/timeline',
      [entry],
    ) as Array<typeof entry>;

    expect(presented[0]).toEqual(entry);
  });

  test('leaves the Matters list and Federal Register correlation responses untouched', () => {
    const matters = [{ id: 'matter-1', title: 'FY27 Ground Robotics Funding' }];
    expect(
      presentAdvocacyHierarchy('/api/clients/client-1/advocacy-matters', matters),
    ).toBe(matters);

    const correlations = [{ documentNumber: '2026-1234', title: 'Final rule' }];
    expect(
      presentAdvocacyHierarchy(
        '/api/clients/client-1/advocacy-matters/matter-1/federal-register-correlations',
        correlations,
      ),
    ).toBe(correlations);
  });
});
