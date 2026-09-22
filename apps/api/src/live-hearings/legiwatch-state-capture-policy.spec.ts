import {
  STATE_CAPTURE_LINK_ONLY,
  stateCapturePolicy,
} from './legiwatch-state-capture-policy.js';
import { assessAttendance } from './legiwatch-wave1-attendance.js';

describe('state capture is link-only', () => {
  const ctx = { tenantId: 'tenant', userId: 'internal-user' } as any;
  const prisma = { withSystem: jest.fn() } as any;
  const hearing = {
    id: 'event',
    geographicJurisdiction: 'FL',
    eventStatus: 'scheduled',
    visibility: 'public',
    url: 'https://www.flsenate.gov/Committees/Show/AP/MeetingNotice/7001',
  };

  beforeEach(() => {
    prisma.withSystem.mockClear();
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'true';
    process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
    delete process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED;
  });

  it('leaves the legacy federal policy unchanged', async () => {
    expect(
      await stateCapturePolicy(prisma, ctx, { ...hearing, geographicJurisdiction: 'US' }),
    ).toBeUndefined();
  });

  it.each([
    ['scheduled public', hearing],
    ['completed public', { ...hearing, eventStatus: 'completed' }],
    ['canceled public', { ...hearing, eventStatus: 'canceled' }],
    ['private', { ...hearing, visibility: 'private' }],
    ['unknown source', { ...hearing, url: 'https://owned.example/event' }],
  ])('keeps %s state proceedings link-only', async (_label, row) => {
    const permission = await stateCapturePolicy(prisma, ctx, row);
    expect(permission).toEqual({
      browserAllowed: false,
      policy: expect.objectContaining({
        allowed: false,
        state: 'BLOCKED',
        reasonCode: STATE_CAPTURE_LINK_ONLY,
      }),
    });
  });

  it('never widens state capture because runtime flags or legacy grants exist', async () => {
    const permission = await stateCapturePolicy(prisma, ctx, hearing);
    expect(prisma.withSystem).not.toHaveBeenCalled();
    expect(permission?.browserAllowed).toBe(false);
    expect(permission?.policy.allowed).toBe(false);
  });

  it('publishes no browser or automatic attendance mode', async () => {
    const permission = await stateCapturePolicy(prisma, ctx, hearing);
    expect(
      assessAttendance({
        hearing,
        candidates: [
          {
            officialPageUrl: 'https://www.flsenate.gov/Media/VideoPlayer/6382',
            capturePolicy: 'SERVER_CAPTURE_ALLOWED',
            resolutionState: 'READY',
          },
        ],
        statePermission: permission,
      }),
    ).toMatchObject({
      state: 'NOT_ELIGIBLE',
      reasonCode: STATE_CAPTURE_LINK_ONLY,
      canRequest: false,
      availableModes: [],
      browserAvailable: false,
      automaticAvailable: false,
    });
  });
});
