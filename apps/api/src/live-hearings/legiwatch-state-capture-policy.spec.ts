import { stateCapturePolicy } from './legiwatch-state-capture-policy.js';
import { assessAttendance } from './legiwatch-wave1-attendance.js';

describe('scoped state attendance policy', () => {
  const ctx = { tenantId: 'tenant', userId: 'internal-user' } as any;
  const hearing = {
    id: 'event',
    geographicJurisdiction: 'FL',
    eventStatus: 'scheduled',
    visibility: 'public',
    url: 'https://www.flsenate.gov/Committees/Show/AP/MeetingNotice/7001',
  };
  let modes: string[];
  const tx = {
    $queryRaw: jest.fn(async () => modes.map((mode) => ({ mode }))),
  };
  const prisma = { withSystem: (read: any) => read(tx) } as any;
  beforeEach(() => {
    modes = [];
    delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
    delete process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED;
    tx.$queryRaw.mockClear();
  });
  afterEach(() => {
    delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
    delete process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED;
  });
  it('leaves the legacy federal policy unchanged without a Phase 4 database read', async () => {
    expect(
      await stateCapturePolicy(prisma, ctx, { ...hearing, geographicJurisdiction: 'US' }),
    ).toBeUndefined();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('allows public browser attendance on an official Florida page without any grant or flag', async () => {
    // No media-permission rows (modes=[]) and no state-calendar flag read at all.
    const permission = await stateCapturePolicy(prisma, ctx, hearing);
    expect(permission?.browserAllowed).toBe(true);
    expect(permission?.policy).toMatchObject({
      allowed: false,
      state: 'BROWSER_ONLY',
      reasonCode: 'STATE_PUBLIC_BROWSER_AVAILABLE',
    });
    expect(
      assessAttendance({ hearing, candidates: [], statePermission: permission }),
    ).toMatchObject({
      state: 'BROWSER_ONLY',
      availableModes: ['browser'],
      consentRequired: true,
    });
  });
  it('keeps a public Florida event on a non-official host link-only', async () => {
    const permission = await stateCapturePolicy(prisma, ctx, {
      ...hearing,
      url: 'https://owned.example/event',
    });
    expect(permission?.browserAllowed).toBe(false);
    expect(
      assessAttendance({ hearing, candidates: [], statePermission: permission }),
    ).toMatchObject({
      canRequest: false,
      availableModes: [],
      reasonCode: 'STATE_CAPTURE_NOT_QUALIFIED',
    });
  });
  it('refuses a non-public Florida proceeding even on an official page', async () => {
    const closed = { ...hearing, visibility: 'private' };
    const permission = await stateCapturePolicy(prisma, ctx, closed);
    expect(permission?.browserAllowed).toBe(false);
    expect(permission?.policy.reasonCode).toBe('NON_PUBLIC_PROCEEDING');
  });
  it('refuses a canceled Florida proceeding even on an official page', async () => {
    const canceled = { ...hearing, eventStatus: 'canceled' };
    const permission = await stateCapturePolicy(prisma, ctx, canceled);
    expect(permission?.browserAllowed).toBe(false);
    expect(permission?.policy.reasonCode).toBe('EVENT_CANCELED');
  });
  it('keeps a completed Florida proceeding browser-watchable via its official replay page', async () => {
    const completed = { ...hearing, eventStatus: 'completed' };
    const permission = await stateCapturePolicy(prisma, ctx, completed);
    expect(permission?.browserAllowed).toBe(true);
    expect(permission?.policy).toMatchObject({ allowed: false, reasonCode: 'EVENT_COMPLETED' });
  });
  it('refuses a completed Florida proceeding with no usable official page', async () => {
    const completed = { ...hearing, eventStatus: 'completed', url: null };
    const permission = await stateCapturePolicy(prisma, ctx, completed);
    expect(permission?.browserAllowed).toBe(false);
    expect(permission?.policy.reasonCode).toBe('EVENT_COMPLETED');
  });
  it('refuses a non-http(s) Florida source URL for browser', async () => {
    const permission = await stateCapturePolicy(prisma, ctx, {
      ...hearing,
      url: 'ftp://www.flsenate.gov/x',
    });
    expect(permission?.browserAllowed).toBe(false);
  });
  it('requires both runtime gates and does not turn a server grant into browser permission', async () => {
    modes = ['server'];
    expect((await stateCapturePolicy(prisma, ctx, hearing))?.policy.allowed).toBe(false);
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'true';
    expect((await stateCapturePolicy(prisma, ctx, hearing))?.policy.allowed).toBe(false);
    process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = 'true';
    const permission = await stateCapturePolicy(prisma, ctx, hearing);
    expect(
      assessAttendance({ hearing, candidates: [], statePermission: permission }),
    ).toMatchObject({
      state: 'AUTOMATIC_PENDING_PREFLIGHT',
      availableModes: ['automatic', 'browser'],
    });
  });
  it('offers only the explicitly granted browser mode and still requires consent', async () => {
    modes = ['browser'];
    const permission = await stateCapturePolicy(prisma, ctx, {
      ...hearing,
      url: 'https://owned.example/event',
    });
    expect(
      assessAttendance({ hearing, candidates: [], statePermission: permission }),
    ).toMatchObject({
      state: 'BROWSER_ONLY',
      availableModes: ['browser'],
      consentRequired: true,
    });
  });
});
