import {
  assessSchedulePolicy,
  browserJoinPlan,
  decodeTranscriptCursor,
  encodeTranscriptCursor,
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

  it('attaches to an existing canonical capture rather than starting a second browser transcript', () => {
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
      mode: 'ATTACH_CANONICAL',
      captureId: 'capture-1',
      reasonCode: 'CANONICAL_CAPTURE_ACTIVE',
    });
  });

  it('uses only the official page for browser-assisted fallback', () => {
    expect(browserJoinPlan(publicHearing as never, null)).toEqual(
      expect.objectContaining({
        mode: 'BROWSER_CAPTURE',
        sourceUrl: 'https://armedservices.house.gov/hearings/example',
        audioSource: 'browser_mic',
        recordingPolicy: 'transcript_only',
      }),
    );
    expect(
      browserJoinPlan({ ...publicHearing, url: null } as never, null),
    ).toMatchObject({ mode: 'BLOCKED', reasonCode: 'OFFICIAL_PAGE_UNAVAILABLE' });
  });
});
