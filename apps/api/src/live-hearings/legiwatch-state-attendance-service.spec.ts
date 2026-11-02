jest.mock('./live-hearings-phase7.service.js', () => ({ LiveHearingsPhase7Service: jest.fn() }));
jest.mock('./live-hearings.service.js', () => ({ LiveHearingsService: jest.fn() }));
jest.mock('./committee-directory.service.js', () => ({ CommitteeDirectoryService: jest.fn() }));
jest.mock('./legiwatch-lifecycle-notification.service.js', () => ({
  LegiWatchLifecycleNotificationService: jest.fn(),
}));
jest.mock('./legiwatch-committee-notification.service.js', () => ({
  LegiWatchCommitteeNotificationService: jest.fn(),
}));
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';

describe('state browser attendance service', () => {
  const flag = process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
  afterEach(() => {
    if (flag === undefined) delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
    else process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = flag;
  });
  it.each(['scheduled', 'completed'])(
    'keeps canonical Florida browser access for %s hearings with unattended capture off',
    async (eventStatus) => {
      delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
      const hearing = {
        id: 'synthetic-hearing',
        geographicJurisdiction: 'FL',
        eventStatus,
        visibility: 'public',
        url: 'https://www.flsenate.gov/Media/VideoPlayer/6382',
      };
      const tx = {
        hearingSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      };
      const prisma = {
        hearingStreamCandidate: {
          findMany: jest.fn().mockResolvedValue([
            {
              officialPageUrl: hearing.url,
              capturePolicy: 'BROWSER_CAPTURE_ONLY',
              resolutionState: 'READY',
            },
          ]),
        },
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
        withTenant: jest.fn(async (_tenant, callback) => callback(tx)),
      };
      const phase7 = { schedule: jest.fn() };
      const service = new LegiWatchWave1Service(
        prisma as never,
        phase7 as never,
        {} as never,
        {} as never,
        {} as never,
      );
      jest.spyOn(service as any, 'requireHearing').mockResolvedValue(hearing);
      jest.spyOn(service as any, 'transcriptSegmentCount').mockResolvedValue(0);
      const ctx = { tenantId: 'synthetic-tenant', userId: 'synthetic-user' } as never;
      await expect(service.attendanceState(ctx, hearing.id)).resolves.toMatchObject({
        browserAvailable: true,
        automaticAvailable: false,
      });
      await expect(service.requestAttendance(ctx, hearing.id, { mode: 'browser' })).rejects.toThrow(
        'explicit consent',
      );
      await expect(
        service.requestAttendance(ctx, hearing.id, { mode: 'browser', consentAcknowledged: true }),
      ).resolves.toMatchObject({ requestedMode: 'browser', schedule: null });
      await expect(
        service.requestAttendance(ctx, hearing.id, { mode: 'automatic' }),
      ).rejects.toThrow();
      expect(phase7.schedule).not.toHaveBeenCalled();
      expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    },
  );
});
