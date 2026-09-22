import { HearingController } from './hearing.controller.js';
import { HearingSessionService } from './hearing-session.service.js';
import {
  LiveHearingAudioSourceDto,
  LiveHearingSourceTypeDto,
  RecordingPolicyDto,
} from './dto/session.dto.js';
import {
  approvedPublicCapture,
  stateCaptureEnabled,
} from './capture/public-capture-permission.js';
import { STATE_CAPTURE_LINK_ONLY } from './state-capture-policy.js';

const FLORIDA_PAGE = 'https://www.flsenate.gov/Media/VideoPlayer/6382';
const FEDERAL_PAGE = 'https://www.armed-services.senate.gov/hearings/example';

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
  stateRows: Array<{ id: string }> = [{ id: 'hearing-fl' }],
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
    sourceUrl: 'https://example.gov/event',
    ...overrides,
  };
}

describe('state proceedings remain link-only', () => {
  it('cannot be enabled by legacy runtime flags', () => {
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'true';
    process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = 'true';
    try {
      expect(stateCaptureEnabled()).toBe(false);
    } finally {
      delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
      delete process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED;
    }
  });

  it('never accepts a grant unless the hearing has a canonical federal row', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const prisma = {
      withSystem: jest.fn(async (operation: (tx: { $queryRaw: typeof query }) => unknown) =>
        operation({ $queryRaw: query }),
      ),
    };
    await expect(approvedPublicCapture(prisma as never, 'hearing-fl')).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0].join(' ')).toContain('federal_committee_hearing');
  });

  it('cannot create a browser or server capture session for a state hearing id', async () => {
    for (const audioSource of [
      LiveHearingAudioSourceDto.browser_mic,
      LiveHearingAudioSourceDto.stream_url,
    ]) {
      const h = harness();
      await expect(
        h.service.create('tenant-1', 'user-1', stateDto({ audioSource }) as never),
      ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
      expect(h.create).not.toHaveBeenCalled();
    }
  });

  it('cannot start an existing Florida browser session, even when a grant may exist', async () => {
    const h = harness();
    await expect(
      h.service.assertCaptureAllowed('tenant-1', 'session-fl', 'user-1'),
    ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('rejects a Florida source when hearingId is missing or substituted', async () => {
    for (const hearingId of [null, 'federal-hearing-id']) {
      const session = { ...stateSession, hearingId };
      const h = harness(session, []);
      await expect(
        h.service.assertCaptureAllowed('tenant-1', 'session-fl', 'user-1'),
      ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
      expect(h.query).not.toHaveBeenCalled();
    }
  });

  it.each([
    'http://www.flsenate.gov/Media/VideoPlayer/6382',
    'https://user:password@www.flhouse.gov:8443/Sections/Committees/committee-meeting.aspx',
    'ftp://thefloridachannel.org/videos/example-hearing/',
  ])('denies a Florida publisher host even when the source URL is unsafe: %s', async (sourceUrl) => {
    const h = harness({ ...stateSession, hearingId: null, sourceUrl }, []);
    await expect(
      h.service.assertCaptureAllowed('tenant-1', 'session-fl', 'user-1'),
    ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('cannot mint a WebSocket ticket for a Florida session', async () => {
    const h = harness();
    const tickets = { mint: jest.fn() };
    const controller = new HearingController(
      h.service,
      {} as never,
      {} as never,
      {} as never,
      tickets as never,
    );
    await expect(
      controller.wsTicket(
        { tenantId: 'tenant-1', clerkUserId: 'user-1' } as never,
        'session-fl',
      ),
    ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
    expect(tickets.mint).not.toHaveBeenCalled();
  });

  it('does not expose Florida through the REST stream resolver', async () => {
    const h = harness();
    const resolver = { resolve: jest.fn() };
    const controller = new HearingController(
      h.service,
      {} as never,
      {} as never,
      resolver as never,
      {} as never,
    );
    await expect(
      controller.resolveStream(
        { tenantId: 'tenant-1', clerkUserId: 'user-1' } as never,
        { pageUrl: FLORIDA_PAGE, hearingId: 'federal-hearing-id' } as never,
      ),
    ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('preserves the federal session path', async () => {
    const federal = {
      ...stateSession,
      id: 'session-us',
      hearingId: 'hearing-us',
      sourceUrl: FEDERAL_PAGE,
    };
    const h = harness(federal, []);
    await expect(
      h.service.assertCaptureAllowed('tenant-1', 'session-us', 'user-1'),
    ).resolves.toBe(federal);
  });
});
