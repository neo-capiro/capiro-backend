import {
  assessSchedulePolicy,
  browserJoinPlan,
  decodeTranscriptCursor,
  encodeTranscriptCursor,
  LiveHearingsPhase7Service,
} from './live-hearings-phase7.service.js';

describe('Live Hearings Phase 7 pure contracts', () => {
  const publicHearing = {
    id: 'h-1',
    title: 'Oversight hearing',
    type: 'hearing',
    eventStatus: 'scheduled',
    visibility: 'public',
    startsAt: new Date('2026-08-25T14:00:00Z'),
    date: new Date('2026-08-25T00:00:00Z'),
    committeeSystemCode: 'hsas00',
    subcommitteeSystemCode: null,
    committeeName: 'House Armed Services',
    url: 'https://armedservices.house.gov/hearings/example',
  };

  it('accepts unresolved public hearings for preflight instead of fabricating capture readiness', () => {
    expect(assessSchedulePolicy(publicHearing, [])).toMatchObject({
      allowed: true,
      state: 'PREFLIGHT_REQUIRED',
      reasonCode: 'STREAM_NOT_RESOLVED_YET',
    });
  });

  it('accepts a verified first-party server-capture source', () => {
    expect(
      assessSchedulePolicy(publicHearing, [
        { capturePolicy: 'SERVER_CAPTURE_ALLOWED', resolutionState: 'READY' },
      ]),
    ).toMatchObject({ allowed: true, state: 'READY', reasonCode: 'SERVER_CAPTURE_ALLOWED' });
  });

  it('rejects known browser-only and licensed-only sources for unattended capture', () => {
    expect(
      assessSchedulePolicy(publicHearing, [
        { capturePolicy: 'BROWSER_CAPTURE_ONLY', resolutionState: 'POLICY_BLOCKED' },
      ]),
    ).toMatchObject({ allowed: false, state: 'BROWSER_ONLY' });
    expect(
      assessSchedulePolicy(publicHearing, [
        { capturePolicy: 'LICENSE_REQUIRED', resolutionState: 'POLICY_BLOCKED' },
      ]),
    ).toMatchObject({ allowed: false, state: 'LICENSE_REQUIRED' });
  });

  it.each(['BROWSER_CAPTURE_ONLY', 'LICENSE_REQUIRED', 'BLOCKED'])(
    'does not allow an unresolved stream to override %s inside the service',
    (capturePolicy) => {
      expect(assessSchedulePolicy(publicHearing, [{
        capturePolicy,
        resolutionState: 'WAITING_FOR_STREAM',
      }])).toMatchObject({ allowed: false });
    },
  );

  it('rejects private, canceled, and completed proceedings', () => {
    expect(assessSchedulePolicy({ ...publicHearing, visibility: 'private' }, [])).toMatchObject({
      allowed: false,
      reasonCode: 'NON_PUBLIC_PROCEEDING',
    });
    expect(assessSchedulePolicy({ ...publicHearing, eventStatus: 'canceled' }, [])).toMatchObject({
      allowed: false,
      reasonCode: 'EVENT_CANCELED',
    });
    expect(assessSchedulePolicy({ ...publicHearing, eventStatus: 'completed' }, [])).toMatchObject({
      allowed: false,
      reasonCode: 'EVENT_COMPLETED',
    });
  });

  it('round-trips stable transcript keyset cursors and rejects malformed cursors', () => {
    const cursor = encodeTranscriptCursor(42, 'segment-42');
    expect(decodeTranscriptCursor(cursor)).toEqual({ sequence: 42, id: 'segment-42' });
    expect(decodeTranscriptCursor('not-a-valid-cursor')).toBeNull();
    expect(decodeTranscriptCursor()).toBeNull();
  });

  it('explicit browser join returns BROWSER_CAPTURE with provenance even while the canonical capture is active', () => {
    // An explicit user request to open a private browser context is INDEPENDENT
    // of the server recorder: an active/complete canonical capture must not
    // refuse it. The plan still carries the canonical capture id/status so the
    // UI can show "Capiro is capturing" alongside.
    const plan = browserJoinPlan(publicHearing as never, {
      id: 'capture-1',
      status: 'CAPTURING',
      storageStatus: 'capturing',
      scheduledStart: null,
      actualStart: null,
      actualEnd: null,
      capturedSeconds: 10,
      transcriptGapSeconds: 0,
      reconnectCount: 0,
      failureCode: null,
      failureDetail: null,
      resolutionState: 'READY',
      resolutionReasonCode: 'FIRST_PARTY_STREAM_READY',
      resolutionCapturePolicy: 'SERVER_CAPTURE_ALLOWED',
      resolutionProvider: 'senate-isvp',
      resolutionReference: 'https://www.senate.gov/event',
      terminalReasonCode: null,
      lastOutcomeAt: null,
    });
    expect(plan).toMatchObject({
      mode: 'BROWSER_CAPTURE',
      canonicalCaptureId: 'capture-1',
      canonicalCaptureStatus: 'CAPTURING',
    });
  });

  it('prefers a discovered official player page over the Congress.gov listing (FBI case)', () => {
    const fbiHearing = {
      ...publicHearing,
      id: 'cm-119-338740',
      title: 'Oversight of the Federal Bureau of Investigation',
      url: 'https://www.congress.gov/event/119th-congress/senate-event/338740',
    };
    const plan = browserJoinPlan(fbiHearing as never, null, [
      {
        provider: 'senate-isvp',
        officialPageUrl: 'https://www.senate.gov/isvp/?comm=judiciary&filename=judiciary091526',
        mediaUrl: null,
        capturePolicy: 'REVIEW_REQUIRED',
      },
    ]);
    expect(plan).toMatchObject({
      mode: 'BROWSER_CAPTURE',
      sourceUrl: 'https://www.senate.gov/isvp/?comm=judiciary&filename=judiciary091526',
      sourceKind: 'official_player_page',
      sourceProvider: 'senate-isvp',
      requiresStreamResolution: false,
    });
  });

  it('falls back to the official listing page only when no candidate page exists', () => {
    expect(browserJoinPlan(publicHearing as never, null, [])).toEqual(
      expect.objectContaining({
        mode: 'BROWSER_CAPTURE',
        sourceUrl: 'https://armedservices.house.gov/hearings/example',
        sourceKind: 'official_listing_page',
        requiresStreamResolution: true,
        audioSource: 'browser_mic',
        recordingPolicy: 'transcript_only',
      }),
    );
    expect(
      browserJoinPlan({ ...publicHearing, url: null } as never, null, []),
    ).toMatchObject({ mode: 'BLOCKED', reasonCode: 'OFFICIAL_PAGE_UNAVAILABLE' });
  });

  it('still offers browser replay for a public completed hearing with a source', () => {
    const plan = browserJoinPlan(
      { ...publicHearing, eventStatus: 'completed' } as never,
      null,
      [
        {
          provider: 'house-live',
          officialPageUrl: 'https://armedservices.house.gov/hearings/example',
          mediaUrl: null,
          capturePolicy: 'SERVER_CAPTURE_ALLOWED',
        },
      ],
    );
    expect(plan).toMatchObject({ mode: 'BROWSER_CAPTURE' });
  });

  it('blocks a non-public hearing even when its earlier public capture still exists', () => {
    expect(browserJoinPlan({ ...publicHearing, visibility: 'private' } as never, {
      id: 'earlier-public-capture', status: 'CAPTURING',
    } as never)).toMatchObject({ mode: 'BLOCKED', reasonCode: 'NON_PUBLIC_PROCEEDING' });
  });

  it('retains a transcript catch-up cursor at the live tail and through an empty poll', async () => {
    const raw = jest.fn()
      .mockResolvedValueOnce([{ captureId: 'capture-1', domainStatus: 'CAPTURING' }])
      .mockResolvedValueOnce([{ id: 'seg-500', sequence: 500, text: 'Still recording', isFinal: true }])
      .mockResolvedValueOnce([{ count: 500 }])
      .mockResolvedValueOnce([{ captureId: 'capture-1', domainStatus: 'CAPTURING' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 500 }]);
    const service = new LiveHearingsPhase7Service({
      committeeHearing: { findUnique: jest.fn().mockResolvedValue(publicHearing) },
      $queryRawUnsafe: raw,
    } as never, {} as never, {} as never);
    const tail = await service.transcript('h-1', { cursor: encodeTranscriptCursor(499, 'seg-499') });
    expect(tail).toMatchObject({ hasMore: false, nextCursor: null,
      resumeCursor: encodeTranscriptCursor(500, 'seg-500') });
    const poll = await service.transcript('h-1', { cursor: encodeTranscriptCursor(500, 'seg-500') });
    expect(poll).toMatchObject({ items: [], hasMore: false,
      resumeCursor: encodeTranscriptCursor(500, 'seg-500') });
  });

  it('rejects a private transcript before reading an existing capture', async () => {
    const raw = jest.fn();
    const service = new LiveHearingsPhase7Service({
      committeeHearing: { findUnique: jest.fn().mockResolvedValue({ ...publicHearing, visibility: 'private' }) },
      $queryRawUnsafe: raw,
    } as never, {} as never, {} as never);
    await expect(service.transcript('h-1', {})).rejects.toMatchObject({ status: 403 });
    expect(raw).not.toHaveBeenCalled();
  });
});
