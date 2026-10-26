import 'reflect-metadata';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { HillDayGenerationService } from '../../src/hillday/hillday-generation.service.js';
import { HillDayJobWorkerService } from '../../src/hillday/hillday-job-worker.service.js';

/**
 * Focused WS-10 fixture: real PostgreSQL, real Prisma, the real
 * {@link HillDayJobWorkerService} claim/renew logic and the real
 * {@link HillDayGenerationService} job transitions.
 *
 * Only two things are substituted, and both are named here:
 *  - the Hill Day source/authority port (`requireClient`), because document
 *    admission and the client wall are already covered by the existing
 *    a1-source-authority / a1-authority specs — this suite is about the durable
 *    claim, lease, cancellation and retry state machine, not the wall;
 *  - the model credential, which is null so NO provider call is ever issued.
 *    A unit execution is therefore observable as a write to its meeting row,
 *    which is how "a second process must not issue the paid call again" is
 *    measured without any provider.
 *
 * Uses the preserved disposable-schema helper only through
 * `scripts/testing/a1-disposable-postgres.cjs` (see the int-spec).
 */
export const WS10_IDS = {
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  otherTenantId: '00000000-0000-4000-8000-0000000000a2',
  clientId: '00000000-0000-4000-8000-0000000000b1',
  documentId: '00000000-0000-4000-8000-0000000000c1',
  otherDocumentId: '00000000-0000-4000-8000-0000000000c2',
  requestId: '00000000-0000-4000-8000-0000000000d1',
  replayRequestId: '00000000-0000-4000-8000-0000000000d2',
} as const;

const OWNER = 'user_ws10_owner';

export async function createHillDayJobHarness(url: string) {
  const db = new PrismaService({ datasources: { db: { url } } });
  const { tenantId, otherTenantId, clientId, documentId, otherDocumentId, requestId, replayRequestId } = WS10_IDS;

  /** Counts meeting writes: one per executed unit, i.e. one per would-be paid call. */
  const executions: string[] = [];
  db.$use(async (params, next) => {
    if (params.model === 'WsHillDayMeeting' && params.action === 'update') {
      executions.push(String((params.args as { where?: { id?: string } })?.where?.id ?? 'unknown'));
    }
    return next(params);
  });

  await db.$connect();

  await db.wsHillDayDocument.create({
    data: {
      id: documentId, tenantId, ownerId: OWNER, blueprintSlug: 'hill-day',
      clientId, clientName: 'WS10 disposable client', name: 'WS10 disposable packet',
      timeZone: 'America/New_York', lookbackDays: 90,
    },
  });
  await db.wsHillDayDocument.create({
    data: {
      id: otherDocumentId, tenantId: otherTenantId, ownerId: OWNER, blueprintSlug: 'hill-day',
      clientId, clientName: 'WS10 other tenant client', name: 'WS10 other tenant packet',
      timeZone: 'America/New_York', lookbackDays: 90,
    },
  });

  // Two selected meetings, so a job has two units to resume/park independently.
  for (const [index, id] of ['m-ws10-1', 'm-ws10-2'].entries()) {
    await db.wsHillDayMeeting.create({
      data: {
        id: `00000000-0000-4000-8000-0000000000e${index + 1}`,
        tenantId, documentId, eventId: id, ordinal: index,
        event: { eventId: id, subject: `WS10 meeting ${index + 1}`, startsAt: '2026-10-26T13:00:00.000Z', endsAt: '2026-10-26T13:30:00.000Z' },
      },
    });
  }

  const source = {
    requireClient: async () => ({ id: clientId, name: 'WS10 disposable client' }),
    resolveUserId: async () => null,
    tenantName: async () => 'WS10 disposable firm',
    getClient: async () => ({ name: 'WS10 disposable client', sectorTag: null, description: null, productDescription: null }),
    listStrategies: async () => [],
    listThreads: async () => [],
    threadMessages: async () => [],
    priorMeetings: async () => [],
  };
  // No credential: generateUnit never reaches a provider.
  const credentials = { resolveAnthropic: async () => null };

  const generation = new HillDayGenerationService(db, source as never, credentials as never);
  const worker = new HillDayJobWorkerService(db, generation);

  return {
    db, generation, worker, executions,
    /** A second, independent worker process id — the contested replica. */
    secondWorker: new HillDayJobWorkerService(db, generation),
    ids: WS10_IDS,
    owner: OWNER,
    async close() { await db.$disconnect(); },
    async createJob(overrides: Record<string, unknown> = {}) {
      return db.wsHillDayJob.create({
        data: {
          tenantId, documentId, actorId: OWNER, status: 'queued',
          units: [
            { meetingId: '00000000-0000-4000-8000-0000000000e1', state: 'queued', sectionId: '00000000-0000-4000-8000-0000000000e1', reason: null, at: new Date().toISOString() },
            { meetingId: '00000000-0000-4000-8000-0000000000e2', state: 'queued', sectionId: '00000000-0000-4000-8000-0000000000e2', reason: null, at: new Date().toISOString() },
          ] as never,
          ...overrides,
        } as never,
      });
    },
    async leaseOf(jobId: string) {
      return db.wsHillDayJob.findUnique({ where: { id: jobId }, select: { status: true, leaseHolder: true, leaseExpiresAt: true, attemptCount: true, cancelRequestedAt: true, units: true } });
    },
    async expireLease(jobId: string) {
      return db.$executeRaw`
        UPDATE ws_hillday_job SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = ${jobId}::uuid
      `;
    },
  };
}
