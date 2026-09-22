import type { PrismaClient } from '@prisma/client';
import {
  backfillFloridaArchiveSessions,
  floridaArchiveCliWindow,
  floridaArchivePageBefore,
  type FloridaArchiveReport,
} from './florida-archive-discovery.js';
import { defaultFloridaRegularSessions } from './florida-calendar-discovery.js';

function archiveReport(overrides: Partial<FloridaArchiveReport> = {}): FloridaArchiveReport {
  return {
    pages: 1,
    listed: 1,
    accepted: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rejected: [],
    ambiguous: [],
    issues: [],
    errors: 0,
    catalog: { rows: 0, attached: 0, reported: 0, failures: 0 },
    ...overrides,
  };
}

describe('Florida recurring archive runtime', () => {
  it('archives both fall sessions and deduplicates a multiply-tagged TFC video', async () => {
    const sessions = defaultFloridaRegularSessions(new Date('2027-10-15T12:00:00Z'));
    const calls: Array<{
      session: string;
      catalog: boolean | undefined;
      seen: Set<number>;
    }> = [];
    const dependency = jest.fn(async (_prisma: PrismaClient, options: any) => {
      const duplicate = options.seenVideoIds.has(80615);
      options.seenVideoIds.add(80615);
      calls.push({
        session: options.session,
        catalog: options.catalog,
        seen: options.seenVideoIds,
      });
      return {
        archive: archiveReport({
          accepted: duplicate ? 0 : 1,
          inserted: duplicate ? 0 : 1,
          unchanged: duplicate ? 1 : 0,
        }),
        notices: null,
      };
    });

    const metrics = await backfillFloridaArchiveSessions(
      {} as PrismaClient,
      {
        sessions,
        from: '2027-09-01',
        to: '2027-10-15',
        catalog: true,
        delayMs: 0,
      },
      dependency,
    );

    expect(calls.map(({ session, catalog }) => ({ session, catalog }))).toEqual([
      { session: '2027', catalog: true },
      { session: '2028', catalog: false },
    ]);
    expect(calls[0]!.seen).toBe(calls[1]!.seen);
    expect(metrics).toMatchObject({
      archiveSessions: 2,
      archiveSessionsCompleted: 2,
      archiveAccepted: 1,
      archiveInserted: 1,
      archiveUnchanged: 1,
      archivePartial: false,
    });
  });

  it('surfaces errors, issues, ambiguity, and catalog failures as flat partial metrics', async () => {
    const metrics = await backfillFloridaArchiveSessions(
      {} as PrismaClient,
      {
        sessions: ['2027'],
        from: '2027-09-01',
        to: '2027-09-30',
        catalog: true,
      },
      async () => ({
        archive: archiveReport({
          errors: 2,
          issues: ['publisher parse issue'],
          ambiguous: ['two possible proceedings'],
          catalog: { rows: 4, attached: 1, reported: 2, failures: 1 },
        }),
        notices: null,
      }),
    );

    expect(metrics).toEqual(
      expect.objectContaining({
        archiveErrors: 2,
        archiveIssues: 1,
        archiveAmbiguous: 1,
        archiveCatalogFailures: 1,
        archiveCatalogReported: 2,
        archivePartial: true,
      }),
    );
    expect(Object.values(metrics).every((value) => typeof value !== 'object')).toBe(true);
  });

  it('stops a newest-first TFC walk only when every publisher row is older', () => {
    expect(
      floridaArchivePageBefore(
        [{ date: '2027-08-31T23:00:00' }, { date: '2027-08-01T09:00:00' }],
        '2027-09-01',
      ),
    ).toBe(true);
    expect(
      floridaArchivePageBefore(
        [{ date: '2027-09-01T00:00:00' }, { date: '2027-08-01T09:00:00' }],
        '2027-09-01',
      ),
    ).toBe(false);
    expect(floridaArchivePageBefore([{ date: 'unknown' }], '2027-09-01')).toBe(false);
  });

  it('uses the Tallahassee calendar day for the manual default window', () => {
    expect(floridaArchiveCliWindow([], new Date('2027-09-01T02:00:00Z'))).toEqual({
      from: '2027-08-02',
      to: '2027-08-31',
      lookbackDays: 30,
    });
  });
});
