import { PublicCaptureAutomaticResolverAdapter } from './public-capture-automatic-resolver.adapter.js';
import { STATE_CAPTURE_LINK_ONLY } from '../state-capture-policy.js';

const FLORIDA_PAGE = 'https://thefloridachannel.org/videos/example-hearing/';
const FLORIDA_SENATE_PLAYER = 'https://www.flsenate.gov/media/VideoPlayer/6382';
const FLORIDA_MANIFEST =
  'https://cdnapi.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_abohhovv/protocol/https/format/applehttp/a.m3u8';
const FEDERAL_PAGE = 'https://www.armed-services.senate.gov/hearings/example';
const SENATE_MEDIA = {
  url: 'https://www-senate-gov-media-srs.akamaized.net/live/master.m3u8',
  kind: 'hls' as const,
  provider: 'senate-isvp',
};
const FLORIDA_MEDIA = {
  url: FLORIDA_MANIFEST,
  kind: 'hls' as const,
  provider: 'florida-channel-kaltura',
  ipBound: false,
};

function adapter(rawResults: unknown[][], media: typeof SENATE_MEDIA | typeof FLORIDA_MEDIA = SENATE_MEDIA) {
  const query = jest.fn().mockImplementation(async () => rawResults.shift() ?? []);
  const execute = jest.fn().mockResolvedValue(1);
  const resolver = {
    resolve: jest.fn(async () => ({ status: 'resolved' as const, media })),
  };
  return {
    value: new PublicCaptureAutomaticResolverAdapter(
      { $queryRawUnsafe: query, $executeRawUnsafe: execute } as never,
      resolver as never,
    ),
    query,
    execute,
    resolver,
  };
}

const flag = 'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED';
const previous = process.env[flag];
afterAll(() => {
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
});

describe.each([undefined, '', 'false', '0'])(
  'automatic state capture is link-only (LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED=%s)',
  (value) => {
    beforeEach(() => {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    });

    it('blocks a Florida publisher URL before any lookup or provider resolution', async () => {
      const h = adapter([]);
      const result = await h.value.resolveClassified({
        hearingId: 'federal-substitute',
        pageUrl: FLORIDA_PAGE,
      });
      expect(result.selected).toMatchObject({
        state: 'POLICY_BLOCKED',
        reasonCode: 'STATE_CAPTURE_LINK_ONLY',
        terminal: true,
      });
      expect(result.rawResult.note).toBe(STATE_CAPTURE_LINK_ONLY);
      expect(h.query).not.toHaveBeenCalled();
      expect(h.resolver.resolve).not.toHaveBeenCalled();
    });

    it('blocks a canonical state hearing even when the supplied page is not a Florida host', async () => {
      const h = adapter([[{ id: 'hearing-fl' }]]);
      const result = await h.value.resolveClassified({
        hearingId: 'hearing-fl',
        pageUrl: 'https://example.gov/watch',
      });
      expect(result.selected.reasonCode).toBe('STATE_CAPTURE_LINK_ONLY');
      expect(h.query.mock.calls[0]![0]).toContain("geographic_jurisdiction<>'US'");
      expect(h.resolver.resolve).not.toHaveBeenCalled();
    });

    it('preserves federal automatic resolution through the federal view', async () => {
      const h = adapter([
        [],
        [
          {
            id: 'hearing-us',
            eventStatus: 'scheduled',
            publicAccess: 'PUBLIC',
            scheduledStart: new Date('2026-09-22T12:00:00Z'),
            officialPageUrl: FEDERAL_PAGE,
          },
        ],
        [],
      ]);
      const result = await h.value.resolveClassified({
        hearingId: 'hearing-us',
        pageUrl: FEDERAL_PAGE,
      });
      expect(result.selected.state).toBe('READY_FOR_SERVER_CAPTURE');
      expect(h.query.mock.calls[1]![0]).toContain('FROM federal_committee_hearing');
      expect(h.resolver.resolve).toHaveBeenCalledTimes(1);
    });
  },
);

describe('automatic state capture with LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED=true', () => {
  beforeEach(() => {
    process.env[flag] = 'true';
  });

  it('passes a Florida hearing through the normal resolution path to a ready Kaltura stream', async () => {
    const h = adapter(
      [
        [
          {
            id: 'hearing-fl',
            eventStatus: 'scheduled',
            publicAccess: 'PUBLIC',
            scheduledStart: new Date('2026-09-22T12:00:00Z'),
            officialPageUrl: FLORIDA_SENATE_PLAYER,
          },
        ],
        [],
      ],
      FLORIDA_MEDIA,
    );
    const result = await h.value.resolveClassified({
      hearingId: 'hearing-fl',
      pageUrl: FLORIDA_SENATE_PLAYER,
    });
    expect(result.selected).toMatchObject({
      state: 'READY_FOR_SERVER_CAPTURE',
      capturePolicy: 'SERVER_CAPTURE_ALLOWED',
      reasonCode: 'FIRST_PARTY_STREAM_READY',
      requiresJustInTimeReresolution: true,
      mayPersistResolvedMediaUrl: false,
    });
    expect(result.selected.media?.url).toBe(FLORIDA_MANIFEST);
    // No jurisdiction probe; the hearing is read from the capturable view.
    expect(h.query.mock.calls[0]![0]).toContain('FROM capturable_committee_hearing');
    expect(h.query.mock.calls.map((call) => call[0]).join(' ')).not.toContain(
      'geographic_jurisdiction',
    );
    expect(h.resolver.resolve).toHaveBeenCalledWith({
      pageUrl: FLORIDA_SENATE_PLAYER,
      hearingId: 'hearing-fl',
    });
  });

  it('still reports a missing canonical hearing without inventing a state denial', async () => {
    const h = adapter([[]]);
    const result = await h.value.resolveClassified({
      hearingId: 'hearing-missing',
      pageUrl: FLORIDA_SENATE_PLAYER,
    });
    expect(result.rawResult.note).toContain('Canonical hearing not found');
    expect(result.selected.reasonCode).not.toBe('STATE_CAPTURE_LINK_ONLY');
    expect(h.resolver.resolve).not.toHaveBeenCalled();
  });
});
