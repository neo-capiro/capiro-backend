/**
 * Florida archive backfill — disposable-Postgres integration proof.
 *
 * Proves the contract root reviewed, exercising the REAL production code
 * paths (backfillFloridaArchive + discoverFloridaCalendar with injected
 * fixtures, never raw reconciler calls that merely assume dedupe):
 *  1. Archive-first: a TFC archive record reconciles into ONE canonical FL
 *     hearing with a `florida-channel` BROWSER_CAPTURE_ONLY candidate.
 *  2. Notice-after-archive: the REAL notice path (discoverFloridaCalendar,
 *     fetchSource-injected, REAL published 6914 notice PDF bytes) crosswalks
 *     by shared publisher entry and upgrades the archive body key to the
 *     official roster key.
 *  3. Notice-first -> archive-later: the archive record attaches to the
 *     notice-created row (persisted publisher entry / shared Kaltura proof).
 *  4. Repeat runs create zero duplicates.
 *  5. An ambiguous shared media entry is reported and skipped — never a dup.
 *  6. Distinct same-day subcommittees import separately.
 *  7. An archive reimport after the qualified notice MUST NOT revert the
 *     canonical body metadata.
 *  8. An exact canonical page with NO observation ledger still attaches.
 *
 * Runs ONLY against the worker's dedicated disposable database.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { backfillFloridaArchive } from './florida-archive-discovery.js';
import { discoverFloridaCalendar } from './florida-calendar-discovery.js';

// The REAL published JLBC 9/11/2026 meeting notice (73419 bytes, PDF 1.7,
// fetched from https://www.flsenate.gov/Committees/Show/JLBC/MeetingNotice/6914
// and mirrored from root's archive-fetch-cache). Jest's module registry cannot
// spin up pdf-parse's worker (no --experimental-vm-modules here), so the PDF
// seam is narrowed to THIS fixture only: the mock asserts it received the
// actual published bytes and returns the text extracted from them with the
// real PDFParse outside Jest (root's notice-after-archive proof). Any other
// URL/bytes fail loudly rather than parsing a stand-in.
const NOTICE_6914_PDF = readFileSync(
  join(__dirname, '__fixtures__/florida/senate-notice-6914.pdf'),
);
const NOTICE_6914_TEXT = readFileSync(
  join(__dirname, '__fixtures__/florida/senate-notice-6914.txt'),
  'utf8',
);
jest.mock('pdf-parse', () => ({
  PDFParse: class {
    private readonly data: Uint8Array;
    constructor(opts: { data: Uint8Array }) {
      this.data = opts.data;
    }
    async getText() {
      if (
        this.data.length !== NOTICE_6914_PDF.length ||
        !Buffer.from(this.data).equals(NOTICE_6914_PDF)
      )
        throw new Error('pdf-parse seam received bytes other than the real 6914 notice');
      return { text: NOTICE_6914_TEXT };
    }
    async destroy() {}
  },
}));

// Disposable-PG opt-in, same convention as the other integration suites:
// runs ONLY when DATABASE_URL points at an explicitly disposable database and
// CAPIRO_DISPOSABLE_PG=1 (or ALLOW_DISPOSABLE_PG=1). No host/port is hardcoded.
const DISPOSABLE =
  process.env.CAPIRO_DISPOSABLE_PG === '1' || process.env.ALLOW_DISPOSABLE_PG === '1';
const GUARD = Boolean(process.env.DATABASE_URL) && DISPOSABLE;
const DATABASE_URL = process.env.DATABASE_URL ?? '';

const SENATE_PLAYER = 'https://www.flsenate.gov/media/VideoPlayer/6382';
const TFC_PAGE =
  'https://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission/';
const TFC_RECORD = {
  id: 80615,
  date: '2026-09-11T11:00:00',
  link: TFC_PAGE,
  title: { rendered: '9/11/26 Joint Legislative Budget Commission' },
  content: {
    rendered:
      '<iframe src="https://cdnapisec.kaltura.com/p/2593311/embedPlaykitJs/uiconf_id/48703633?iframeembed=true&entry_id=1_abohhovv"></iframe>',
  },
  video_programs: [54919, 25458],
};

function channelFetcherFor(records: unknown[]) {
  return (url: string): Promise<{ bytes: Uint8Array; totalPages: number | null }> => {
    const encode = (v: unknown) => ({
      bytes: new TextEncoder().encode(JSON.stringify(v)),
      totalPages: 1,
    });
    if (url.includes('/video_programs'))
      return Promise.resolve(encode([{ id: 54919, name: '2026 Legislative Session' }]));
    if (url.includes('page=2')) return Promise.resolve({ bytes: new Uint8Array(), totalPages: 1 });
    if (url.includes('/videos?')) return Promise.resolve(encode(records));
    throw new Error(`unexpected channel fetch: ${url}`);
  };
}

(GUARD ? describe : describe.skip)('florida archive backfill (disposable PG)', () => {
  let prisma: PrismaClient;
  let playerHtml: string;
  jest.setTimeout(120000);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    playerHtml = readFileSync(
      join(__dirname, '__fixtures__/florida/senate-videoplayer-6382.html'),
      'utf8',
    );
  });
  beforeEach(async () => {
    await prisma.hearingStreamCandidate.deleteMany({});
    await prisma.legislativeAgendaItem.deleteMany({});
    await prisma.legislativeObservationRevision.deleteMany({});
    await prisma.legislativeCalendarTransition.deleteMany({});
    await prisma.hearingSourceObservation.deleteMany({});
    await prisma.legislativeCalendarCoverage.deleteMany({});
    await prisma.committeeHearing.deleteMany({ where: { geographicJurisdiction: 'FL' } });
    await prisma.committeeSource.deleteMany({
      where: { adapterKey: { in: ['florida-channel-archive', 'florida-senate', 'florida-house'] } },
    });
  });
  afterAll(async () => prisma.$disconnect());

  const jlbcArchiveOpts = (records: unknown[] = [TFC_RECORD]) => ({
    session: '2026',
    from: '2026-09-01',
    to: '2026-09-30',
    delayMs: 0,
    fetchChannel: channelFetcherFor(records),
    fetchChamber: (url: string): Promise<Uint8Array> => {
      if (url === SENATE_PLAYER)
        return Promise.resolve(new TextEncoder().encode(playerHtml));
      throw new Error(`unexpected chamber fetch: ${url}`);
    },
  });

  /** The REAL notice path for the published 9/11/2026 JLBC sitting:
   *  directory row (date 9/11/2026, notice 6914, video player 6382) and the
   *  REAL published 6914 notice PDF bytes. Every fetched page is a fixture;
   *  the only fabrication is the committee listing/table markup around the
   *  real notice link, which the senate adapter requires to discover it. */
  async function runJlbcNoticeDiscovery() {
    const senateJlbc = `<html><body><a href="/Committees/Show/JLBC">Joint Legislative Budget Commission</a></body></html>`;
    const jlbcPage = `<html><body><table id="meetingsTbl"><tbody><tr>
      <td>9/11/2026</td><td>11:00 AM</td><td></td>
      <td><a class="mtgrecord_notice" href="/Committees/Show/JLBC/MeetingNotice/6914">Notice</a>
          <a class="mtgrecord_video" href="/media/VideoPlayer/6382">Video</a></td>
      </tr></tbody></table></body></html>`;
    return discoverFloridaCalendar(prisma, {
      from: '2026-09-01',
      to: '2026-09-30',
      session: '2026',
      delayMs: 0,
      fetchChannel: channelFetcherFor([TFC_RECORD]),
      fetchSource: (url: string) => {
        if (url === 'https://www.flsenate.gov/Committees')
          return Promise.resolve(new TextEncoder().encode(senateJlbc));
        if (url === 'https://www.flsenate.gov/Committees/Show/JLBC/2026')
          return Promise.resolve(new TextEncoder().encode(jlbcPage));
        if (url.includes('/MeetingNotice/6914')) {
          // The REAL published PDF bytes (pdf-parse seam asserts identity).
          return Promise.resolve(new Uint8Array(NOTICE_6914_PDF));
        }
        if (url === SENATE_PLAYER)
          return Promise.resolve(new TextEncoder().encode(playerHtml));
        return Promise.resolve(new TextEncoder().encode('<html><body></body></html>'));
      },
    });
  }

  it('archive-first: ingests, dedupes, notice upgrades body, reimport preserves it', async () => {
    // 1. First archive run creates exactly one canonical hearing + candidate.
    const first = await backfillFloridaArchive(prisma, jlbcArchiveOpts());
    expect(first.archive.accepted).toBe(1);
    expect(first.archive.inserted).toBe(1);
    expect(first.archive.errors).toBe(0);
    expect(first.archive.ambiguous).toEqual([]);
    const hearings = await prisma.committeeHearing.findMany({
      where: { geographicJurisdiction: 'FL' },
      select: {
        id: true,
        date: true,
        eventStatus: true,
        chamber: true,
        committeeName: true,
        url: true,
        bodySourceKey: true,
        timePrecision: true,
      },
    });
    expect(hearings).toHaveLength(1);
    expect(hearings[0]).toMatchObject({
      chamber: 'Joint',
      committeeName: 'Joint Legislative Budget Commission',
      eventStatus: 'completed',
      timePrecision: 'date',
      url: TFC_PAGE,
    });
    expect(hearings[0]!.bodySourceKey).toMatch(/^fl:joint:tfc:/);
    expect(hearings[0]!.date.toISOString().slice(0, 10)).toBe('2026-09-11');
    const archiveHearingId = hearings[0]!.id;
    const candidates = await prisma.hearingStreamCandidate.findMany({
      where: { hearingId: archiveHearingId },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      provider: 'florida-channel',
      officialPageUrl: TFC_PAGE,
      capturePolicy: 'BROWSER_CAPTURE_ONLY',
    });

    // 2. Idempotent re-run: zero new hearings, zero new candidates, unchanged.
    const second = await backfillFloridaArchive(prisma, jlbcArchiveOpts());
    expect(second.archive.inserted).toBe(0);
    expect(second.archive.unchanged).toBe(1);
    expect(await prisma.committeeHearing.count({ where: { geographicJurisdiction: 'FL' } })).toBe(
      1,
    );
    expect(
      await prisma.hearingStreamCandidate.count({ where: { hearingId: archiveHearingId } }),
    ).toBe(1);

    // 3. Notice-after-archive via the REAL production notice path: the shared
    //    publisher entry (senate player 6382 fixture embeds 1_abohhovv, the
    //    same as the TFC record) is resolved BEFORE reconcile, attaches the
    //    notice to the archive row, and the proven archive→notice attachment
    //    upgrades the TFC body key to the official roster key.
    const noticeResults = await runJlbcNoticeDiscovery();
    const senate = noticeResults.find((r) => r.chamber === 'senate');
    expect(senate?.issues.join(' ')).not.toMatch(/ambiguous/);
    expect(await prisma.committeeHearing.count({ where: { geographicJurisdiction: 'FL' } })).toBe(
      1,
    );
    const afterNotice = await prisma.committeeHearing.findUniqueOrThrow({
      where: { id: archiveHearingId },
      select: { bodySourceKey: true, eventStatus: true, timePrecision: true, startsAt: true },
    });
    // Archive→notice upgrade: official roster key + scheduled/instant facts.
    expect(afterNotice.bodySourceKey).toBe('fl:joint:lbc');
    expect(afterNotice.eventStatus).toBe('scheduled');

    // 4. Archive reimport AFTER the qualified notice must NOT revert the
    //    canonical body metadata (qualified key + committee name preserved).
    const reimport = await backfillFloridaArchive(prisma, jlbcArchiveOpts());
    expect(reimport.archive.inserted).toBe(0);
    const afterReimport = await prisma.committeeHearing.findUniqueOrThrow({
      where: { id: archiveHearingId },
      select: { bodySourceKey: true, committeeName: true },
    });
    expect(afterReimport.bodySourceKey).toBe('fl:joint:lbc');
    expect(afterReimport.committeeName).toBe('Joint Legislative Budget Commission');
    expect(await prisma.committeeHearing.count({ where: { geographicJurisdiction: 'FL' } })).toBe(
      1,
    );
  });

  it('notice-first: archive later attaches by strong proof, repeat zero duplicates', async () => {
    // 1. Notice first (real path): creates the canonical row for the JLBC
    //    sitting from the chamber notice + official player page.
    await runJlbcNoticeDiscovery();
    const hearings = await prisma.committeeHearing.findMany({
      where: { geographicJurisdiction: 'FL' },
      select: { id: true, bodySourceKey: true },
    });
    expect(hearings).toHaveLength(1);
    expect(hearings[0]!.bodySourceKey).toBe('fl:joint:lbc');
    const canonicalId = hearings[0]!.id;

    // 2. Archive later: the TFC record's exact page is unknown to the ledger
    //    (the notice cited the SENATE player page), but the shared Kaltura
    //    entry proves the same proceeding. No duplicate.
    const archive = await backfillFloridaArchive(prisma, jlbcArchiveOpts());
    expect(archive.archive.inserted).toBe(0);
    expect(archive.archive.ambiguous).toEqual([]);
    expect(await prisma.committeeHearing.count({ where: { geographicJurisdiction: 'FL' } })).toBe(
      1,
    );
    // The archive observation is now linked to the notice-created row, with
    // its own stable identity preserved.
    const observations = await prisma.hearingSourceObservation.findMany({
      where: { hearingId: canonicalId },
      select: { externalEventId: true, sourceId: true },
    });
    expect(observations.length).toBeGreaterThanOrEqual(2);
    expect(observations.map((o) => o.externalEventId)).toContain('fl:tfc:video:80615');
    // The notice's qualified body metadata survives the archive attach.
    const after = await prisma.committeeHearing.findUniqueOrThrow({
      where: { id: canonicalId },
      select: { bodySourceKey: true },
    });
    expect(after.bodySourceKey).toBe('fl:joint:lbc');

    // 3. Repeat BOTH sources: zero new rows, zero duplicates.
    const archive2 = await backfillFloridaArchive(prisma, jlbcArchiveOpts());
    expect(archive2.archive.inserted).toBe(0);
    await runJlbcNoticeDiscovery();
    expect(await prisma.committeeHearing.count({ where: { geographicJurisdiction: 'FL' } })).toBe(
      1,
    );
  });

  it('blocks ambiguous shared-media proof and imports distinct same-day subcommittees', async () => {
    // 1. Ambiguity: two same-day same-body proceedings already exist (seeded
    //    as two canonical rows both citing the same shared entry via persisted
    //    observation metadata) — a third TFC record with that entry must be
    //    reported as ambiguous and skipped, never merged.
    const mkRow = async (id: string) =>
      prisma.committeeHearing.create({
        data: {
          id,
          geographicJurisdiction: 'FL',
          chamber: 'Joint',
          committeeName: 'Joint Legislative Budget Commission',
          title: 'Joint Legislative Budget Commission',
          date: new Date('2026-09-11T00:00:00Z'),
          bodySourceKey: `fl:joint:other:${id}`,
          type: 'joint',
          coverageStatus: 'discovered',
          calendarCheckState: 'partial',
        },
      });
    await mkRow('fl-ambiguous-a');
    await mkRow('fl-ambiguous-b');
    const source = await prisma.committeeSource.create({
      data: {
        committeeSystemCode: null,
        chamber: 'joint',
        sourceType: 'COMMITTEE_API',
        sourceUrl: 'https://thefloridachannel.org/videos/',
        adapterKey: 'florida-channel-archive',
        priority: 20,
        parserVersion: 'fl-archive/2026-09-16.1',
        enabled: true,
      },
    });
    for (const [i, hid] of ['fl-ambiguous-a', 'fl-ambiguous-b'].entries()) {
      await prisma.hearingSourceObservation.create({
        data: {
          sourceId: source.id,
          externalEventId: `fl:tfc:video:ambig-${i}`,
          hearingId: hid,
          rawContentHash: `hash-${i}`,
          sourceMetadata: {
            legislative: {
              jurisdiction: 'FL',
              chamber: 'joint',
              officialIdentity: `fl:tfc:video:ambig-${i}`,
              bodySourceKey: `fl:joint:other:${hid}`,
              sourceUrl: `https://thefloridachannel.org/videos/ambig-${i}/`,
              publisherMediaEntryId: '1_shared0x',
              fields: { watchUrl: `https://thefloridachannel.org/videos/ambig-${i}/` },
            },
          },
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
    }
    const ambigRecord = {
      ...TFC_RECORD,
      id: 99998,
      link: 'https://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission-ambig/',
      content: {
        rendered:
          '<iframe src="https://cdnapisec.kaltura.com/p/2593311/embedPlaykitJs/uiconf_id/48703633?iframeembed=true&entry_id=1_shared0x"></iframe>',
      },
    };
    const ambig = await backfillFloridaArchive(prisma, jlbcArchiveOpts([ambigRecord]));
    expect(ambig.archive.inserted).toBe(0);
    expect(ambig.archive.ambiguous.join(' ')).toMatch(/shared by 2 proceedings|matches 2|cited by 2/);
    expect(await prisma.committeeHearing.count({ where: { geographicJurisdiction: 'FL' } })).toBe(
      2,
    );

    // 2. Unverified overlap: a DIFFERENT entry id with the same normalized
    //    body/day blocks creation and is reported — never a silent duplicate.
    const dupRecord = {
      ...TFC_RECORD,
      id: 99999,
      link: 'https://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission-extra/',
      content: {
        rendered:
          '<iframe src="https://cdnapisec.kaltura.com/p/2593311/embedPlaykitJs/uiconf_id/48703633?iframeembed=true&entry_id=1_zzzzzzz"></iframe>',
      },
    };
    const third = await backfillFloridaArchive(prisma, jlbcArchiveOpts([dupRecord]));
    expect(third.archive.inserted).toBe(0);
    expect(third.archive.ambiguous.join(' ')).toMatch(/overlaps/);
    expect(await prisma.committeeHearing.count({ where: { geographicJurisdiction: 'FL' } })).toBe(
      2,
    );

    // 3. Same-day DISTINCT subcommittees are never blocked by the parent or
    //    each other (root inventory proof: 79030/78444 false-blocked).
    await prisma.committeeHearing.deleteMany({ where: { geographicJurisdiction: 'FL' } });
    await prisma.hearingSourceObservation.deleteMany({});
    const senateApprops = (id: number, slug: string, title: string, entry: string) => ({
      id,
      date: '2026-02-12T10:00:00',
      link: `https://thefloridachannel.org/videos/${slug}/`,
      title: { rendered: title },
      content: {
        rendered: `<iframe src="https://cdnapisec.kaltura.com/p/2593311/embedPlaykitJs/uiconf_id/48703633?iframeembed=true&entry_id=${entry}"></iframe>`,
      },
      video_programs: [54919],
    });
    const batch = [
      senateApprops(79030, '2-12-26-senate-appropriations', '2/12/26 Senate Committee on Appropriations', '1_appr0001'),
      senateApprops(78444, '2-12-26-senate-appropriations-health', '2/12/26 Senate Appropriations Committee on Health and Human Services', '1_appr0002'),
      senateApprops(78445, '2-12-26-senate-appropriations-education', '2/12/26 Senate Appropriations Committee on Pre-K - 12 Education', '1_appr0003'),
    ];
    const fourth = await backfillFloridaArchive(prisma, {
      session: '2026',
      from: '2026-02-01',
      to: '2026-02-28',
      delayMs: 0,
      fetchChannel: channelFetcherFor(batch),
      fetchChamber: (url: string): Promise<Uint8Array> => {
        throw new Error(`unexpected chamber fetch: ${url}`);
      },
    });
    expect(fourth.archive.inserted).toBe(3);
    expect(fourth.archive.ambiguous).toEqual([]);
    expect(await prisma.committeeHearing.count({ where: { geographicJurisdiction: 'FL' } })).toBe(
      3,
    );
  });

  it('attaches an archive record to an exact canonical page with NO observation ledger', async () => {
    // A canonical row whose own `url` IS the TFC page but with no observation
    // ledger rows (e.g. seeded from another source then ledger-pruned): the
    // exact-page proof alone attaches, and the archive observation joins the
    // existing row instead of creating a duplicate.
    await prisma.committeeHearing.create({
      data: {
        id: 'fl-ledgerless',
        geographicJurisdiction: 'FL',
        chamber: 'Joint',
        committeeName: 'Joint Legislative Budget Commission',
        title: 'Joint Legislative Budget Commission',
        date: new Date('2026-09-11T00:00:00Z'),
        bodySourceKey: 'fl:joint:lbc',
        type: 'joint',
        url: TFC_PAGE,
        coverageStatus: 'discovered',
        calendarCheckState: 'partial',
      },
    });
    const result = await backfillFloridaArchive(prisma, jlbcArchiveOpts());
    expect(result.archive.inserted).toBe(0);
    expect(result.archive.ambiguous).toEqual([]);
    expect(await prisma.committeeHearing.count({ where: { geographicJurisdiction: 'FL' } })).toBe(
      1,
    );
    const observations = await prisma.hearingSourceObservation.findMany({
      where: { hearingId: 'fl-ledgerless' },
      select: { externalEventId: true },
    });
    expect(observations.map((o) => o.externalEventId)).toContain('fl:tfc:video:80615');
  });
});
