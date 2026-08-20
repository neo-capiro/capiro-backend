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

});
