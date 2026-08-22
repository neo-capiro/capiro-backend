import { assessStrictSchedulePolicy } from './live-hearings-phase7-schedule.guard.js';

describe('Phase 7 strict schedule policy', () => {
  const publicHearing = { eventStatus: 'scheduled', visibility: 'public' };

  it('allows a verified server capture source', () => {
    expect(
      assessStrictSchedulePolicy(publicHearing, [
        { capturePolicy: 'SERVER_CAPTURE_ALLOWED', resolutionState: 'READY' },
      ]),
    ).toMatchObject({ allowed: true, state: 'READY' });
  });

  it('allows only REVIEW_REQUIRED unresolved candidates into preflight', () => {
    expect(
      assessStrictSchedulePolicy(publicHearing, [
        { capturePolicy: 'REVIEW_REQUIRED', resolutionState: 'WAITING_FOR_STREAM' },
      ]),
    ).toMatchObject({
      allowed: true,
      state: 'PREFLIGHT_REQUIRED',
      reasonCode: 'STREAM_PREFLIGHT_REQUIRED',
    });
  });

  it('does not let WAITING_FOR_STREAM override a license ceiling', () => {
    expect(
      assessStrictSchedulePolicy(publicHearing, [
        { capturePolicy: 'LICENSE_REQUIRED', resolutionState: 'WAITING_FOR_STREAM' },
      ]),
    ).toMatchObject({
      allowed: false,
      state: 'LICENSE_REQUIRED',
      reasonCode: 'LICENSE_REQUIRED',
    });
  });

  it('does not let SOURCE_ERROR override browser-only policy', () => {
    expect(
      assessStrictSchedulePolicy(publicHearing, [
        { capturePolicy: 'BROWSER_CAPTURE_ONLY', resolutionState: 'SOURCE_ERROR' },
      ]),
    ).toMatchObject({
      allowed: false,
      state: 'BROWSER_ONLY',
      reasonCode: 'BROWSER_CAPTURE_ONLY',
    });
  });

  it('prefers a real server-allowed source when mixed with a restricted candidate', () => {
    expect(
      assessStrictSchedulePolicy(publicHearing, [
        { capturePolicy: 'LICENSE_REQUIRED', resolutionState: 'POLICY_BLOCKED' },
        { capturePolicy: 'SERVER_CAPTURE_ALLOWED', resolutionState: 'READY' },
      ]),
    ).toMatchObject({ allowed: true, state: 'READY' });
  });

  it('fails closed for non-public and terminal hearings', () => {
    expect(
      assessStrictSchedulePolicy({ eventStatus: 'scheduled', visibility: 'private' }, []),
    ).toMatchObject({ allowed: false, reasonCode: 'NON_PUBLIC_PROCEEDING' });
    expect(
      assessStrictSchedulePolicy({ eventStatus: 'canceled', visibility: 'public' }, []),
    ).toMatchObject({ allowed: false, reasonCode: 'EVENT_CANCELED' });
    expect(
      assessStrictSchedulePolicy({ eventStatus: 'completed', visibility: 'public' }, []),
    ).toMatchObject({ allowed: false, reasonCode: 'EVENT_COMPLETED' });
  });
});
