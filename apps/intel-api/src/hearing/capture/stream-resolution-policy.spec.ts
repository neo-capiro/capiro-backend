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

  it('expires grace from a calendar-date-only scheduledStart (starts_at null historical rows)', () => {
    // congress.gov historical rows often have starts_at=null and only a date
    // (UTC midnight). The adapter COALESCE's date into scheduledStart so this
    // path can terminalize instead of looping WAITING_FOR_STREAM forever.
    const result = classifyStreamResolution(
      { status: 'unresolvable', note: 'No stream found on the committee page' },
      {
        now: new Date('2026-08-30T12:00:00Z'),
        scheduledStart: new Date('2026-07-14T00:00:00.000Z'),
        delayedStartGraceMs: 90 * 60 * 1000,
      },
    );
    expect(result.state).toBe('NO_PUBLIC_STREAM');
    expect(result.reasonCode).toBe('NO_MEDIA_DISCOVERED');
    expect(result.terminal).toBe(true);
  });

  it('stays WAITING when scheduledStart is missing entirely (cannot invent a cutoff)', () => {
    const result = classifyStreamResolution(
      { status: 'unresolvable', note: 'No stream found on the committee page' },
      { now: new Date('2026-08-30T12:00:00Z') },
    );
    expect(result.state).toBe('WAITING_FOR_STREAM');
    expect(result.terminal).toBe(false);
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

  describe('The Florida Channel Kaltura manifests (LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED)', () => {
    const FLAG = 'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED';
    const previous = process.env[FLAG];
    afterEach(() => {
      if (previous === undefined) delete process.env[FLAG];
      else process.env[FLAG] = previous;
    });
    const manifest = (partner = '2593311') => ({
      status: 'resolved' as const,
      reference: 'https://www.flsenate.gov/media/VideoPlayer/6382',
      media: {
        url: `https://cdnapi.kaltura.com/p/${partner}/sp/${partner}00/playManifest/entryId/1_abohhovv/protocol/https/format/applehttp/a.m3u8`,
        kind: 'hls' as const,
        provider: 'florida-channel-kaltura',
        ipBound: false,
      },
    });

    it('allows server capture of a Florida Channel manifest once the switch is on, without persisting it', () => {
      process.env[FLAG] = 'true';
      expect(
        classifyStreamResolution(manifest(), { now, scheduledStart, publicAccess: 'PUBLIC' }),
      ).toEqual(
        expect.objectContaining({
          state: 'READY_FOR_SERVER_CAPTURE',
          capturePolicy: 'SERVER_CAPTURE_ALLOWED',
          reasonCode: 'FIRST_PARTY_STREAM_READY',
          provider: 'florida-channel-kaltura',
          requiresJustInTimeReresolution: true,
          mayPersistResolvedMediaUrl: false,
        }),
      );
    });

    it.each([undefined, 'false'])('holds the same manifest for review while the switch is %s', (value) => {
      if (value === undefined) delete process.env[FLAG];
      else process.env[FLAG] = value;
      expect(
        classifyStreamResolution(manifest(), { now, scheduledStart, publicAccess: 'PUBLIC' }),
      ).toEqual(
        expect.objectContaining({
          state: 'POLICY_BLOCKED',
          capturePolicy: 'REVIEW_REQUIRED',
          reasonCode: 'UNKNOWN_PROVIDER_REVIEW_REQUIRED',
        }),
      );
    });

    it('never approves another Kaltura partner, even when the switch is on', () => {
      process.env[FLAG] = 'true';
      expect(
        classifyStreamResolution(manifest('1234567'), { now, scheduledStart, publicAccess: 'PUBLIC' })
          .capturePolicy,
      ).toBe('REVIEW_REQUIRED');
    });

    it('keeps an explicit STATE_CAPTURE_LINK_ONLY note terminal regardless of the switch', () => {
      process.env[FLAG] = 'true';
      const result = classifyStreamResolution(
        { status: 'unresolvable', note: 'STATE_CAPTURE_LINK_ONLY' },
        { now, scheduledStart },
      );
      expect(result).toEqual(
        expect.objectContaining({
          state: 'POLICY_BLOCKED',
          capturePolicy: 'BLOCKED',
          reasonCode: 'STATE_CAPTURE_LINK_ONLY',
          terminal: true,
        }),
      );
    });

    it('treats a waiting Florida player reference as a server-capture candidate only when on', () => {
      const waiting = () =>
        classifyStreamResolution(
          {
            status: 'unresolvable',
            reference: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=11179',
            note: 'Verified Florida House VideoPlayer event 11179',
          },
          { now: new Date('2026-08-20T13:55:00Z'), scheduledStart, publicAccess: 'PUBLIC' },
        );
      delete process.env[FLAG];
      expect(waiting()).toMatchObject({ state: 'WAITING_FOR_STREAM', capturePolicy: 'REVIEW_REQUIRED' });
      process.env[FLAG] = 'true';
      expect(waiting()).toMatchObject({
        state: 'WAITING_FOR_STREAM',
        capturePolicy: 'SERVER_CAPTURE_ALLOWED',
      });
    });
  });
});
