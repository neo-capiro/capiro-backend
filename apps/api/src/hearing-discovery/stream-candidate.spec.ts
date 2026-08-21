/**
 * Capture-policy classification at DISCOVERY time.
 *
 * The property under test is a hard ceiling: nothing in Phase 3 may declare a
 * stream server-capturable. Discovery has not probed the URL, has not run the
 * SSRF net-guard, and has not consulted the YouTube/C-SPAN legal gates — all of
 * which live in intel-api's existing StreamResolverService. If this ceiling ever
 * lifted, an unprobed third-party stream could reach a capture worker on the
 * strength of a scrape, which is exactly the failure the boundary exists to
 * prevent.
 *
 * The other property is separation of origins: a `.gov` page that embeds YouTube
 * is NOT a first-party media transport, and the page URL must never be mistaken
 * for the media URL.
 */
import { classifyObservedCandidate } from './stream-candidate.repository.js';

describe('classifyObservedCandidate — policy ceiling', () => {
  it('never returns SERVER_CAPTURE_ALLOWED, even when an adapter asks for it', () => {
    const result = classifyObservedCandidate({
      provider: 'house-live',
      officialPageUrl: 'https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=1',
      mediaUrl: 'https://houselive.house.gov/live/stream.m3u8',
      capturePolicy: 'SERVER_CAPTURE_ALLOWED',
    });
    expect(result.capturePolicy).not.toBe('SERVER_CAPTURE_ALLOWED');
    expect(result.capturePolicy).toBe('REVIEW_REQUIRED');
  });

  it('defaults an unannotated first-party candidate to REVIEW_REQUIRED, not allowed', () => {
    const result = classifyObservedCandidate({
      provider: '',
      officialPageUrl: 'https://www.senate.gov/isvp/?comm=armed',
      mediaUrl: 'https://www-senate-gov-media-srs.akamaized.net/hls/live/x/armed.m3u8',
    });
    expect(result.capturePolicy).toBe('REVIEW_REQUIRED');
  });
});

describe('classifyObservedCandidate — third-party hosts', () => {
  it('marks C-SPAN BLOCKED, so it can never be auto-server-captured', () => {
    const result = classifyObservedCandidate({
      provider: '',
      officialPageUrl: 'https://www.c-span.org/video/?123-1/hearing',
    });
    expect(result.provider).toBe('c-span');
    expect(result.capturePolicy).toBe('BLOCKED');
  });

  it('marks YouTube BROWSER_CAPTURE_ONLY rather than server-capturable', () => {
    const result = classifyObservedCandidate({
      provider: '',
      officialPageUrl: 'https://www.youtube.com/watch?v=abc',
    });
    expect(result.provider).toBe('youtube');
    expect(result.capturePolicy).toBe('BROWSER_CAPTURE_ONLY');
  });

  it.each([
    ['https://www.facebook.com/x/videos/1', 'facebook', 'BLOCKED'],
    ['https://x.com/i/broadcasts/1', 'x', 'BLOCKED'],
    ['https://vimeo.com/12345', 'vimeo', 'BROWSER_CAPTURE_ONLY'],
    ['https://youtu.be/abc', 'youtube', 'BROWSER_CAPTURE_ONLY'],
  ])('classifies %s as %s / %s', (url, provider, policy) => {
    const result = classifyObservedCandidate({ provider: '', officialPageUrl: url });
    expect(result.provider).toBe(provider);
    expect(result.capturePolicy).toBe(policy);
  });
});

describe('classifyObservedCandidate — origin separation', () => {
  it('lets the MEDIA host decide policy when a .gov page carries a third-party media URL', () => {
    // A committee page embedding YouTube is not a first-party transport.
    const result = classifyObservedCandidate({
      provider: '',
      officialPageUrl: 'https://energycommerce.house.gov/hearings/oversight',
      mediaUrl: 'https://www.youtube.com/embed/abc',
    });
    expect(result.provider).toBe('youtube');
    expect(result.capturePolicy).toBe('BROWSER_CAPTURE_ONLY');
  });

  it('falls back to the PAGE host only when there is no media URL', () => {
    const result = classifyObservedCandidate({
      provider: '',
      officialPageUrl: 'https://www.senate.gov/committees/hearings',
    });
    expect(result.provider).toBe('senate-isvp');
  });

  it('does not upgrade a candidate an adapter already restricted', () => {
    const result = classifyObservedCandidate({
      provider: 'senate-isvp',
      officialPageUrl: 'https://www.senate.gov/x',
      capturePolicy: 'BLOCKED',
    });
    expect(result.capturePolicy).toBe('BLOCKED');
  });
});

describe('classifyObservedCandidate — media typing', () => {
  it('recognises an HLS manifest', () => {
    expect(
      classifyObservedCandidate({
        provider: '',
        officialPageUrl: 'https://x.senate.gov/p',
        mediaUrl: 'https://x.senate.gov/live/stream.m3u8?token=1',
      }).mediaType,
    ).toBe('hls');
  });

  it('recognises a progressive MP4', () => {
    expect(
      classifyObservedCandidate({
        provider: '',
        officialPageUrl: 'https://x.senate.gov/p',
        mediaUrl: 'https://x.senate.gov/archive/hearing.mp4',
      }).mediaType,
    ).toBe('mp4');
  });

  it('reports an unrecognised media URL as unknown rather than guessing', () => {
    expect(
      classifyObservedCandidate({
        provider: '',
        officialPageUrl: 'https://x.senate.gov/p',
        mediaUrl: 'https://x.senate.gov/player?id=7',
      }).mediaType,
    ).toBe('unknown');
  });

  it('reports no media type at all when only a page was advertised', () => {
    expect(
      classifyObservedCandidate({ provider: '', officialPageUrl: 'https://x.senate.gov/p' })
        .mediaType,
    ).toBeNull();
  });

  it('survives an unparseable URL without throwing', () => {
    const result = classifyObservedCandidate({ provider: '', officialPageUrl: 'not a url' });
    expect(result.provider).toBe('unknown');
    expect(result.capturePolicy).toBe('REVIEW_REQUIRED');
  });
});
