import { classifyStreamResolution } from './stream-resolution-policy.js';

const now = new Date('2026-08-20T14:00:00Z');
const scheduledStart = new Date('2026-08-20T14:05:00Z');

describe('stream resolution policy', () => {
  it('allows first-party Senate ISVP while requiring ingest-time re-resolution', () => {
    expect(
      classifyStreamResolution(
        {
          status: 'resolved',
          media: {
            url: 'https://www-senate-gov-media-srs.akamaized.net/hls/live/1/armed/file/master.m3u8',
            kind: 'hls',
            provider: 'senate-isvp',
          },
        },
        { now, scheduledStart, publicAccess: 'PUBLIC' },
      ),
    ).toEqual(
      expect.objectContaining({
        state: 'READY_FOR_SERVER_CAPTURE',
        capturePolicy: 'SERVER_CAPTURE_ALLOWED',
        reasonCode: 'FIRST_PARTY_STREAM_READY',
        requiresJustInTimeReresolution: true,
      }),
    );
  });

  it('never turns an official-page YouTube transport into server permission', () => {
    expect(
      classifyStreamResolution(
        {
          status: 'resolved',
          media: {
            url: 'https://www.youtube.com/watch?v=example',
            kind: 'hls',
            provider: 'youtube-live',
            ipBound: true,
          },
        },
        { now, scheduledStart, publicAccess: 'PUBLIC' },
      ),
    ).toEqual(
      expect.objectContaining({
        state: 'BROWSER_CAPTURE_ONLY',
        capturePolicy: 'BROWSER_CAPTURE_ONLY',
        reasonCode: 'YOUTUBE_BROWSER_ONLY',
        mayPersistResolvedMediaUrl: false,
      }),
    );
  });

  it('keeps C-SPAN blocked behind a license', () => {
    const result = classifyStreamResolution(
      {
        status: 'unresolvable',
        reference: 'https://www.c-span.org/program/x/example/12345',
        note: 'C-SPAN extraction disabled',
      },
      { now, scheduledStart },
    );
    expect(result.state).toBe('POLICY_BLOCKED');
    expect(result.capturePolicy).toBe('LICENSE_REQUIRED');
  });

  it('keeps a pending official stream retryable before the delayed-start cutoff', () => {
    const result = classifyStreamResolution(
      { status: 'pending', reference: 'https://armed-services.senate.gov/hearings/example' },
      { now, scheduledStart, delayedStartGraceMs: 60 * 60 * 1000 },
    );
    expect(result.state).toBe('WAITING_FOR_STREAM');
    expect(result.retryable).toBe(true);
    expect(result.terminal).toBe(false);
  });

  it('turns unresolved media into an auditable no-stream result after grace expires', () => {
    const result = classifyStreamResolution(
      { status: 'unresolvable', note: 'No stream found on the committee page' },
      {
        now: new Date('2026-08-20T16:00:01Z'),
        scheduledStart: new Date('2026-08-20T14:00:00Z'),
        delayedStartGraceMs: 60 * 60 * 1000,
      },
    );
    expect(result.state).toBe('NO_PUBLIC_STREAM');
    expect(result.terminal).toBe(true);
  });

  it('blocks closed and classified proceedings before considering media', () => {
    const closed = classifyStreamResolution(
      { status: 'pending' },
      { now, scheduledStart, publicAccess: 'CLOSED' },
    );
    const classified = classifyStreamResolution(
      { status: 'pending' },
      { now, scheduledStart, publicAccess: 'CLASSIFIED' },
    );
    expect(closed.reasonCode).toBe('CLOSED_PROCEEDING');
    expect(classified.reasonCode).toBe('CLASSIFIED_PROCEEDING');
  });

  it('treats a not-yet-published official stream as waiting rather than a source failure', () => {
    const result = classifyStreamResolution(
      {
        status: 'unresolvable',
        reference: 'https://www.armed-services.senate.gov/hearings/example',
        note: 'No stream found on the committee page',
      },
      {
        now: new Date('2026-08-20T13:55:00Z'),
        scheduledStart: new Date('2026-08-20T14:00:00Z'),
        publicAccess: 'PUBLIC',
      },
    );
    expect(result.state).toBe('WAITING_FOR_STREAM');
    expect(result.retryable).toBe(true);
  });

});
