import { stateCapturePolicy } from './legiwatch-state-capture-policy.js';
import { assessAttendance } from './legiwatch-wave1-attendance.js';

describe('scoped state attendance policy', () => {
  const ctx = { tenantId: 'tenant', userId: 'internal-user' } as any;
  const hearing = {
    id: 'event',
    geographicJurisdiction: 'FL',
    eventStatus: 'scheduled',
    visibility: 'public',
    url: 'https://owned.example/event',
  };
  let modes: string[];
  const tx = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) =>
      sql.join('').includes('legiwatch_state_calendar_v1')
        ? [{ enabled: true }]
        : modes.map((mode) => ({ mode })),
    ),
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
  it('keeps an unqualified state event link-only even when a source URL is present', async () => {
    const permission = await stateCapturePolicy(prisma, ctx, hearing);
    expect(
      assessAttendance({ hearing, candidates: [], statePermission: permission }),
    ).toMatchObject({
      canRequest: false,
      availableModes: [],
      reasonCode: 'STATE_CAPTURE_NOT_QUALIFIED',
    });
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
      availableModes: ['automatic'],
    });
  });
  it('offers only the explicitly granted browser mode and still requires consent', async () => {
    modes = ['browser'];
    const permission = await stateCapturePolicy(prisma, ctx, hearing);
    expect(
      assessAttendance({ hearing, candidates: [], statePermission: permission }),
    ).toMatchObject({
      state: 'BROWSER_ONLY',
      availableModes: ['browser'],
      consentRequired: true,
    });
  });
});
