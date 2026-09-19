/**
 * Public-Florida browser capture allowance (assertCaptureAllowed).
 *
 * A PUBLIC, non-canceled Florida proceeding (including a completed/archive one
 * with a published replay) on an official first-party page may be captured from
 * a browser tab WITHOUT a reviewed intel_hearing_media_permission — in-person
 * attendance requires no grant. The reviewed-grant path remains the fallback for
 * every other state and for any FL session failing the public predicate.
 *
 * Harness pattern mirrors hearing-capture-hardening.spec.ts (mocked Prisma).
 */
import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  HearingSessionService,
  isOfficialFloridaBrowserPage,
  floridaAnchorUrls,
} from './hearing-session.service.js';

const FL_SENATE = 'https://www.flsenate.gov/media/VideoPlayer/6382';
const FL_HOUSE = 'https://www.flhouse.gov/Sections/HouseSchedule/houseschedule.aspx?event=1234';
const TFC_VIDEO = 'https://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission/';
const TFC_INDEX = 'https://thefloridachannel.org/videos/';
const OFFICIAL_OTHER = 'https://www.senate.mn/committees/judiciary.html';

interface HearingRow {
  url: string | null;
  visibility: string;
  event_status: string;
  calendar_snapshot: unknown;
  geographic_jurisdiction?: string | null;
}

interface SessionShape {
  id: string;
  tenantId: string;
  sourceType: string;
  audioSource: string;
  consentStatus: string;
  createdBy: string;
  hearingId: string | null;
  sourceUrl: string | null;
  publicCaptureId: string | null;
  clientId: string | null;
  matterId: string | null;
  issueIds: string[];
  billIds: string[];
  programElementIds: string[];
  agencyIds: string[];
}

function makeSession(overrides: Partial<SessionShape> = {}): SessionShape {
  return {
    id: 'sess-1',
    tenantId: 'tenant-1',
    sourceType: 'hearing',
    audioSource: 'browser_mic',
    consentStatus: 'not_required',
    createdBy: 'user-1',
    hearingId: 'hearing-1',
    sourceUrl: FL_SENATE,
    publicCaptureId: null,
    clientId: null,
    matterId: null,
    issueIds: [],
    billIds: [],
    programElementIds: [],
    agencyIds: [],
    ...overrides,
  };
}

interface Harness {
  prisma: PrismaService;
  /** Queue of results for $queryRaw calls IN ORDER:
   *  [0] state-jurisdiction lookup, [1] hearing row (FL path), [2] stream candidates (FL path),
   *  or [1] grants (grant path). */
  rawResults: unknown[][];
  rawSql: string[];
}

function makeHarness(session: SessionShape, rawResults: unknown[][]): Harness {
  const rawSql: string[] = [];
  const tx = {
    liveHearingSession: {
      findFirst: jest.fn(async () => session),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      rawSql.push(strings.join('?'));
      return rawResults.shift() ?? [];
    }),
  };
  const prisma = {
    withTenant: async <T>(_tenantId: string, fn: (inner: typeof tx) => Promise<T>) => fn(tx),
    $queryRaw: tx.$queryRaw,
  } as unknown as PrismaService;
  return { prisma, rawResults, rawSql };
}

const FL_JURISDICTION_ROW = [{ id: 'hearing-1', geographic_jurisdiction: 'FL' }];

function flHearingRow(overrides: Partial<HearingRow> = {}): HearingRow[] {
  return [
    {
      url: FL_SENATE,
      visibility: 'public',
      event_status: 'scheduled',
      calendar_snapshot: null,
      ...overrides,
    },
  ];
}

describe('isOfficialFloridaBrowserPage', () => {
  it('recognizes official FL chamber pages and exact TFC video pages', () => {
    expect(isOfficialFloridaBrowserPage(FL_SENATE)).toBe(true);
    expect(isOfficialFloridaBrowserPage(FL_HOUSE)).toBe(true);
    expect(isOfficialFloridaBrowserPage(TFC_VIDEO)).toBe(true);
    expect(isOfficialFloridaBrowserPage('https://www.flsenate.gov')).toBe(true);
  });
  it('rejects the TFC archive index, other hosts, non-http schemes, and junk', () => {
    expect(isOfficialFloridaBrowserPage(TFC_INDEX)).toBe(false);
    expect(isOfficialFloridaBrowserPage('https://thefloridachannel.org/about')).toBe(false);
    expect(isOfficialFloridaBrowserPage('https://www.youtube.com/watch?v=x')).toBe(false);
    expect(isOfficialFloridaBrowserPage('api://florida/senate')).toBe(false);
    expect(isOfficialFloridaBrowserPage('http://www.flsenate.gov/media/VideoPlayer/6382')).toBe(false);
    expect(isOfficialFloridaBrowserPage('http://thefloridachannel.org/videos/x-1/')).toBe(false);
    expect(isOfficialFloridaBrowserPage('https://user:pw@www.flsenate.gov/media/VideoPlayer/6382')).toBe(false);
    expect(isOfficialFloridaBrowserPage('https://thefloridachannel.org:8443/videos/x-1/')).toBe(false);
    expect(isOfficialFloridaBrowserPage('not a url')).toBe(false);
    expect(isOfficialFloridaBrowserPage(null)).toBe(false);
    expect(isOfficialFloridaBrowserPage(undefined)).toBe(false);
  });
});

describe('floridaAnchorUrls', () => {
  it('collects canonical url, snapshot watchUrl, and candidate pages', () => {
    const anchors = floridaAnchorUrls({
      url: 'https://a',
      calendarSnapshot: { watchUrl: 'https://b' },
      streamCandidates: [{ officialPageUrl: 'https://c' }, { officialPageUrl: null }],
    });
    expect(anchors).toEqual(['https://a', 'https://b', 'https://c']);
  });
  it('tolerates missing snapshot/candidates', () => {
    expect(floridaAnchorUrls({ url: null, calendarSnapshot: null, streamCandidates: [] })).toEqual(
      [],
    );
  });
});

describe('assertCaptureAllowed — public Florida browser capture', () => {
  it('allows an unflagged public FL hearing on an official Senate page (no grant rows)', async () => {
    const session = makeSession();
    const h = makeHarness(session, [
      FL_JURISDICTION_ROW, // state lookup
      flHearingRow(), // hearing row
      [], // no stream candidates
    ]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).resolves.toBe(session);
  });

  it('allows FL House and TFC per-event pages, including a COMPLETED archive event', async () => {
    for (const [sourceUrl, status] of [
      [FL_HOUSE, 'scheduled'],
      [TFC_VIDEO, 'completed'],
      [FL_SENATE, 'completed'],
    ] as const) {
      const session = makeSession({ sourceUrl });
      const h = makeHarness(session, [
        FL_JURISDICTION_ROW,
        flHearingRow({ url: sourceUrl, event_status: status }),
        [],
      ]);
      const svc = new HearingSessionService(h.prisma);
      await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).resolves.toBe(session);
    }
  });

  it('matches sourceUrl against calendar_snapshot.watchUrl when hearing.url differs', async () => {
    const session = makeSession({ sourceUrl: TFC_VIDEO });
    const h = makeHarness(session, [
      FL_JURISDICTION_ROW,
      flHearingRow({ url: FL_SENATE, calendar_snapshot: { watchUrl: TFC_VIDEO } }),
      [],
    ]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).resolves.toBe(session);
  });

  it('matches sourceUrl against an advertised stream-candidate official page', async () => {
    const session = makeSession({ sourceUrl: TFC_VIDEO });
    const h = makeHarness(session, [
      FL_JURISDICTION_ROW,
      flHearingRow({ url: FL_SENATE }),
      [{ official_page_url: TFC_VIDEO }],
    ]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).resolves.toBe(session);
  });

  it('BLOCKS a sourceUrl that matches no canonical anchor even when the host is official FL', async () => {
    const session = makeSession({ sourceUrl: 'https://www.flsenate.gov/media/VideoPlayer/9999' });
    const h = makeHarness(session, [
      FL_JURISDICTION_ROW,
      flHearingRow(), // anchors advertise VideoPlayer/6382 only
      [],
      [], // grant path: no grants
    ]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).rejects.toThrow(
      'STATE_BROWSER_CAPTURE_PERMISSION_REQUIRED',
    );
  });

  it('BLOCKS the TFC archive index as a source even when advertised as the hearing url', async () => {
    const session = makeSession({ sourceUrl: TFC_INDEX });
    const h = makeHarness(session, [
      FL_JURISDICTION_ROW,
      flHearingRow({ url: TFC_INDEX }),
      [],
      [],
    ]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('BLOCKS a private (visibility != public) FL hearing without a grant', async () => {
    const session = makeSession();
    const h = makeHarness(session, [
      FL_JURISDICTION_ROW,
      flHearingRow({ visibility: 'private' }),
      [],
      [],
    ]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).rejects.toThrow(
      'STATE_BROWSER_CAPTURE_PERMISSION_REQUIRED',
    );
  });

  it('BLOCKS a canceled FL hearing without a grant', async () => {
    const session = makeSession();
    const h = makeHarness(session, [
      FL_JURISDICTION_ROW,
      flHearingRow({ event_status: 'canceled' }),
      [],
      [],
    ]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).rejects.toThrow(
      'STATE_BROWSER_CAPTURE_PERMISSION_REQUIRED',
    );
  });

  it('BLOCKS a private source type (meeting) even on a public FL page', async () => {
    const session = makeSession({ sourceType: 'meeting', consentStatus: 'confirmed' });
    // FL predicate exits before the hearing-row query (sourceType check), so the
    // next queued result is the grant lookup: empty → blocked.
    const h = makeHarness(session, [FL_JURISDICTION_ROW, []]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).rejects.toThrow(
      'STATE_BROWSER_CAPTURE_PERMISSION_REQUIRED',
    );
  });

  it('ALLOWS a client-linked FL session — linkage drives ENCRYPTION, never capture denial', async () => {
    const session = makeSession({ clientId: 'client-9', billIds: ['hr-1'] });
    const h = makeHarness(session, [FL_JURISDICTION_ROW, flHearingRow(), []]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).resolves.toBe(session);
    // The encryption classifier still sees the linkage.
    expect(HearingSessionService.isSensitiveSession(session)).toBe(true);
  });

  it('BLOCKS consent needs_review BEFORE the FL allowance is even consulted', async () => {
    const session = makeSession({ consentStatus: 'needs_review' });
    const h = makeHarness(session, []);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).rejects.toThrow(
      /needs_review/,
    );
    expect(h.rawSql.length).toBe(0); // no jurisdiction query ran at all
  });

  it('keeps the reviewed-grant fallback for NON-FL states', async () => {
    const session = makeSession({ sourceUrl: OFFICIAL_OTHER });
    const h = makeHarness(session, [
      [{ id: 'hearing-1', geographic_jurisdiction: 'MN' }],
      [{ id: 'grant-1' }], // grant path finds a valid reviewed permission
    ]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).resolves.toBe(session);
    expect(h.rawSql[1]).toContain('intel_hearing_media_permission');
  });

  it('keeps the reviewed-grant fallback for an FL session failing the public predicate', async () => {
    const session = makeSession({ sourceType: 'meeting', consentStatus: 'confirmed' });
    // FL predicate exits at the sourceType check; grant lookup then finds a grant.
    const h = makeHarness(session, [FL_JURISDICTION_ROW, [{ id: 'grant-1' }]]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.assertCaptureAllowed('tenant-1', 'sess-1', 'user-1')).resolves.toBe(session);
  });

  it('does NOT relax the canonical-review and server-path gates', async () => {
    // publicCaptureId gate still fires first
    const reviewSession = makeSession({ publicCaptureId: 'pub-1' });
    const h1 = makeHarness(reviewSession, []);
    await expect(
      new HearingSessionService(h1.prisma).assertCaptureAllowed('tenant-1', 'sess-1', 'user-1'),
    ).rejects.toThrow('CANONICAL_REVIEW_CONTEXT_CANNOT_CAPTURE');

    // a non-browser audio source never qualifies for the FL allowance
    const serverSession = makeSession({ audioSource: 'stream_url' });
    // audioSource check exits before the hearing-row query; grants empty → blocked.
    const h2 = makeHarness(serverSession, [FL_JURISDICTION_ROW, []]);
    await expect(
      new HearingSessionService(h2.prisma).assertCaptureAllowed('tenant-1', 'sess-1', 'user-1'),
    ).rejects.toThrow('STATE_BROWSER_CAPTURE_PERMISSION_REQUIRED');
  });
});
