/**
 * Official-time observation job — unit + contract specs.
 *
 * Proves: manual-only refusal; hard-rule evidence gating (no zone statement →
 * honest skip, never a coerced correction); identity-guard semantics; and that
 * a "1:00 PM PT" statement reconciles into the ledger as an explicit_local
 * observation for the SAME hearing. Prisma is mocked; no DB.
 */
import { LegiWatchPhase9OfficialTimeObservationService } from './legiwatch-phase9-official-time-observation.service.js';
import { cleanTextSafe, extractExplicitLocalTime } from './official-time-evidence.js';
import { resolveSourceTime } from '../../hearing-discovery/hearing-time.js';
import type { SourceEvent } from '../../hearing-discovery/hearing-discovery.types.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import 'reflect-metadata';

function prismaMock(rows: unknown[], sources: unknown[] = []): never {
  return {
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (String(sql).includes('FROM federal_committee_hearing')) return rows;
      if (String(sql).includes('FROM committee_source')) return sources;
      return [];
    }),
  } as never;
}

const HEARING_ROW = {
  id: 'cm-119-119533',
  title: 'Industrial Base and Workforce Development for Skilled Trades',
  url: 'https://www.congress.gov/event/119th-Congress/house-event/119533',
  chamber: 'House',
  congress: 119,
  committee_system_code: 'hswm00',
  committee_code: 'hswm00',
  starts_at: new Date('2026-09-04T17:00:00.000Z'),
  date: new Date('2026-09-04T00:00:00.000Z'),
  timezone: 'America/New_York',
};

const SOURCE_ROW = {
  id: 'src-committee-site-1',
  committeeSystemCode: 'hswm00',
  chamber: 'house',
  sourceType: 'COMMITTEE_SITE',
  sourceUrl: 'https://waysandmeans.house.gov/hearings/',
  adapterKey: 'committee-site',
  priority: 40,
  parserVersion: null,
};

const ANNOUNCEMENT = `
  <html><body>
  <h1>Field Hearing — Industrial Base and Workforce Development for Skilled Trades</h1>
  <p>Friday, September 4, 2026 at 1:00 PM PT<br/>
  College of the Canyons, Performing Arts Center, Santa Clarita, California</p>
  </body></html>
`;

describe('official-time-observation (manual-only field-hearing correction path)', () => {
  it('refuses to run without manual=true', async () => {
    const svc = new LegiWatchPhase9OfficialTimeObservationService(prismaMock([]));
    await expect(svc.run({ manual: false })).rejects.toThrow(/manual-only/i);
  });

  it('is DI-injectable: PrismaService param metadata is emitted for Nest', () => {
    // PR #1398 lesson: unit specs construct the service directly, so green tests
    // never exercise Nest DI. Assert design:paramtypes metadata explicitly.
    const designParamtypes = 'design:paramtypes';
    expect(
      Reflect.hasOwnMetadata(designParamtypes, LegiWatchPhase9OfficialTimeObservationService),
    ).toBe(true);
    expect(
      Reflect.getMetadata(designParamtypes, LegiWatchPhase9OfficialTimeObservationService)[0],
    ).toBe(PrismaService);
  });

  it('REPORT_ONLY lists candidates without fetching or writing', async () => {
    const prisma = prismaMock([HEARING_ROW], [SOURCE_ROW]);
    const svc = new LegiWatchPhase9OfficialTimeObservationService(prisma);
    const result = await svc.run({ manual: true, reportOnly: true });
    expect(result.mode).toBe('REPORT_ONLY');
    expect(result.scanned).toBe(1);
    expect(result.candidates[0]?.classification).toBe('PENDING');
  });

  it('reconciles an explicit "1:00 PM PT" announcement into the ledger for the SAME hearing', async () => {
    const prisma = prismaMock([HEARING_ROW], [SOURCE_ROW]);
    const reconcileEvent = jest.fn(async (_source: unknown, event: SourceEvent) => ({
      hearingId: HEARING_ROW.id,
      match: 'observation' as const,
      observationCreated: true,
      observationChanged: false,
      hearingCreated: false,
      changedFields: ['startsAt', 'timezone'],
      filledFields: [],
      siteUpdatesInserted: 0,
      streamCandidatesCreated: 0,
    }));
    const fetchModule = await import('../../hearing-discovery/adapters/source-http.js');
    const fetchTextSpy = jest
      .spyOn(fetchModule, 'fetchText')
      .mockResolvedValue({ ok: true, status: 200, body: ANNOUNCEMENT, durationMs: 5 } as never);

    const svc = new LegiWatchPhase9OfficialTimeObservationService(prisma);
    const result = await svc.run({
      manual: true,
      reconcilerFactory: () => ({ reconcileEvent }),
    });
    fetchTextSpy.mockRestore();

    expect(result.observed).toBe(1);
    const candidate = result.candidates[0]!;
    expect(candidate.classification).toBe('EXPLICIT_LOCAL_OBSERVED');
    expect(candidate.derivedStartsAt).toBe('2026-09-04T20:00:00.000Z');
    expect(candidate.derivedTimeZone).toBe('America/Los_Angeles');
    // The reconciled event carries the explicit-local authority + evidence.
    const event = reconcileEvent.mock.calls[0]![1] as SourceEvent;
    expect(event.timeAuthority).toBe('explicit_local');
    expect(event.timeZone).toBe('America/Los_Angeles');
    expect((event.startsAt as Date).toISOString()).toBe('2026-09-04T20:00:00.000Z');
    expect((event.raw as Record<string, unknown>).announcementSnippet).toBeTruthy();
  });

  it('honestly skips a page WITHOUT an explicit zone statement (no coerced correction)', async () => {
    const prisma = prismaMock([HEARING_ROW], [SOURCE_ROW]);
    const reconcileEvent = jest.fn(async (_s: unknown, _e: unknown) => ({
      hearingId: 'x',
      match: 'observation' as const,
      observationCreated: true,
      observationChanged: false,
      hearingCreated: false,
      changedFields: [],
      filledFields: [],
      siteUpdatesInserted: 0,
      streamCandidatesCreated: 0,
    }));
    const fetchModule = await import('../../hearing-discovery/adapters/source-http.js');
    const fetchTextSpy = jest.spyOn(fetchModule, 'fetchText').mockResolvedValue({
      ok: true,
      status: 200,
      body: '<p>Hearing at 1:00 PM, College of the Canyons, Santa Clarita, California.</p>',
    } as never);
    const svc = new LegiWatchPhase9OfficialTimeObservationService(prisma);
    const result = await svc.run({ manual: true, reconcilerFactory: () => ({ reconcileEvent }) });
    fetchTextSpy.mockRestore();
    expect(result.noZoneEvidence).toBe(1);
    expect(result.candidates[0]?.classification).toBe('NO_ZONE_EVIDENCE');
    expect(reconcileEvent).not.toHaveBeenCalled();
  });

  it('refuses a correction that resolves to a DIFFERENT canonical hearing', async () => {
    const prisma = prismaMock([HEARING_ROW], [SOURCE_ROW]);
    const reconcileEvent = jest.fn(async () => ({
      hearingId: 'cm-119-OTHER',
      match: 'observation' as const,
      observationCreated: true,
      observationChanged: false,
      hearingCreated: false,
      changedFields: [],
      filledFields: [],
      siteUpdatesInserted: 0,
      streamCandidatesCreated: 0,
    }));
    const fetchModule = await import('../../hearing-discovery/adapters/source-http.js');
    const fetchTextSpy = jest.spyOn(fetchModule, 'fetchText').mockResolvedValue({
      ok: true,
      status: 200,
      body: ANNOUNCEMENT,
    } as never);
    const svc = new LegiWatchPhase9OfficialTimeObservationService(prisma);
    const result = await svc.run({ manual: true, reconcilerFactory: () => ({ reconcileEvent }) });
    fetchTextSpy.mockRestore();
    expect(result.identityConflicts).toBe(1);
    expect(result.candidates[0]?.classification).toBe('SKIPPED_IDENTITY_CONFLICT');
  });
});

describe('official-time-evidence + resolveSourceTime: full chain to 20:00Z', () => {
  it('the announcement text derives exactly the corrected instant', () => {
    const ev = extractExplicitLocalTime(cleanTextSafe(ANNOUNCEMENT));
    expect(ev).not.toBeNull();
    const resolved = resolveSourceTime({
      instant: null,
      calendarDay: new Date('2026-09-04T00:00:00.000Z'),
      displayClock: ev!.clock,
      zoneToken: ev!.zoneToken,
    });
    expect(resolved.startsAt!.toISOString()).toBe('2026-09-04T20:00:00.000Z');
  });
});
