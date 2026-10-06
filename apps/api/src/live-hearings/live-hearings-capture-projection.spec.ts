import { projectCaptureResolution } from './live-hearings-capture-projection.js';

const now = new Date('2026-10-06T12:00:00Z');
const approved = {
  resolutionCapturePolicy: 'SERVER_CAPTURE_ALLOWED',
  resolutionState: 'READY',
  lastResolutionAt: new Date('2026-10-06T11:59:00Z'),
  selectedStreamCandidateId: 'selected',
};
const source = {
  id: 'selected',
  capturePolicy: 'SERVER_CAPTURE_ALLOWED',
  resolutionState: 'READY',
};

describe('calendar capture resolution projection', () => {
  it('retains authoritative blocked policy despite an advertised server source', () => {
    expect(
      projectCaptureResolution(
        { ...approved, resolutionCapturePolicy: 'BLOCKED', resolutionState: 'POLICY_BLOCKED' },
        [source],
        now,
      ),
    ).toEqual({ capturePolicy: 'BLOCKED', streamState: 'POLICY_BLOCKED' });
  });

  it.each([null, { resolutionState: 'NOT_CHECKED' }])(
    'never grants server permission from candidates alone (%j)',
    (capture) => {
      expect(projectCaptureResolution(capture, [source], now).capturePolicy).toBeNull();
    },
  );

  it('retains worker approval only while the selected source remains current', () => {
    expect(projectCaptureResolution(approved, [source], now).capturePolicy).toBe(
      'SERVER_CAPTURE_ALLOWED',
    );
    expect(
      projectCaptureResolution(
        approved,
        [{ ...source, expiresAt: new Date('2026-10-06T11:58:00Z') }],
        now,
      ).capturePolicy,
    ).toBeNull();
    expect(projectCaptureResolution(approved, [], now).capturePolicy).toBeNull();
    expect(
      projectCaptureResolution({ ...approved, lastResolutionAt: null }, [source], now)
        .capturePolicy,
    ).toBeNull();
  });

  it('does not let old approval override a newer restrictive probe', () => {
    expect(
      projectCaptureResolution(
        approved,
        [
          {
            ...source,
            capturePolicy: 'BROWSER_CAPTURE_ONLY',
            resolutionState: 'POLICY_BLOCKED',
            lastProbeAt: new Date('2026-10-06T11:59:30Z'),
          },
        ],
        now,
      ),
    ).toEqual({ capturePolicy: 'BROWSER_CAPTURE_ONLY', streamState: 'POLICY_BLOCKED' });
  });

  it('keeps mixed unresolved and restrictive candidates pending', () => {
    expect(
      projectCaptureResolution(
        null,
        [
          { ...source, capturePolicy: 'BROWSER_CAPTURE_ONLY' },
          { ...source, id: 'review', capturePolicy: 'REVIEW_REQUIRED' },
        ],
        now,
      ).capturePolicy,
    ).toBeNull();
  });

  it('uses attendance policy precedence for explicitly restrictive sources', () => {
    const browser = {
      ...source,
      capturePolicy: 'BROWSER_CAPTURE_ONLY',
      resolutionState: 'POLICY_BLOCKED',
    };
    const blocked = {
      ...source,
      id: 'blocked',
      capturePolicy: 'BLOCKED',
      resolutionState: 'NO_PUBLIC_STREAM',
    };
    expect(projectCaptureResolution(null, [blocked, browser], now).capturePolicy).toBe(
      'BROWSER_CAPTURE_ONLY',
    );
    expect(
      projectCaptureResolution(
        null,
        [browser, { ...source, id: 'licensed', capturePolicy: 'LICENSE_REQUIRED' }],
        now,
      ).capturePolicy,
    ).toBe('LICENSE_REQUIRED');
  });
});
