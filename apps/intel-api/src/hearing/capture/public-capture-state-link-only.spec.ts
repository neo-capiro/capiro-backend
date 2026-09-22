import { PublicCaptureAutomaticResolverAdapter } from './public-capture-automatic-resolver.adapter.js';
import { STATE_CAPTURE_LINK_ONLY } from '../state-capture-policy.js';

const FLORIDA_PAGE = 'https://thefloridachannel.org/videos/example-hearing/';
const FEDERAL_PAGE = 'https://www.armed-services.senate.gov/hearings/example';

function adapter(rawResults: unknown[][]) {
  const query = jest.fn().mockImplementation(async () => rawResults.shift() ?? []);
  const execute = jest.fn().mockResolvedValue(1);
  const resolver = {
    resolve: jest.fn(async () => ({
      status: 'resolved' as const,
      media: {
        url: 'https://www-senate-gov-media-srs.akamaized.net/live/master.m3u8',
        kind: 'hls' as const,
        provider: 'senate-isvp',
      },
    })),
  };
  return {
    value: new PublicCaptureAutomaticResolverAdapter(
      { $queryRawUnsafe: query, $executeRawUnsafe: execute } as never,
      resolver as never,
    ),
    query,
    resolver,
  };
}

describe('automatic state capture is link-only', () => {
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
    expect(h.resolver.resolve).not.toHaveBeenCalled();
  });

  it('preserves federal automatic resolution', async () => {
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
    expect(h.resolver.resolve).toHaveBeenCalledTimes(1);
  });
});
