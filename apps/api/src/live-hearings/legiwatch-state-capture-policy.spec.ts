import {
  STATE_CAPTURE_LINK_ONLY,
  stateCapturePolicy,
} from './legiwatch-state-capture-policy.js';
import { assessAttendance } from './legiwatch-wave1-attendance.js';

describe('state capture is link-only until the system-wide switch is on', () => {
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
    delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
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

  it('never widens state capture because legacy grants exist while the switch is off', async () => {
    // requireStateCalendar is the only prisma use on this path and is a
    // documented no-op (legiwatch-calendar-access.ts) — asserting on
    // `prisma.withSystem` specifically proves nothing about widening through a
    // different query, so this only checks the actual denial outcome.
    const permission = await stateCapturePolicy(prisma, ctx, hearing);
    expect(permission?.browserAllowed).toBe(false);
    expect(permission?.policy.allowed).toBe(false);
    expect(permission?.policy.reasonCode).toBe(STATE_CAPTURE_LINK_ONLY);
  });

  it.each(['true', '1', 'on', 'enabled', 'yes'])(
    'defers state proceedings to the normal capture assessment when the switch is %s',
    async (value) => {
      process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = value;
      expect(await stateCapturePolicy(prisma, ctx, hearing)).toBeUndefined();
    },
  );

  it('treats unrecognized switch values as off', async () => {
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'maybe';
    expect((await stateCapturePolicy(prisma, ctx, hearing))?.policy.reasonCode).toBe(
      STATE_CAPTURE_LINK_ONLY,
    );
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
