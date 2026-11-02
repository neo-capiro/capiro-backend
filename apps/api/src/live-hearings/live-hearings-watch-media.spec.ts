import { writeFileSync } from 'node:fs';
jest.mock('@capiro/shared', () => ({ resolveCommittee: jest.fn(() => null) }), {
  virtual: true,
});
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: jest.fn() }));
import { LiveHearingsService } from './live-hearings.service.js';
import { selectOfficialWatchMedia } from './live-hearings-watch-media.js';

const page = 'https://www.senate.gov/isvp?comm=judiciary&filename=synthetic';
const candidate = {
  id: 'synthetic-candidate',
  provider: 'senate-isvp',
  officialPageUrl: page,
  mediaUrl: 'https://media.example.org/synthetic.m3u8',
  mediaType: 'hls',
  capturePolicy: 'BROWSER_CAPTURE_ONLY',
  resolutionState: 'LIVE',
  priority: 0,
  expiresAt: null,
  failureReason: null,
};

it('preserves public watching without recording opt-in and omits unsafe or restricted media', () => {
  expect(selectOfficialWatchMedia('public', [candidate])?.url).toBe(candidate.mediaUrl);
  expect(selectOfficialWatchMedia('private', [candidate])).toBeNull();
  for (const capturePolicy of ['BLOCKED', 'LICENSE_REQUIRED', 'REVIEW_REQUIRED'])
    expect(selectOfficialWatchMedia('public', [{ ...candidate, capturePolicy }])).toBeNull();
  for (const mediaUrl of [
    'https://localhost./video.mp4',
    'https://printer.local./video.mp4',
    'https://127.0.0.1/video.mp4',
    'https://user:password@media.example.org/video.mp4',
    'https://media.example.org/video.mp4?token=synthetic',
    'https://media.example.org/video.mp4?X-Amz-Signature=synthetic',
    'https://media.example.org/live.m3u8?__token__=synthetic',
    'https://media.example.org/live.m3u8?hdntl=synthetic',
    'https://media.example.org/live.m3u8?auth_key=synthetic',
    'https://media.example.org/live.m3u8?publisher_key=synthetic',
    'https://media.example.org/video.mp4#token=synthetic',
    'https://media.example.org/video/player',
    'http://media.example.org/video.mp4',
  ])
    expect(selectOfficialWatchMedia('public', [{ ...candidate, mediaUrl }])).toBeNull();
});

it('serializes actual Core event responses for the FE schema and watch selection contract', async () => {
  const responses = [];
  for (const scenario of ['live', 'archived', 'expired', 'unsupported']) {
    const hearing = {
      id: `synthetic-${scenario}`,
      canonicalHearingId: null,
      title: `Synthetic ${scenario}`,
      geographicJurisdiction: 'US',
      congress: 119,
      chamber: 'Senate',
      committeeName: 'Synthetic Committee',
      date: new Date('2026-11-02'),
      startsAt: null,
      time: null,
      timezone: 'America/New_York',
      type: 'hearing',
      eventStatus: scenario === 'live' ? 'in_progress' : 'completed',
      visibility: 'public',
      location: null,
      url: page,
      witnesses: [],
      streamAvailability: 'available',
      coverageStatus: 'discovered',
      sourceRevision: 1,
      lastOfficialUpdateAt: null,
    };
    const stream = {
      ...candidate,
      hearingId: hearing.id,
      resolutionState: scenario === 'live' ? 'LIVE' : 'ENDED',
      expiresAt: scenario === 'expired' ? new Date('2000-01-01') : null,
      mediaUrl:
        scenario === 'unsupported'
          ? 'https://media.example.org/player'
          : scenario === 'archived'
            ? 'https://media.example.org/archive.mp4'
            : candidate.mediaUrl,
    };
    const empty = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = {
      committeeHearing: { findUnique: jest.fn().mockResolvedValue(hearing) },
      hearingStreamCandidate: { findMany: jest.fn().mockResolvedValue([stream]) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      withTenant: jest.fn(async (_tenant, work) =>
        work({ hearingSubscription: empty, hearingFollow: empty }),
      ),
      congressCommittee: empty,
      committeeSiteUpdate: empty,
    };
    const event = await new LiveHearingsService(prisma as never).event(
      { tenantId: 'synthetic-tenant', userId: 'synthetic-user' } as never,
      hearing.id,
    );
    expect(event?.officialPageUrl).toBe(page);
    expect(event?.officialWatchMedia !== null).toBe(['live', 'archived'].includes(scenario));
    expect(event?.streamCandidates[0]).not.toHaveProperty('mediaUrl');
    responses.push(event);
  }
  // Optional exact cross-repository contract artifact; no network or DB access.
  if (process.env.LEGIWATCH_PLAYBACK_CONTRACT_PATH)
    writeFileSync(
      process.env.LEGIWATCH_PLAYBACK_CONTRACT_PATH,
      JSON.stringify(responses, null, 2),
    );
});
