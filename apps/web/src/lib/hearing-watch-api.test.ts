import { describe, expect, test, vi } from 'vitest';

// hearing-watch-api.ts imports useApi (-> api-client.ts -> env.ts), which
// throws at module-load time without a Clerk env var set up. isMediaUrl
// itself has no such dependency; mock this out so the pure-function tests
// below don't need the full app env, matching the pattern already used in
// HearingWatchPage.test.tsx for the same import chain.
vi.mock('./use-api.js', () => ({ useApi: () => ({ get: vi.fn(), post: vi.fn() }) }));

const { isMediaUrl } = await import('./hearing-watch-api.js');

describe('isMediaUrl', () => {
  test('recognizes direct media file URLs', () => {
    expect(isMediaUrl('https://example.com/hearing.m3u8')).toBe(true);
    expect(isMediaUrl('https://example.com/hearing.mp4?x=1')).toBe(true);
    expect(isMediaUrl('https://example.com/audio.mp3#t=10')).toBe(true);
  });

  test('recognizes stream/manifest/playlist as a distinct path segment', () => {
    expect(isMediaUrl('https://example.com/hls/stream/index')).toBe(true);
    expect(isMediaUrl('https://example.com/hls-manifest/x')).toBe(true);
    expect(isMediaUrl('https://example.com/playlist.txt')).toBe(true);
  });

  test('does NOT false-positive on ordinary event pages mentioning "stream"', () => {
    // Regression: a bare substring match previously flagged any URL merely
    // containing "stream"/"manifest"/"playlist" as text, which would falsely
    // treat a House committee's plain event page as an ingestible media URL —
    // silently defeating the browser-capture fallback for exactly the case it
    // was built for.
    expect(isMediaUrl('https://oversight.house.gov/hearings/watch-livestream')).toBe(false);
    expect(isMediaUrl('https://example.com/committee/streaming-schedule')).toBe(false);
    expect(isMediaUrl('https://www.congress.gov/committee-schedule/mainstream-media-day')).toBe(
      false,
    );
  });

  test('does not match a plain event/committee page', () => {
    expect(isMediaUrl('https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=1')).toBe(
      false,
    );
    expect(isMediaUrl('https://www.congress.gov/event/x')).toBe(false);
  });

  test('handles null/undefined', () => {
    expect(isMediaUrl(null)).toBe(false);
    expect(isMediaUrl(undefined)).toBe(false);
  });
});
