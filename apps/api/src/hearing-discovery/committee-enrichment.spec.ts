import type { PrismaClient } from '@prisma/client';
import { CommitteeSiteAdapter } from './adapters/committee-site.adapter.js';
import { insertSiteUpdates } from './canonical-hearing.repository.js';
import type { CommitteeSourceRepository } from './committee-source.repository.js';
jest.mock('./canonical-hearing.repository.js', () => ({
  ...jest.requireActual('./canonical-hearing.repository.js'),
  insertSiteUpdates: jest.fn(async () => 1),
}));
import { DiscoveryJobsService } from './discovery-jobs.service.js';
describe('bounded recent committee enrichment', () => {
  it('rotates the completed window while preserving canonical federal scope and the total cap', async () => {
    const findMany = jest.fn(async () => []);
    const count = jest.fn(async () => 113);
    const jobs = new DiscoveryJobsService({
      committeeHearing: { findMany, count },
    } as unknown as PrismaClient);
    await jobs.enrichCommitteeHearings({ now: new Date('2026-10-06T12:00:00Z'), limit: 200 });
    await jobs.enrichCommitteeHearings({ now: new Date('2026-10-06T12:30:00Z'), limit: 200 });
    const calls = findMany.mock.calls as unknown as Array<[Record<string, any>]>;
    expect(calls[0]![0].take).toBe(150);
    expect(calls[1]![0]).toMatchObject({
      take: 50,
      where: { geographicJurisdiction: 'US', canonicalHearingId: null, eventStatus: 'completed' },
    });
    expect(calls[1]![0].skip).not.toBe(calls[3]![0].skip);
    expect(calls[1]![0].where.date.gte.toISOString()).toBe('2026-09-06T00:00:00.000Z');
  });
});

it('enriches a verified completed event and persists specifically attributed testimony', async () => {
  const url = 'https://www.armed-services.senate.gov/hearings/golden-dome';
  const row = {
    id: 'sen-119-338758',
    congress: 119,
    chamber: 'Senate',
    committeeSystemCode: 'ssas00',
    subcommitteeSystemCode: 'ssas16',
    committeeCode: null,
    committeeName: 'Armed Services',
    title: 'Golden Dome',
    date: new Date('2026-09-29'),
    startsAt: new Date('2026-09-29T20:00:00Z'),
    url: 'https://www.congress.gov/event/119th-Congress/senate-event/338758',
  };
  const source = {
    id: 'source',
    adapterKey: 'committee-site',
    sourceUrl: 'https://www.armed-services.senate.gov/',
  };
  const db = {
    committeeHearing: {
      findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row]),
      count: jest.fn(async () => 1),
      findUnique: jest.fn(async () => ({ witnesses: [] })),
      update: jest.fn(),
    },
    hearingSourceObservation: {
      findMany: jest.fn(async () => [
        {
          source,
          sourceMetadata: {
            event: {
              ...row,
              calendarDate: row.date.toISOString(),
              startsAt: row.startsAt.toISOString(),
              officialPageUrl: url,
            },
          },
        },
      ]),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  };
  const sources = { listEnabled: jest.fn(async () => [source]), recordOutcome: jest.fn() };
  const enrich = jest.spyOn(CommitteeSiteAdapter.prototype, 'enrichEvent').mockResolvedValue({
    witnesses: ['Dr. Thomas O. Karako'],
    documents: [
      {
        title: 'Witness testimony: Dr. Thomas O. Karako',
        url: source.sourceUrl + 'download/testimony/karako-opening-statement',
        publishedAt: null,
      },
    ],
  });
  try {
    const result = await new DiscoveryJobsService(db as unknown as PrismaClient, {
      sources: sources as unknown as CommitteeSourceRepository,
    }).enrichCommitteeHearings({ now: new Date('2026-10-06'), delayMs: 0 });
    expect(result).toMatchObject({ updated: 1, inserted: 1, errors: 0 });
    expect(enrich.mock.calls[0]?.[1].officialPageUrl).toBe(url);
    expect(jest.mocked(insertSiteUpdates).mock.calls.at(-1)?.[1]).toEqual([
      expect.objectContaining({
        hearingId: row.id,
        committeeSystemCode: 'ssas00',
        updateType: 'witness_testimony_published',
        normalizedTitle: 'Witness testimony: Dr. Thomas O. Karako',
      }),
    ]);
  } finally {
    enrich.mockRestore();
  }
});
