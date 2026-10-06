import { discoverFloridaCalendarSessions } from './florida-calendar-discovery.js';
import { LegiWatchPhase9JobsService } from '../live-hearings/phase9/legiwatch-phase9-jobs.service.js';
import {
  LegiWatchPhase9PartialFailure,
  LegiWatchPhase9RuntimeService,
} from '../live-hearings/phase9/legiwatch-phase9-runtime.service.js';

jest.mock('./florida-calendar-discovery.js', () => ({
  ...jest.requireActual('./florida-calendar-discovery.js'),
  discoverFloridaCalendarSessions: jest.fn(),
}));

const calendar = jest.mocked(discoverFloridaCalendarSessions);

function harness() {
  const writes = jest.fn(async (_sql: string, ..._args: unknown[]) => 1);
  const prisma = {
    $queryRawUnsafe: jest.fn(async () => [{ enabled: true, scheduleEnabled: true }]),
    $executeRawUnsafe: writes,
  };
  const runtime = new LegiWatchPhase9RuntimeService(prisma as never);
  const service = new LegiWatchPhase9JobsService(
    prisma as never,
    runtime,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, writes };
}

describe('Florida calendar runtime health', () => {
  beforeEach(() => calendar.mockReset());

  it('records success for a complete empty calendar without inventing events', async () => {
    const metrics = { inserted: 0, updated: 0, skipped: 0, errors: 0, complete: true };
    calendar.mockResolvedValue(metrics);
    const { service, writes } = harness();
    await expect(service.run({ job: 'florida-calendar' })).resolves.toEqual(metrics);
    const success = writes.mock.calls.find(([sql]) => sql.includes("status='succeeded'"));
    expect(success).toBeDefined();
    expect(JSON.parse(String(success?.[2]))).toMatchObject(metrics);
    expect(writes.mock.calls.some(([sql]) => sql.includes("status='failed'"))).toBe(false);
  });

  it.each([
    { complete: false, errors: 2 },
    { complete: false, errors: 0 },
    { complete: true, errors: 1 },
  ])('fails incomplete evidence %j while retaining progress and coverage errors', async (outcome) => {
    const metrics = {
      inserted: 3,
      updated: 2,
      skipped: 4,
      ...outcome,
      unavailableSessions: ['2027'],
      incompleteReason: 'A source window could not be completed',
    };
    calendar.mockResolvedValue(metrics);
    const { service, writes } = harness();
    await expect(service.run({ job: 'florida-calendar' })).rejects.toBeInstanceOf(
      LegiWatchPhase9PartialFailure,
    );
    const failure = writes.mock.calls.find(([sql]) => sql.includes("status='failed'"));
    expect(failure?.[1]).toBe('florida-calendar');
    expect(JSON.parse(String(failure?.[3]))).toMatchObject({
      inserted: 3,
      updated: 2,
      skipped: 4,
      ...outcome,
      unavailableSessionCodes: '2027',
      incompleteReason: metrics.incompleteReason,
    });
    expect(writes.mock.calls.some(([sql]) => sql.includes("status='succeeded'"))).toBe(false);
  });
});
