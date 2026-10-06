import {
  AutomaticStreamResolver,
  buildStreamResolutionTargets,
} from './automatic-stream-resolver.js';

describe('automatic stream resolver', () => {
  it('continues past browser-only YouTube to a first-party Senate source', async () => {
    const resolve = jest.fn(async ({ pageUrl }: { pageUrl?: string }) => {
      if (pageUrl?.includes('senate-gov-media')) {
        return {
          status: 'resolved' as const,
          media: {
            url: pageUrl,
            kind: 'hls' as const,
            provider: 'senate-isvp',
          },
        };
      }
      return { status: 'unresolvable' as const, reference: pageUrl, note: 'No stream found' };
    });
    const resolver = new AutomaticStreamResolver({ resolve });

    const result = await resolver.resolve({
      hearingId: 'hearing-1',
      officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
      videos: [
        { url: 'https://www.youtube.com/watch?v=example', providerHint: 'youtube.com' },
        {
          url: 'https://www-senate-gov-media-srs.akamaized.net/example/master.m3u8',
          providerHint: 'senate-isvp',
        },
      ],
      context: {
        now: new Date('2026-08-20T14:00:00Z'),
        scheduledStart: new Date('2026-08-20T14:00:00Z'),
        publicAccess: 'PUBLIC',
      },
    });

    expect(result.selected.state).toBe('READY_FOR_SERVER_CAPTURE');
    expect(result.selectedTarget?.url).toContain('senate-gov-media');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('retains an unknown media host as review evidence without fetching it', async () => {
    const resolve = jest.fn();
    const resolver = new AutomaticStreamResolver({ resolve });
    const result = await resolver.resolve({
      hearingId: 'hearing-1',
      videos: [{ url: 'https://unknown-cdn.example/live.m3u8' }],
      context: { now: new Date(), publicAccess: 'PUBLIC' },
    });

    expect(result.selected.capturePolicy).toBe('REVIEW_REQUIRED');
    expect(result.attempts[0]?.skipped).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('surfaces a known browser stream when the future official event page has no media', async () => {
    const officialPageUrl = 'https://www.congress.gov/event/119th-congress/house-event/119575';
    const browserUrl = 'https://www.youtube.com/embed/R2JXs4FXjHw';
    const resolve = jest.fn(async ({ pageUrl }: { pageUrl?: string }) => ({
      status: 'unresolvable' as const,
      reference: pageUrl,
      note: 'No video links on the congress.gov event',
    }));
    const result = await new AutomaticStreamResolver({ resolve }).resolve({
      hearingId: 'cm-119-119575',
      officialPageUrl,
      videos: [{ url: browserUrl, providerHint: 'youtube' }],
      context: {
        now: new Date('2026-10-06T02:00:00Z'),
        scheduledStart: new Date('2026-10-06T14:00:00Z'),
        publicAccess: 'PUBLIC',
      },
    });
    expect(result.selected.state).toBe('BROWSER_CAPTURE_ONLY');
    expect(result.selected.capturePolicy).toBe('BROWSER_CAPTURE_ONLY');
    expect(result.selected.reasonCode).toBe('YOUTUBE_BROWSER_ONLY');
    expect(result.selectedTarget?.url).toBe(browserUrl);
    expect(result.rawResult.reference).toBe(browserUrl);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ pageUrl: officialPageUrl, hearingId: 'cm-119-119575' });
  });

  it('keeps an actual pending first-party source ahead of a browser-only option', async () => {
    const officialPageUrl = 'https://www.armed-services.senate.gov/hearings/upcoming';
    const resolve = jest.fn(async () => ({
      status: 'pending' as const,
      reference: officialPageUrl,
      note: 'The official stream is not live yet',
    }));
    const result = await new AutomaticStreamResolver({ resolve }).resolve({
      hearingId: 'hearing-1',
      officialPageUrl,
      videos: [{ url: 'https://www.youtube.com/embed/example' }],
      context: { now: new Date('2026-10-06T02:00:00Z'), publicAccess: 'PUBLIC' },
    });
    expect(result.selected.state).toBe('WAITING_FOR_STREAM');
    expect(result.selectedTarget?.url).toBe(officialPageUrl);
  });

  it('still waits for a future hearing with no published stream', async () => {
    const resolve = jest.fn(async () => ({
      status: 'unresolvable' as const,
      note: 'No stream found',
    }));
    const result = await new AutomaticStreamResolver({ resolve }).resolve({
      hearingId: 'hearing-1',
      officialPageUrl: 'https://www.congress.gov/event/119th-congress/house-event/119575',
      context: {
        now: new Date('2026-10-06T02:00:00Z'),
        scheduledStart: new Date('2026-10-06T14:00:00Z'),
        publicAccess: 'PUBLIC',
      },
    });
    expect(result.selected.state).toBe('WAITING_FOR_STREAM');
    expect(result.selected.reasonCode).toBe('NO_MEDIA_DISCOVERED');
  });

  it('ranks first-party media above the official event page', () => {
    const targets = buildStreamResolutionTargets({
      officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
      videos: [
        {
          url: 'https://www-senate-gov-media-srs.akamaized.net/example/master.m3u8',
        },
      ],
    });
    expect(targets[0]?.kind).toBe('MEDIA_REFERENCE');
  });
  it('does not auto-probe broad multi-tenant CDN hosts', () => {
    const target = buildStreamResolutionTargets({
      videos: [{ url: 'https://committee-media.akamaihd.net/live/master.m3u8' }],
    })[0];

    expect(target?.policyHint).toBe('REVIEW_REQUIRED');
    expect(target?.automaticProbeAllowed).toBe(false);
  });

  describe('Florida publisher pages (discovery writes them as hearing_stream_candidate rows)', () => {
    const FLAG = 'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED';
    const previous = process.env[FLAG];
    afterEach(() => {
      if (previous === undefined) delete process.env[FLAG];
      else process.env[FLAG] = previous;
    });
    const florida = [
      { url: 'https://www.flsenate.gov/media/VideoPlayer/6382', providerHint: 'flsenate' },
      { url: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179', providerHint: 'flhouse' },
    ];

    it('holds them as review evidence while the state switch is off', () => {
      delete process.env[FLAG];
      for (const target of buildStreamResolutionTargets({ videos: florida })) {
        expect(target.policyHint).toBe('REVIEW_REQUIRED');
        expect(target.automaticProbeAllowed).toBe(false);
      }
    });

    it('probes them as first-party candidates once the state switch is on', async () => {
      process.env[FLAG] = 'true';
      for (const target of buildStreamResolutionTargets({ videos: florida })) {
        expect(target.policyHint).toBe('FIRST_PARTY_CANDIDATE');
        expect(target.automaticProbeAllowed).toBe(true);
      }
      const resolve = jest.fn(async ({ pageUrl }: { pageUrl?: string }) => ({
        status: 'resolved' as const,
        reference: pageUrl,
        media: {
          url: 'https://cdnapi.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_abohhovv/protocol/https/format/applehttp/a.m3u8',
          kind: 'hls' as const,
          provider: 'florida-channel-kaltura',
          ipBound: false,
        },
      }));
      const result = await new AutomaticStreamResolver({ resolve }).resolve({
        hearingId: 'hearing-fl',
        videos: [florida[0]!],
        context: { now: new Date('2026-09-22T14:00:00Z'), publicAccess: 'PUBLIC' },
      });
      expect(resolve).toHaveBeenCalledWith({ pageUrl: florida[0]!.url, hearingId: 'hearing-fl' });
      expect(result.selected.state).toBe('READY_FOR_SERVER_CAPTURE');
      expect(result.selected.mayPersistResolvedMediaUrl).toBe(false);
    });

    it('never auto-probes a Kaltura media reference directly, even when the switch is on', () => {
      process.env[FLAG] = 'true';
      const target = buildStreamResolutionTargets({
        videos: [
          {
            url: 'https://cdnapisec.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_q58g4s8q/format/applehttp/protocol/https/a.m3u8',
          },
        ],
      })[0];
      expect(target?.automaticProbeAllowed).toBe(false);
    });
  });
});
