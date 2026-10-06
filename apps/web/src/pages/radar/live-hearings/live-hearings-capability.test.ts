import { describe, expect, test } from 'vitest';
import {
  browserCaptureCapability,
  isLiveEvent,
  safeOfficialHttpUrl,
  serverCaptureCapability,
  captureSummaryLabel,
} from './live-hearings-capability.js';
import type { CanonicalHearingEvent } from './live-hearings.types.js';

function event(overrides: Partial<CanonicalHearingEvent> = {}): CanonicalHearingEvent {
  return {
    id: 'hearing-1',
    title: 'Public hearing',
    chamber: 'SENATE',
    eventType: 'HEARING',
    eventStatus: 'SCHEDULED',
    publicAccessStatus: 'PUBLIC',
    streamState: 'WAITING_FOR_STREAM',
    capturePolicy: 'SERVER_CAPTURE_ALLOWED',
    officialPageUrl: 'https://www.example.senate.gov/hearings/1',
    committee: { id: 'ssas', name: 'Armed Services', chamber: 'SENATE' },
    ...overrides,
  };
}

describe('Live Hearings capture capabilities', () => {
  test.each([
    ['BROWSER_CAPTURE_ONLY', 'Browser recording only'],
    ['LICENSE_REQUIRED', 'License required'],
    ['BLOCKED', 'Capture blocked'],
    ['REVIEW_REQUIRED', 'Source review required'],
  ])('does not let a pending schedule override %s policy', (capturePolicy, label) => {
    const candidate = event({ capturePolicy, capture: { status: 'SCHEDULED' } });
    expect(serverCaptureCapability(candidate).allowed).toBe(false);
    expect(captureSummaryLabel(candidate)).toBe(label);
  });

  test('keeps real recording outcomes visible while describing pending restrictions honestly', () => {
    expect(captureSummaryLabel(event({ capture: { status: 'COMPLETE' }, capturePolicy: 'BROWSER_CAPTURE_ONLY' }))).toBe('Capture Complete');
    expect(captureSummaryLabel(event({ capture: { status: 'SCHEDULED' } }))).toBe('Capture Scheduled');
    const unavailable = event({ capture: { status: 'SCHEDULED' }, streamState: 'NO_PUBLIC_STREAM' });
    expect(serverCaptureCapability(unavailable).allowed).toBe(false);
    expect(captureSummaryLabel(unavailable)).toBe('No public stream');
  });

  test('allows unattended capture only when the source is explicitly approved', () => {
    expect(serverCaptureCapability(event())).toEqual(
      expect.objectContaining({ allowed: true, mode: 'SERVER' }),
    );
    expect(
      serverCaptureCapability(event({ capturePolicy: 'REVIEW_REQUIRED' })),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        mode: 'NONE',
        reason: expect.stringMatching(/review/i),
      }),
    );
  });

  test('routes browser-only sources to the browser-assisted path', () => {
    expect(
      serverCaptureCapability(
        event({
          capturePolicy: 'BROWSER_CAPTURE_ONLY',
          streamState: 'BROWSER_ONLY',
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        mode: 'BROWSER',
      }),
    );
    expect(
      browserCaptureCapability(
        event({
          capturePolicy: 'BROWSER_CAPTURE_ONLY',
          streamState: 'BROWSER_ONLY',
        }),
      ),
    ).toEqual(expect.objectContaining({ allowed: true, mode: 'BROWSER' }));
  });

  test.each(['CLOSED', 'PRIVATE', 'CLASSIFIED', 'NOT_STREAMED', 'UNKNOWN'])(
    'never exposes a recording action for %s proceedings',
    (publicAccessStatus) => {
      const candidate = event({ publicAccessStatus });
      expect(serverCaptureCapability(candidate).allowed).toBe(false);
      expect(browserCaptureCapability(candidate).allowed).toBe(false);
    },
  );

  test('does not schedule canceled or completed proceedings', () => {
    expect(serverCaptureCapability(event({ eventStatus: 'CANCELED' })).allowed).toBe(false);
    expect(serverCaptureCapability(event({ eventStatus: 'COMPLETED' })).allowed).toBe(false);
  });

  test('recognizes active server capture without creating a second schedule', () => {
    expect(
      serverCaptureCapability(
        event({
          capture: {
            status: 'RECORDING',
            capturePolicy: 'SERVER_CAPTURE_ALLOWED',
            streamState: 'LIVE',
          },
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        allowed: true,
        mode: 'SERVER',
        reason: expect.stringMatching(/already scheduled/i),
      }),
    );
  });

  test('rejects executable and credential-bearing official links', () => {
    expect(safeOfficialHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeOfficialHttpUrl('data:text/html,hello')).toBeUndefined();
    expect(safeOfficialHttpUrl('https://user:secret@example.gov/hearing')).toBeUndefined();
    expect(safeOfficialHttpUrl('https://committee.senate.gov/hearing')).toBe(
      'https://committee.senate.gov/hearing',
    );
  });

  test('treats only an explicit live/capture/actual-start signal as live', () => {
    expect(isLiveEvent(event({ eventStatus: 'LIVE' }))).toBe(true);
    expect(isLiveEvent(event({ eventStatus: 'in_progress' }))).toBe(true);
    expect(isLiveEvent(event({ capture: { status: 'CAPTURING' } }))).toBe(true);
    expect(isLiveEvent(event({ eventStatus: 'ADJOURNED', capture: { status: 'CAPTURING' } }))).toBe(false);
    expect(
      isLiveEvent(
        event({
          capture: { status: 'RECORDING' },
        }),
      ),
    ).toBe(true);
    expect(
      isLiveEvent(
        event({
          eventStatus: 'SCHEDULED',
          scheduledStart: '2026-08-21T10:00:00Z',
          streamState: 'WAITING_FOR_STREAM',
        }),
        new Date('2026-08-21T12:00:00Z'),
      ),
    ).toBe(false);
    expect(
      isLiveEvent(
        event({
          eventStatus: 'SCHEDULED',
          actualStart: '2026-08-21T11:58:00Z',
        }),
      ),
    ).toBe(true);
  });
});
