import { HearingController } from './hearing.controller.js';
import { HearingSessionService } from './hearing-session.service.js';
import {
  LiveHearingAudioSourceDto,
  LiveHearingSourceTypeDto,
  RecordingPolicyDto,
} from './dto/session.dto.js';
import { approvedPublicCapture, stateCaptureEnabled } from './capture/public-capture-permission.js';
import { capturableHearingView, STATE_CAPTURE_LINK_ONLY } from './state-capture-policy.js';

const FLORIDA_PAGE = 'https://www.flsenate.gov/Media/VideoPlayer/6382';
const FEDERAL_PAGE = 'https://www.armed-services.senate.gov/hearings/example';
const FLAG = 'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED';

const stateSession = {
  id: 'session-fl',
  tenantId: 'tenant-1',
  sourceType: 'hearing',
  audioSource: 'browser_mic',
  consentStatus: 'not_required',
  createdBy: 'user-1',
  hearingId: 'hearing-fl',
  sourceUrl: FLORIDA_PAGE,
  publicCaptureId: null,
  clientId: null,
  matterId: null,
  issueIds: [],
  billIds: [],
  programElementIds: [],
  agencyIds: [],
};

type SessionFixture = Omit<typeof stateSession, 'hearingId'> & { hearingId: string | null };

function harness(
  session: SessionFixture = stateSession,
  stateRows: Array<{
    id: string;
    sourceUrl: string;
    browserAllowed: boolean;
    federal?: boolean;
  }> = [{ id: 'hearing-fl', sourceUrl: FLORIDA_PAGE, browserAllowed: true }],
) {
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'created',
    ...data,
  }));
  const findFirst = jest.fn(async () => session);
  const query = jest.fn(async () => stateRows);
  const tx = { liveHearingSession: { create, findFirst }, $queryRaw: query };
  const prisma = {
    $queryRaw: query,
    withTenant: jest.fn(async (_tenantId: string, operation: (value: typeof tx) => unknown) =>
      operation(tx),
    ),
  };
  return {
    service: new HearingSessionService(prisma as never),
    create,
    query,
  };
}

function stateDto(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Florida hearing',
    sourceType: LiveHearingSourceTypeDto.hearing,
    audioSource: LiveHearingAudioSourceDto.browser_mic,
    recordingPolicy: RecordingPolicyDto.transcript_only,
    hearingId: 'hearing-fl',
    sourceUrl: FLORIDA_PAGE,
    ...overrides,
  };
}

/** Render a tagged-template call, inlining Prisma.raw fragments (view names). */
function renderSql(call: unknown[]): string {
  const [parts, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return parts.reduce(
    (sql, part, index) =>
      sql + part + (index < values.length ? ((values[index] as { sql?: string })?.sql ?? '?') : ''),
    '',
  );
}

function permissionHarness() {
  const query = jest.fn().mockResolvedValue([]);
  const prisma = {
    withSystem: jest.fn(async (operation: (tx: { $queryRaw: typeof query }) => unknown) =>
      operation({ $queryRaw: query }),
    ),
  };
  return { prisma, query };
}

const previous = process.env[FLAG];
afterAll(() => {
  if (previous === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previous;
});

describe('LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED', () => {
  it.each([undefined, '', 'false', '0', 'off', 'maybe'])('is off for %s', (value) => {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
    expect(stateCaptureEnabled()).toBe(false);
    expect(capturableHearingView()).toBe('federal_committee_hearing');
  });

  it.each(['true', '1', 'on', 'enabled', 'yes', ' TRUE '])('is on for %s', (value) => {
    process.env[FLAG] = value;
    expect(stateCaptureEnabled()).toBe(true);
    expect(capturableHearingView()).toBe('capturable_committee_hearing');
  });
});

describe('public Florida browser recording is independent of unattended capture', () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });

  it('keeps automatic public capture restricted to the federal view while state capture is off', async () => {
    const { prisma, query } = permissionHarness();
    await expect(approvedPublicCapture(prisma as never, 'hearing-fl')).resolves.toEqual([]);
    expect(renderSql(query.mock.calls[0]!)).toContain('FROM federal_committee_hearing');
  });

  it.each(['false', 'true'])(
    'creates and starts an authorized public browser session when unattended capture is %s',
    async (flag) => {
      process.env[FLAG] = flag;
      const h = harness();
      await expect(
        h.service.create('tenant-1', 'user-1', stateDto() as never),
      ).resolves.toMatchObject({ sourceUrl: FLORIDA_PAGE });
      await expect(
        h.service.assertCaptureAllowed('tenant-1', 'session-fl', 'user-1'),
      ).resolves.toBe(stateSession);
      expect(h.query).toHaveBeenCalled();
    },
  );

  it.each([null, 'federal-hearing-id'])(
    'rejects an unbound/substituted Florida source (%s)',
    async (hearingId) => {
      const h = harness({ ...stateSession, hearingId }, []);
      await expect(
        h.service.assertCaptureAllowed('tenant-1', 'session-fl', 'user-1'),
      ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
    },
  );

  it('rejects private, canceled, mismatched, unsupported-state and expired-source rows at the canonical boundary', async () => {
    const h = harness(stateSession, [
      { id: 'hearing-fl', sourceUrl: FLORIDA_PAGE, browserAllowed: false },
    ]);
    await expect(h.service.create('tenant-1', 'user-1', stateDto() as never)).rejects.toThrow(
      STATE_CAPTURE_LINK_ONLY,
    );
    expect(h.create).not.toHaveBeenCalled();
    const sql = renderSql(h.query.mock.calls[0]!);
    expect(sql).toContain("h.visibility='public'");
    expect(sql).toContain("COALESCE(h.geographic_jurisdiction,'US') IN ('US','FL')");
    expect(sql).toContain('c.expires_at>clock_timestamp()');
    expect(sql).toContain('h.canonical_hearing_id IS NULL');
  });

  it.each([
    'http://www.flsenate.gov/watch',
    'https://user:pw@www.flhouse.gov:8443/watch',
    'https://unknown.example/watch',
  ])('rejects an unsafe/nonofficial Florida source %s', async (sourceUrl) => {
    const h = harness({ ...stateSession, sourceUrl }, [
      { id: 'hearing-fl', sourceUrl, browserAllowed: true },
    ]);
    await expect(
      h.service.assertCaptureAllowed('tenant-1', 'session-fl', 'user-1'),
    ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
  });

  it('permits the existing guarded resolver and WebSocket ticket for the canonical public browser source', async () => {
    const h = harness();
    const resolver = { resolve: jest.fn(async () => ({ status: 'unresolvable' })) };
    const tickets = { mint: jest.fn(async () => ({ ticket: 'test-ticket' })) };
    const controller = new HearingController(
      h.service,
      {} as never,
      {} as never,
      resolver as never,
      tickets as never,
    );
    const ctx = { tenantId: 'tenant-1', clerkUserId: 'user-1' } as never;
    await controller.resolveStream(ctx, { pageUrl: FLORIDA_PAGE, hearingId: 'hearing-fl' });
    await controller.wsTicket(ctx, 'session-fl');
    expect(resolver.resolve).toHaveBeenCalledWith({
      pageUrl: FLORIDA_PAGE,
      hearingId: 'hearing-fl',
    });
    expect(tickets.mint).toHaveBeenCalledWith('tenant-1', 'user-1', 'session-fl');
  });

  it('preserves the federal browser path', async () => {
    const federal = { ...stateSession, hearingId: 'hearing-us', sourceUrl: FEDERAL_PAGE };
    await expect(
      harness(federal, [
        { id: 'hearing-us', sourceUrl: FEDERAL_PAGE, browserAllowed: true, federal: true },
      ]).service.assertCaptureAllowed('tenant-1', 'session-us', 'user-1'),
    ).resolves.toBe(federal);
  });
});
