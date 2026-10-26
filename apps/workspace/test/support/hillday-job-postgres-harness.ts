import 'reflect-metadata';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { HillDayGenerationService } from '../../src/hillday/hillday-generation.service.js';
import { HillDayJobWorkerService } from '../../src/hillday/hillday-job-worker.service.js';

/**
 * Focused WS-10 fixture: real PostgreSQL, real Prisma, the real
 * {@link HillDayJobWorkerService} claim/renew logic and the real
 * {@link HillDayGenerationService} job transitions.
 *
 * Two things are substituted, and both are named here:
 *  - the Hill Day source/authority port (`requireClient`), because document
 *    admission and the client wall are covered by the existing
 *    a1-source-authority / a1-authority specs — this suite is about the durable
 *    claim, lease, fencing, cancellation and retry state machine;
 *  - the PROVIDER, through an injected synthetic dispatch boundary. Every call
 *    the service would make to the real model is recorded and answered locally
 *    with a synthetic success, so "how many provider calls were issued for this
 *    unit" is observable directly (a database write is not a proxy for that:
 *    one transport retry could issue two calls before one write).
 *
 * The schema the cases run against is created from the ACCEPTED BASE datamodel
 * by the int-spec, seeded with pre-migration rows, and then has this PR's exact
 * migration SQL applied ONCE — so the same schema carries both legacy rows and
 * the new columns, which is the real rollout shape.
 */
export const WS10_IDS = {
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  otherTenantId: '00000000-0000-4000-8000-0000000000a2',
  clientId: '00000000-0000-4000-8000-0000000000b1',
  documentId: '00000000-0000-4000-8000-0000000000c1',
  otherDocumentId: '00000000-0000-4000-8000-0000000000c2',
  meeting1: '00000000-0000-4000-8000-0000000000e1',
  meeting2: '00000000-0000-4000-8000-0000000000e2',
  requestId: '00000000-0000-4000-8000-0000000000d1',
  replayRequestId: '00000000-0000-4000-8000-0000000000d2',
  /** A job row seeded BEFORE the migration: running, with no lease at all. */
  legacyJobId: '00000000-0000-4000-8000-0000000000f1',
} as const;

const OWNER = 'user_ws10_owner';

/** The synthetic provider answer: a valid unit payload, returned locally. */
export const SYNTHETIC_UNIT_TEXT = JSON.stringify({ focus: 'Synthetic focus', background: 'Synthetic background', unsupported: [] });

export async function createHillDayJobHarness(url: string) {
  const db = new PrismaService({ datasources: { db: { url } } });
  const { tenantId, clientId, documentId, otherDocumentId } = WS10_IDS;

  /**
   * The synthetic provider boundary. Each entry is the request body actually
   * sent, so a case can assert exactly which meeting was dispatched and how many
   * times — and can make the "call" fail after the provider accepted it.
   */
  const dispatches: string[] = [];
  let providerBehaviour: 'ok' | 'accepted-then-dropped' = 'ok';
  /** Runs while a provider call is out — used to take the claim over mid-call. */
  let onDispatch: (() => Promise<void>) | null = null;
  const realFetch = global.fetch;
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    dispatches.push(String(init?.body ?? ''));
    const hook = onDispatch;
    onDispatch = null;
    if (hook) await hook();
    if (providerBehaviour === 'accepted-then-dropped') {
      // The request reached the provider and was accepted; the connection then
      // dropped before we could read the answer.
      throw new Error('socket hang up');
    }
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: SYNTHETIC_UNIT_TEXT }] }) };
  }) as unknown as typeof fetch;

  await db.$connect();
  const legacy = await db.wsHillDayJob.findUniqueOrThrow({ where: { id: WS10_IDS.legacyJobId } });

  // The primary document already exists: the int-spec seeds it before legacy
  // jobs against the accepted base's document_id FK, before the migration.
  await db.wsHillDayDocument.create({
    data: {
      id: otherDocumentId, tenantId: WS10_IDS.otherTenantId, ownerId: OWNER, blueprintSlug: 'hill-day',
      clientId, clientName: 'WS10 other tenant client', name: 'WS10 other tenant packet',
      timeZone: 'America/New_York', lookbackDays: 90,
    },
  });

  for (const [index, id] of [[0, WS10_IDS.meeting1], [1, WS10_IDS.meeting2]] as const) {
    await db.wsHillDayMeeting.create({
      data: {
        id, tenantId, documentId, eventId: `evt-ws10-${index + 1}`, ordinal: index,
        // The subject is unique per meeting so a dispatch can be attributed.
        event: {
          eventId: `evt-ws10-${index + 1}`, subject: `WS10 meeting ${index + 1}`,
          startsAt: '2026-10-26T13:00:00.000Z', endsAt: '2026-10-26T13:30:00.000Z',
        },
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
  // A synthetic credential so units actually reach the injected provider
  // boundary; there is no real key and no network call.
  const credentials = {
    resolveAnthropic: async () => ({ provider: 'anthropic' as const, secret: 'synthetic-no-network', model: 'synthetic', usedTenantKey: false }),
  };

  // Test-only barriers surround REAL queries in the service's REAL transactions.
  // They never replace SQL, returned rows, conditional updates or commit/rollback.
  const steps: {
    afterJobRead?: (row: { id?: string; status?: string } | null) => Promise<void>;
    afterJobWrite?: (data: Prisma.WsHillDayJobUpdateManyMutationInput, count: number) => Promise<void>;
    beforeDocumentWrite?: (data: Prisma.WsHillDayDocumentUpdateInput) => Promise<void>;
  } = {};
  const observed = db.$extends({
    query: {
      wsHillDayJob: {
        async findFirst({ args, query }) {
          const row = await query(args);
          await steps.afterJobRead?.(row);
          return row;
        },
        async updateMany({ args, query }) {
          const result = await query(args);
          await steps.afterJobWrite?.(args.data, result.count);
          return result;
        },
      },
      wsHillDayDocument: {
        async update({ args, query }) {
          await steps.beforeDocumentWrite?.(args.data);
          return query(args);
        },
      },
    },
  });
  const generation = new HillDayGenerationService(observed as unknown as PrismaService, source as never, credentials as never);
  const worker = new HillDayJobWorkerService(db, generation);

  return {
    db, generation, worker, dispatches, url, steps,
    async reset() {
      delete steps.afterJobRead;
      delete steps.afterJobWrite;
      delete steps.beforeDocumentWrite;
      onDispatch = null;
      dispatches.length = 0;
      providerBehaviour = 'ok';
      await db.wsHillDayJob.deleteMany({ where: { NOT: { id: WS10_IDS.legacyJobId } } });
      // Preserve the actual pre-migration row and its original units/createdAt.
      // Park it between cases so it cannot become another case's active job.
      await db.wsHillDayJob.update({
        where: { id: legacy.id },
        data: {
          status: 'complete', leaseHolder: null, leaseExpiresAt: null, attemptCount: 0,
          requestId: null, requestIds: [], cancelRequestedAt: null, quality: null, error: null,
          startedAt: null, completedAt: null,
          units: legacy.units as Prisma.InputJsonValue, events: legacy.events as Prisma.InputJsonValue,
        },
      });
      await db.wsHillDayDocument.update({
        where: { id: documentId },
        data: { status: 'draft', generatedAt: null, provenance: Prisma.DbNull },
      });
      await db.wsHillDayMeeting.updateMany({
        where: { documentId }, data: { section: Prisma.DbNull, sourceSet: Prisma.DbNull },
      });
    },
    /** A second, independent worker process id — the contested replica. */
    secondWorker: new HillDayJobWorkerService(db, generation),
    ids: WS10_IDS,
    owner: OWNER,
    /** Make the next provider call drop the connection after acceptance. */
    providerAcceptsThenDrops() { providerBehaviour = 'accepted-then-dropped'; },
    providerRecovers() { providerBehaviour = 'ok'; },
    /** Run this while the next provider call is out (e.g. take the claim over). */
    whileProviderCallIsOut(hook: () => Promise<void>) { onDispatch = hook; },
    async close() {
      global.fetch = realFetch;
      await db.$disconnect();
    },
    unit(meetingId: string, state: 'queued' | 'running' | 'done' | 'failed' | 'unknown') {
      return { meetingId, state, sectionId: meetingId, reason: null, at: new Date().toISOString() };
    },
    async createJob(overrides: Record<string, unknown> = {}) {
      return db.wsHillDayJob.create({
        data: {
          tenantId, documentId, actorId: OWNER, status: 'queued',
          units: [this.unit(WS10_IDS.meeting1, 'queued'), this.unit(WS10_IDS.meeting2, 'queued')] as never,
          ...overrides,
        } as never,
      });
    },
    async leaseOf(jobId: string) {
      return db.wsHillDayJob.findUnique({
        where: { id: jobId },
        select: { status: true, leaseHolder: true, leaseExpiresAt: true, attemptCount: true, cancelRequestedAt: true, units: true, events: true, requestIds: true, quality: true },
      });
    },
    async expireLease(jobId: string) {
      return db.$executeRaw`
        UPDATE ws_hillday_job SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = ${jobId}::uuid
      `;
    },
    async clearLease(jobId: string) {
      return db.$executeRaw`
        UPDATE ws_hillday_job SET lease_expires_at = NULL, lease_holder = NULL WHERE id = ${jobId}::uuid
      `;
    },
  };
}
