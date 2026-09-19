/**
 * LegiWatch V2 Wave 1 (W1-2) — attendance state derivation.
 *
 * This is the single function both the UI affordances and the server's
 * request-boundary enforcement read, so these tests are the proof that an
 * honest label and a refused request can never disagree.
 *
 * The closed-session cases are the ones that matter most: a classified or
 * executive proceeding must never be offered "Attend live", automatic capture,
 * or browser capture, whatever else the row says.
 */
import {
  assessAttendance,
  isVerifiedClosed,
  refuseAttendanceRequest,
  type AttendanceCandidateRow,
  type AttendanceHearingRow,
} from './legiwatch-wave1-attendance.js';

const PUBLIC_UPCOMING: AttendanceHearingRow = {
  id: 'h-1',
  visibility: 'public',
  eventStatus: 'scheduled',
  url: 'https://armedservices.house.gov/hearings/1',
};

const SERVER_OK: AttendanceCandidateRow[] = [
  { capturePolicy: 'SERVER_CAPTURE_ALLOWED', resolutionState: 'READY' },
];
const BROWSER_ONLY: AttendanceCandidateRow[] = [
  { capturePolicy: 'BROWSER_CAPTURE_ONLY', resolutionState: 'READY' },
];
const LICENSED: AttendanceCandidateRow[] = [
  { capturePolicy: 'LICENSE_REQUIRED', resolutionState: 'READY' },
];
const BLOCKED: AttendanceCandidateRow[] = [
  { capturePolicy: 'BLOCKED', resolutionState: 'POLICY_BLOCKED' },
];

describe('isVerifiedClosed', () => {
  it('treats the verified non-public vocabulary as closed', () => {
    for (const v of ['private', 'closed', 'classified', 'executive', 'PRIVATE']) {
      expect(isVerifiedClosed(v)).toBe(true);
    }
  });

  it('does NOT call an unknown visibility closed', () => {
    // Capture still fails closed for these, but the product must not tell the
    // user a proceeding is closed when the source never said so.
    for (const v of ['public', 'unknown', '', null, undefined]) {
      expect(isVerifiedClosed(v)).toBe(false);
    }
  });
});

describe('assessAttendance — eligibility', () => {
  it('offers automatic attendance on an approved server-capture source', () => {
    const a = assessAttendance({ hearing: PUBLIC_UPCOMING, candidates: SERVER_OK });
    expect(a.state).toBe('AUTOMATIC_AVAILABLE');
    expect(a.canRequest).toBe(true);
    expect(a.availableModes).toEqual(['automatic', 'browser']);
    expect(a.consentRequired).toBe(false);
  });

  it('accepts demand before the stream is resolved, as preflight-pending', () => {
    const a = assessAttendance({ hearing: PUBLIC_UPCOMING, candidates: [] });
    expect(a.state).toBe('AUTOMATIC_PENDING_PREFLIGHT');
    expect(a.canRequest).toBe(true);
  });

  it('offers ONLY browser attendance on a browser-only source, with consent', () => {
    const a = assessAttendance({ hearing: PUBLIC_UPCOMING, candidates: BROWSER_ONLY });
    expect(a.state).toBe('BROWSER_ONLY');
    expect(a.availableModes).toEqual(['browser']);
    expect(a.consentRequired).toBe(true);
  });

  it('offers nothing when a browser-only source has no official page to open', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, url: null },
      candidates: BROWSER_ONLY,
    });
    expect(a.canRequest).toBe(false);
    expect(a.availableModes).toEqual([]);
  });

  it('reports a licensed source as not eligible, not as browser-capturable', () => {
    const a = assessAttendance({ hearing: PUBLIC_UPCOMING, candidates: LICENSED });
    expect(a.state).toBe('NOT_ELIGIBLE');
    expect(a.reasonCode).toBe('LICENSE_REQUIRED');
    expect(a.availableModes).toEqual([]);
  });

  it('distinguishes "public but nothing capturable" from other blocks', () => {
    const a = assessAttendance({ hearing: PUBLIC_UPCOMING, candidates: BLOCKED });
    expect(a.state).toBe('NO_PUBLIC_STREAM');
    expect(a.reasonCode).toBe('NO_SERVER_CAPTURABLE_SOURCE');
  });

  it('reports a cancelled event as not eligible', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'canceled' },
      candidates: SERVER_OK,
    });
    expect(a.state).toBe('NOT_ELIGIBLE');
    expect(a.reasonCode).toBe('EVENT_CANCELED');
    expect(a.canRequest).toBe(false);
  });
});

describe('assessAttendance — closed sessions', () => {
  const closed: AttendanceHearingRow = {
    id: 'h-closed',
    visibility: 'private',
    eventStatus: 'scheduled',
    url: 'https://armedservices.house.gov/hearings/closed',
  };

  it('is CLOSED_SESSION with no attendance affordance at all', () => {
    const a = assessAttendance({ hearing: closed, candidates: [] });
    expect(a.state).toBe('CLOSED_SESSION');
    expect(a.canRequest).toBe(false);
    expect(a.availableModes).toEqual([]);
  });

  it('stays closed even when a server-capturable source is somehow attached', () => {
    // Precedence matters: a stray candidate row must not unlock a closed session.
    const a = assessAttendance({ hearing: closed, candidates: SERVER_OK });
    expect(a.state).toBe('CLOSED_SESSION');
    expect(a.availableModes).toEqual([]);
  });

  it('stays closed even when a capture record exists', () => {
    const a = assessAttendance({
      hearing: closed,
      candidates: SERVER_OK,
      capture: { domainStatus: 'COMPLETE' },
      hasTranscript: true,
    });
    expect(a.state).toBe('CLOSED_SESSION');
  });

  it('refuses an automatic request at the boundary', () => {
    const a = assessAttendance({ hearing: closed, candidates: SERVER_OK });
    expect(refuseAttendanceRequest(a, 'automatic')).toEqual({
      code: 'CLOSED_PROCEEDING',
      message: expect.stringContaining('closed session'),
    });
  });

  it('refuses a browser request at the boundary too', () => {
    const a = assessAttendance({ hearing: closed, candidates: SERVER_OK });
    expect(refuseAttendanceRequest(a, 'browser')?.code).toBe('CLOSED_PROCEEDING');
  });
});

describe('assessAttendance — lifecycle', () => {
  it('reports a running capture as CAPTURING', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'in_progress' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'CAPTURING' },
    });
    expect(a.state).toBe('CAPTURING');
    expect(a.canRequest).toBe(false);
  });

  it('reports a finished capture WITH a transcript as COMPLETE', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'completed' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'COMPLETE' },
      hasTranscript: true,
    });
    expect(a.state).toBe('COMPLETE');
  });

  it('reports a finished capture WITHOUT a transcript as PROCESSING', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'completed' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'COMPLETE' },
      hasTranscript: false,
    });
    // Saying COMPLETE here is what makes a user open a hearing and find nothing.
    expect(a.state).toBe('PROCESSING');
  });

  it('treats COMPLETE_WITH_GAPS as complete, not failed', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'completed' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'COMPLETE_WITH_GAPS' },
      hasTranscript: true,
    });
    expect(a.state).toBe('COMPLETE');
  });

  it('surfaces the durable failure code on a failed capture', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'completed' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'FAILED', failureCode: 'MEDIA_CONNECTION_LOST' },
    });
    expect(a.state).toBe('FAILED');
    expect(a.reasonCode).toBe('MEDIA_CONNECTION_LOST');
  });

  it('reports this tenant’s own demand as SCHEDULED', () => {
    const a = assessAttendance({
      hearing: PUBLIC_UPCOMING,
      candidates: SERVER_OK,
      subscription: { scheduledByUser: true, attendanceMode: 'automatic' },
    });
    expect(a.state).toBe('SCHEDULED');
    expect(a.scheduled).toBe(true);
    expect(a.canRequest).toBe(false);
  });

  it('names browser attendance in the scheduled message', () => {
    const a = assessAttendance({
      hearing: PUBLIC_UPCOMING,
      candidates: BROWSER_ONLY,
      subscription: { scheduledByUser: true, attendanceMode: 'browser' },
    });
    expect(a.message).toContain('Browser attendance');
  });

  it('leaves a queued canonical capture to this tenant’s own demand row', () => {
    // domain_status SCHEDULED means the capture is queued; whether THIS tenant
    // is attending is a separate question.
    const a = assessAttendance({
      hearing: PUBLIC_UPCOMING,
      candidates: SERVER_OK,
      capture: { domainStatus: 'SCHEDULED' },
    });
    expect(a.state).toBe('AUTOMATIC_AVAILABLE');
    expect(a.scheduled).toBe(false);
  });
});

describe('refuseAttendanceRequest', () => {
  it('permits a valid automatic request', () => {
    const a = assessAttendance({ hearing: PUBLIC_UPCOMING, candidates: SERVER_OK });
    expect(refuseAttendanceRequest(a, 'automatic')).toBeNull();
  });

  it('refuses automatic capture on a browser-only source', () => {
    const a = assessAttendance({ hearing: PUBLIC_UPCOMING, candidates: BROWSER_ONLY });
    expect(refuseAttendanceRequest(a, 'automatic')).toEqual({
      code: 'ATTENDANCE_MODE_NOT_AVAILABLE',
      message: expect.stringContaining('not permitted'),
    });
  });

  it('permits browser attendance on a browser-only source', () => {
    const a = assessAttendance({ hearing: PUBLIC_UPCOMING, candidates: BROWSER_ONLY });
    expect(refuseAttendanceRequest(a, 'browser')).toBeNull();
  });

  it('refuses any request on a terminal state', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'completed' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'COMPLETE' },
      hasTranscript: true,
    });
    expect(refuseAttendanceRequest(a, 'automatic')?.code).toBe('CAPTURE_COMPLETE');
  });

  it('treats a re-request from an already-scheduled tenant as idempotent', () => {
    const a = assessAttendance({
      hearing: PUBLIC_UPCOMING,
      candidates: SERVER_OK,
      subscription: { scheduledByUser: true, attendanceMode: 'automatic' },
    });
    // Not an error — the caller simply re-applies the configuration.
    expect(refuseAttendanceRequest(a, 'automatic')).toBeNull();
  });
});

describe('assessAttendance — independent browser/server capabilities', () => {
  it('exposes browserAvailable and automaticAvailable independently on a fresh public hearing', () => {
    const a = assessAttendance({ hearing: PUBLIC_UPCOMING, candidates: SERVER_OK });
    expect(a.automaticAvailable).toBe(true);
    expect(a.browserAvailable).toBe(true);
  });

  it('keeps browserAvailable true while the canonical capture is active (browser fallback not locked out)', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'in_progress' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'CAPTURING' },
    });
    expect(a.state).toBe('CAPTURING');
    // Phase 7 reuses the one canonical capture, so an active capture is not a
    // duplicate recorder: another tenant's automatic demand is still accepted.
    expect(a.automaticAvailable).toBe(true);
    expect(a.browserAvailable).toBe(true); // the user may still open a browser
  });

  it('keeps automaticAvailable true when the user only has browser intent (browser does not lock out server)', () => {
    const a = assessAttendance({
      hearing: PUBLIC_UPCOMING,
      candidates: SERVER_OK,
      subscription: { scheduledByUser: false, attendanceMode: 'browser' },
    });
    expect(a.automaticAvailable).toBe(true);
    expect(a.browserAvailable).toBe(true);
  });

  it('allows a browser-scheduled tenant to ADD automatic attendance (browser -> automatic)', () => {
    const a = assessAttendance({
      hearing: PUBLIC_UPCOMING,
      candidates: SERVER_OK,
      subscription: { scheduledByUser: false, attendanceMode: 'browser' },
    });
    expect(refuseAttendanceRequest(a, 'automatic')).toBeNull();
  });

  it('allows an automatic-scheduled tenant to OPEN browser attendance (automatic -> browser)', () => {
    const a = assessAttendance({
      hearing: PUBLIC_UPCOMING,
      candidates: SERVER_OK,
      subscription: { scheduledByUser: true, attendanceMode: 'automatic' },
    });
    expect(refuseAttendanceRequest(a, 'browser')).toBeNull();
  });

  it('keeps browserAvailable true on a REVIEW_REQUIRED source (FBI case) while server is preflight-pending', () => {
    const a = assessAttendance({
      hearing: PUBLIC_UPCOMING,
      candidates: [{ capturePolicy: 'REVIEW_REQUIRED', resolutionState: 'NOT_CHECKED' }],
    });
    expect(a.state).toBe('AUTOMATIC_PENDING_PREFLIGHT');
    expect(a.automaticAvailable).toBe(true);
    expect(a.browserAvailable).toBe(true);
  });

  it('keeps browserAvailable true on a FAILED capture when a public source exists', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'completed' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'FAILED', failureCode: 'MEDIA_CONNECTION_LOST' },
    });
    expect(a.state).toBe('FAILED');
    expect(a.browserAvailable).toBe(true);
  });

  it.each(['FAILED', 'CANCELED', 'BLOCKED', 'COMPLETE', 'COMPLETE_WITH_GAPS'])(
    'sets automaticAvailable=false on a terminal %s canonical capture (worker returns TERMINAL, no reset)',
    (domainStatus) => {
      const a = assessAttendance({
        hearing: { ...PUBLIC_UPCOMING, eventStatus: 'completed' },
        candidates: SERVER_OK,
        capture: { domainStatus },
        hasTranscript: true,
      });
      expect(a.automaticAvailable).toBe(false);
      // The browser fallback stays available even though automatic is not.
      expect(a.browserAvailable).toBe(true);
      // And the request boundary refuses automatic rather than claiming a
      // capture the worker would immediately return TERMINAL on.
      expect(refuseAttendanceRequest(a, 'automatic')).not.toBeNull();
    },
  );

  it('never exposes browserAvailable for a closed session', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, visibility: 'private' },
      candidates: SERVER_OK,
    });
    expect(a.browserAvailable).toBe(false);
    expect(a.automaticAvailable).toBe(false);
  });

  it('never exposes browserAvailable for a canceled event', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'canceled' },
      candidates: SERVER_OK,
    });
    expect(a.browserAvailable).toBe(false);
  });
});

describe('refuseAttendanceRequest — per-mode independent boundary', () => {
  it('permits a browser request while the canonical capture is ACTIVE', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'in_progress' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'CAPTURING' },
    });
    expect(refuseAttendanceRequest(a, 'browser')).toBeNull();
  });

  it('permits a browser request after the canonical capture is COMPLETE (replay)', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'completed' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'COMPLETE' },
      hasTranscript: true,
    });
    expect(refuseAttendanceRequest(a, 'browser')).toBeNull();
  });

  it('permits a browser replay for a completed Florida-style hearing with a watch source', () => {
    const a = assessAttendance({
      hearing: {
        id: 'fl-1',
        visibility: 'public',
        eventStatus: 'completed',
        url: 'https://thefloridachannel.org/videos/092626-senate-session/',
      },
      candidates: [],
    });
    expect(a.browserAvailable).toBe(true);
    expect(refuseAttendanceRequest(a, 'browser')).toBeNull();
  });

  it('refuses a request on a canceled event even when a scheduled row already exists', () => {
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'canceled' },
      candidates: SERVER_OK,
      subscription: { scheduledByUser: true, attendanceMode: 'automatic' },
    });
    expect(refuseAttendanceRequest(a, 'automatic')?.code).toBe('EVENT_CANCELED');
    expect(refuseAttendanceRequest(a, 'browser')?.code).toBe('EVENT_CANCELED');
  });

  it('permits automatic for another tenant while the canonical capture is active (one shared recorder)', () => {
    // Phase 7.schedule reuses the existing canonical capture id — an active
    // capture is NOT a duplicate recorder, so automatic demand is accepted.
    const a = assessAttendance({
      hearing: { ...PUBLIC_UPCOMING, eventStatus: 'in_progress' },
      candidates: SERVER_OK,
      capture: { domainStatus: 'CAPTURING' },
    });
    expect(refuseAttendanceRequest(a, 'automatic')).toBeNull();
  });

  it('keeps same-mode automatic re-request idempotent while policy permits', () => {
    const a = assessAttendance({
      hearing: PUBLIC_UPCOMING,
      candidates: SERVER_OK,
      subscription: { scheduledByUser: true, attendanceMode: 'automatic' },
    });
    expect(refuseAttendanceRequest(a, 'automatic')).toBeNull();
  });
});
