/**
 * Provenance backfill — disposable-Postgres proof (operator brief §9).
 *
 * Exercises the REAL pipeline end to end against a disposable PG16 loaded with
 * real migrations: selection SQL, the reconciler, recordObservation,
 * linkToHearing, the Phase 9 disposition trigger (RECONCILED stamp), and the
 * readiness provenance counting semantics.
 *
 * Cases:
 *  A. legacy canonical hearing + real SourceEvent → observation created,
 *     linked to the EXISTING hearing, no duplicate canonical row
 *  B. repeated reconcile → no duplicate observation (ledger idempotency)
 *  C. changed payload → same observation row refreshed (hash changes, count
 *     unchanged, linked unchanged)
 *  D. ambiguous identity → service guard skips (SKIPPED_IDENTITY_CONFLICT),
 *     no canonical merge, no new canonical hearing
 *  E. future hearing (date inside lookahead) → linked correctly
 *  F. completed hearing → linked correctly
 *  G. stream candidates from the official source → recorded through the
 *     normal candidate repository by the reconciler
 */
import { PrismaService } from '../../prisma/prisma.service.js';
import { HearingReconcilerService } from '../../hearing-discovery/hearing-reconciler.service.js';
import { CommitteeSourceRepository } from '../../hearing-discovery/committee-source.repository.js';
import { CanonicalHearingRepository } from '../../hearing-discovery/canonical-hearing.repository.js';
import { LegiWatchPhase9ProvenanceBackfillService } from './legiwatch-phase9-provenance-backfill.service.js';
import type {
  SourceDescriptor,
  SourceEvent,
} from '../../hearing-discovery/hearing-discovery.types.js';
import { HearingObservationRepository } from '../../hearing-discovery/hearing-observation.repository.js';
import { SourceRegistryService } from '../../hearing-discovery/source-registry.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const ADAPTER_KEY = 'congress-gov';
const SOURCE_URL = 'https://api.congress.gov/v3/committee-meeting/119';

/**
 * The provenance backfill selects hearings whose effective start falls inside
 * `now() - lookbackDays .. now() + 30 days` (PostgreSQL NOW). Hard-coded dates
 * rot as the calendar advances; derive one recent date from the test's own
 * clock so the fixture stays inside the 60-day window without ever touching
 * the production query. Captured once so SourceEvent and seeded hearing can
 * never straddle midnight during a run.
 */
const RECENT_HEARING_DATE = (() => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7));
})();

function recentHearingDate(): Date {
  return new Date(RECENT_HEARING_DATE.getTime());
}

function event(overrides: Partial<SourceEvent> = {}): SourceEvent {
  const recent = recentHearingDate();
  return {
    externalEventId: '338649',
    congress: 119,
    chamber: 'senate',
    committeeSystemCode: 'ssju00',
    title: 'Nomination of Todd Blanche to be Attorney General',
    eventType: 'Hearing',
    eventStatus: 'scheduled',
    visibility: 'public',
    startsAt: new Date(recent.getTime() + 13 * 3_600_000),
    calendarDate: recent,
    displayTime: '9:00 AM',
    location: 'SD-226',
    officialPageUrl: 'https://www.congress.gov/event/119th-Congress/senate-event/338649',
    witnesses: [],
    agendaBillIds: [],
    streamCandidates: [],
    ...overrides,
  };
}

describeDb('LegiWatch Phase 9 provenance backfill (disposable PG)', () => {
  const prisma = new PrismaService();
  let sourceId = '';
  const createdHearingIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
    // Central congress-gov source row, exactly as SourceRegistryService ensures it.
    const sources = new CommitteeSourceRepository(prisma);
    const src = await sources.ensureSource({
      committeeSystemCode: null,
      chamber: 'joint',
      sourceType: 'CONGRESS_GOV',
      sourceUrl: SOURCE_URL,
      adapterKey: ADAPTER_KEY,
      priority: 10,
      parserVersion: 'congress-gov/2026-08-20',
    });
    sourceId = src.id;
  });

  beforeEach(async () => {
    // Ledger identity is (sourceId, externalEventId) — without this, the
    // observation created in an earlier case makes every later case a
    // refreshed no-op instead of a first create.
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `DELETE FROM hearing_source_observation WHERE source_id = $1`,
      sourceId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM hearing_source_observation WHERE hearing_id LIKE 'provbf-%'`,
    );
    for (const id of createdHearingIds.splice(0)) {
      await prisma.$executeRawUnsafe(`DELETE FROM committee_hearing WHERE id = $1`, id);
    }
  }

  /** Seed one canonical hearing shaped like the legacy sync rows. */
  async function seedHearing(
    id: string,
    overrides: Partial<{
      startsAt: Date | null;
      date: Date;
      eventStatus: string;
      url: string | null;
      chamber: string;
      committeeSystemCode: string | null;
      title: string;
    }> = {},
  ): Promise<void> {
    const recent = recentHearingDate();
    const date = overrides.date ?? recent;
    const startsAt =
      overrides.startsAt === undefined
        ? new Date(recent.getTime() + 13 * 3_600_000)
        : overrides.startsAt;
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, congress, chamber, committee_system_code, committee_name, title,
          date, time, starts_at, event_status, visibility, url, source_revision,
          witnesses, stream_availability, coverage_status, synced_at)
       VALUES ($1, 119, $2, $3, $9, $4, $5::date, '9:00 AM', $6, $7, 'public', $8,
               1, ARRAY[]::text[], 'unknown', 'not_covered', now())
       ON CONFLICT (id) DO NOTHING`,
      id,
      overrides.chamber ?? 'Senate',
      overrides.committeeSystemCode ?? 'ssju00',
      overrides.title ?? 'Nomination of Todd Blanche to be Attorney General',
      date.toISOString().slice(0, 10),
      startsAt,
      overrides.eventStatus ?? 'scheduled',
      overrides.url ?? 'https://www.congress.gov/event/119th-Congress/senate-event/338649',
      overrides.chamber === 'House'
        ? 'House Committee on the Judiciary'
        : 'Senate Committee on the Judiciary',
    );
    createdHearingIds.push(id);
  }

  function service(): LegiWatchPhase9ProvenanceBackfillService {
    return new LegiWatchPhase9ProvenanceBackfillService(prisma);
  }

  function reconciler(): HearingReconcilerService {
    return new HearingReconcilerService(prisma);
  }

  async function observationCount(hearingId: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM hearing_source_observation WHERE hearing_id = $1`,
      hearingId,
    );
    return rows[0]?.n ?? 0;
  }

  async function reconciledCount(hearingId: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM hearing_source_observation
       WHERE hearing_id = $1 AND reconciliation_status = 'RECONCILED'`,
      hearingId,
    );
    return rows[0]?.n ?? 0;
  }

  it('A: links a real SourceEvent to the EXISTING canonical hearing without duplicating it', async () => {
    await seedHearing('provbf-A-cm-119-338649');
    expect(
      await new CanonicalHearingRepository(prisma).resolveHearingId(event(), ADAPTER_KEY),
    ).toMatchObject({ hearingId: 'provbf-A-cm-119-338649' });
    const result = await service().run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      reconcilerFactory: reconciler,
      observeEvent: async () => event(),
    });
    expect(result).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          hearingId: 'provbf-A-cm-119-338649',
          classification: 'OBSERVED',
        }),
      ]),
      observationCreated: 1,
    });
    expect(result.newHearingsCreated).toBe(0);
    expect(await reconciledCount('provbf-A-cm-119-338649')).toBe(1);
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number; cm: number }>>(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE id = 'cm-119-338649')::int AS cm
       FROM committee_hearing WHERE id LIKE '%cm-119-338649%'`,
    );
    // exactly the seeded canonical row — no fork, no bare cm- id minted
    expect(rows[0]?.n).toBe(1);
    expect(rows[0]?.cm).toBe(0);
  });

  it('B: a repeated run is a no-op — provenance-exist rows are no longer selected', async () => {
    await seedHearing('provbf-B-cm-119-338649');
    const opts = {
      manual: true,
      lookbackDays: 60,
      limit: 25,
      reconcilerFactory: reconciler,
      observeEvent: async () => event(),
    };
    const first = await service().run(opts);
    const second = await service().run(opts);
    expect(first.observationCreated).toBe(1);
    // second run: the hearing now HAS reconciled provenance → not selected at all
    expect(
      second.candidates.some((candidate) => candidate.hearingId === 'provbf-B-cm-119-338649'),
    ).toBe(false);
    expect(second.observationCreated).toBe(0);
    expect(await observationCount('provbf-B-cm-119-338649')).toBe(1);
  });

  it('C: a changed official payload refreshes the SAME ledger row (no duplicate)', async () => {
    await seedHearing('provbf-C-cm-119-338649');
    await service().run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      reconcilerFactory: reconciler,
      observeEvent: async () => event(),
    });
    // Ongoing discovery re-observes the event with an updated title (the same
    // recordObservation path the recurring central-discovery job uses).
    const observations = new HearingObservationRepository(prisma);
    const registry = new SourceRegistryService(prisma);
    const central = await registry.ensureCentralSources(119);
    const src = central.find((s) => s.adapterKey === 'congress-gov');
    expect(src).toBeTruthy();
    const res = await observations.recordObservation(
      src as SourceDescriptor,
      event({ title: 'Nomination of Todd Blanche, of Florida, to be Attorney General' }),
      new Date(),
    );
    expect(res.created).toBe(false);
    expect(res.contentChanged).toBe(true);
    expect(await observationCount('provbf-C-cm-119-338649')).toBe(1);
    const rows = await prisma.$queryRawUnsafe<Array<{ observed_title: string }>>(
      `SELECT observed_title FROM hearing_source_observation WHERE hearing_id = $1`,
      'provbf-C-cm-119-338649',
    );
    expect(rows[0]?.observed_title).toContain('of Florida');
  });

  it('D: ambiguous identity is skipped — no merge, no new canonical hearing', async () => {
    await seedHearing('provbf-D-cm-119-338649');
    const result = await service().run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      reconcilerFactory: reconciler,
      // a payload whose identity the ladder resolves as `new` (different id,
      // different day, different title) — must NOT be reconciled
      observeEvent: async () => {
        const nextDay = new Date(recentHearingDate().getTime() + 86_400_000);
        return event({
          externalEventId: '338650',
          title: 'An Entirely Different Proceeding About Something Else',
          calendarDate: nextDay,
          startsAt: new Date(nextDay.getTime() + 14 * 3_600_000),
        });
      },
    });
    expect(result.identityConflicts).toBe(1);
    expect(result.observed).toBe(0);
    expect(result.newHearingsCreated).toBe(0);
    expect(await observationCount('provbf-D-cm-119-338649')).toBe(0);
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM committee_hearing WHERE id LIKE 'provbf-D%' OR id = 'cm-119-338650'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('E: a future hearing inside the lookahead links correctly', async () => {
    const future = new Date(new Date().getTime() + 10 * 86_400_000);
    await seedHearing('provbf-E-cm-119-338649', {
      date: future,
      startsAt: future,
      eventStatus: 'scheduled',
    });
    const result = await service().run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      reconcilerFactory: reconciler,
      // the REAL official payload for that future hearing (same event, same day)
      observeEvent: async () =>
        event({
          startsAt: future,
          calendarDate: new Date(
            Date.UTC(future.getUTCFullYear(), future.getUTCMonth(), future.getUTCDate()),
          ),
        }),
    });
    expect(result.observed).toBe(1);
    expect(await reconciledCount('provbf-E-cm-119-338649')).toBe(1);
  });

  it('F: a completed hearing links correctly', async () => {
    await seedHearing('provbf-F-cm-119-338649', { eventStatus: 'completed' });
    const result = await service().run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      reconcilerFactory: reconciler,
      observeEvent: async () => event({ eventStatus: 'completed' }),
    });
    expect(result.observed).toBe(1);
    expect(await reconciledCount('provbf-F-cm-119-338649')).toBe(1);
  });

  it('G: advertised stream candidates flow through the normal candidate repository', async () => {
    await seedHearing('provbf-G-cm-119-338649');
    await service().run({
      manual: true,
      lookbackDays: 60,
      limit: 25,
      reconcilerFactory: reconciler,
      observeEvent: async () =>
        event({
          streamCandidates: [
            {
              provider: 'senate-isvp',
              officialPageUrl: 'https://www.congress.gov/event/119th-Congress/senate-event/338649',
              mediaUrl: 'https://d117c1d0akamaized.net/example/manifest.m3u8',
              mediaType: 'hls',
            },
          ],
        }),
    });
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number; id: string }>>(
      `SELECT COUNT(*)::int AS n, MIN(id) AS id FROM hearing_stream_candidate WHERE hearing_id = $1`,
      'provbf-G-cm-119-338649',
    );
    expect(rows[0]?.n).toBe(1);
  });
});
