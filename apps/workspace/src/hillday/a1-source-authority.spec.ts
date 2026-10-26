import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { HillDaySourceService } from './hillday-source.service.js';
import { HillDayDocumentService } from './hillday-document.service.js';
import { HillDayGenerationService } from './hillday-generation.service.js';
import { HillDayExportService } from './hillday-export.service.js';

// Export admission is exercised without loading the PDF renderer or making
// provider calls. requireClient, getClient and the caller admission are real.
jest.mock('pdfkit', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const DOCUMENT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const ACTOR = 'clerk-owner';

function fixture() {
  const state = { wallAllowed: true, membership: 'active', tenant: 'active' };
  const now = new Date('2026-10-21T12:00:00Z');
  const document = {
    id: DOCUMENT,
    tenantId: TENANT,
    ownerId: ACTOR,
    clientId: CLIENT,
    clientName: 'Client',
    name: 'Private packet',
    status: 'draft',
    timeZone: 'UTC',
    lookbackDays: 90,
    updatedAt: now,
    createdAt: now,
  };
  const membershipRead = jest.fn(async (parts: TemplateStringsArray, ..._values: unknown[]) => {
    // Rows model the outcome of the real membership SQL. This is a database
    // seam, not native PostgreSQL/RLS evidence and not a requireClient mock.
    if (parts.join('').includes('JOIN tenant_memberships')) {
      return state.membership === 'active' && state.tenant === 'active' ? [{ id: USER }] : [];
    }
    return [];
  });
  const clientRead = jest.fn(async (_parts: TemplateStringsArray, ..._values: unknown[]) => [
    {
      id: CLIENT,
      name: 'Client',
      description: null,
      sectorTag: null,
      productDescription: null,
      hasLogo: false,
      officeCount: 0,
      wallAllowed: state.wallAllowed,
    },
  ]);
  const tx = { $executeRaw: jest.fn(async () => 1), $queryRaw: clientRead };
  // The job's persisted `units` array is now the durable record of what still
  // has to run, so a test that exercises the run loop seeds it.
  const units: unknown[] = [];
  const job = {
    id: 'job',
    tenantId: TENANT,
    documentId: DOCUMENT,
    actorId: ACTOR,
    status: 'running',
    units,
    events: [],
    quality: null,
    error: null,
    cancelRequestedAt: null,
    leaseHolder: 'test-worker',
    attemptCount: 1,
    startedAt: null,
    completedAt: null,
  };
  const db = {
    withSystem: async (read: (value: { $queryRaw: typeof membershipRead }) => Promise<unknown>) =>
      read({ $queryRaw: membershipRead }),
    $transaction: async (read: (value: typeof tx) => Promise<unknown>) => read(tx),
    // Section/source publication is one conditional statement; the fixture
    // supplies the "one row written while the claim still held" outcome.
    $executeRaw: jest.fn(async () => 1),
    wsHillDayDocument: {
      findFirst: jest.fn(async () => document),
      findMany: jest.fn(async () => [document]),
      update: jest.fn(async () => document),
    },
    wsHillDayMeeting: { findMany: jest.fn(async () => [] as Array<{ id: string; section: null }>) },
    wsHillDayJob: {
      findFirst: jest.fn(async () => job),
      findUnique: jest.fn(async () => job),
      update: jest.fn(async () => job),
      // Fenced writes: `updateMany` carries the claim predicate and reports
      // whether this claim is still current.
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    wsHillDayExport: {
      findFirst: jest.fn(async () => ({
        id: 'export',
        documentId: DOCUMENT,
        tenantId: TENANT,
        actorId: ACTOR,
        status: 'ready',
        pageSize: 'letter',
        filename: 'packet.pdf',
        sizeBytes: 3,
        error: null,
        createdAt: now,
      })),
    },
  };
  const source = new HillDaySourceService(db as never);
  const documents = new HillDayDocumentService(db as never, source, {} as never, {} as never);
  const generation = new HillDayGenerationService(db as never, source, {} as never);
  const exports = new HillDayExportService(db as never, documents, {} as never);
  return { state, db, source, documents, generation, exports, membershipRead, clientRead, job };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('A1 real Hill Day source admission', () => {
  it.each(['get', 'list', 'job', 'export'] as const)(
    '%s refuses a revoked wall through requireClient',
    async (operation) => {
      const h = fixture();
      const read = () =>
        operation === 'get'
          ? h.documents.get(TENANT, DOCUMENT, ACTOR)
          : operation === 'list'
            ? h.documents.listDocuments(TENANT, ACTOR, { kind: 'hillday' })
            : operation === 'job'
              ? h.generation.jobStatus(TENANT, DOCUMENT, 'job', ACTOR)
              : h.exports.get(TENANT, DOCUMENT, 'export', ACTOR);

      // First prove the same owner/resource succeeds while its current wall allows it.
      await expect(read()).resolves.toBeDefined();
      h.state.wallAllowed = false;
      h.db.wsHillDayMeeting.findMany.mockClear();
      h.db.wsHillDayJob.findFirst.mockClear();
      h.db.wsHillDayExport.findFirst.mockClear();
      if (operation === 'list') {
        await expect(read()).resolves.toMatchObject({ items: [] });
      } else {
        await expect(read()).rejects.toMatchObject({ status: 404 });
      }
      expect(h.clientRead).toHaveBeenCalled();
      expect(h.db.wsHillDayMeeting.findMany).not.toHaveBeenCalled();
      expect(h.db.wsHillDayJob.findFirst).not.toHaveBeenCalled();
      expect(h.db.wsHillDayExport.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each(['removed', 'suspended', 'inactive-tenant'] as const)(
    'requireClient refuses %s even when the client wall permits access',
    async (status) => {
      const h = fixture();
      await expect(h.source.requireClient(TENANT, ACTOR, CLIENT)).resolves.toMatchObject({
        id: CLIENT,
      });
      if (status === 'inactive-tenant') h.state.tenant = 'inactive';
      else h.state.membership = status;
      h.clientRead.mockClear();
      await expect(h.source.requireClient(TENANT, ACTOR, CLIENT)).rejects.toMatchObject({
        status: 404,
      });
      expect(h.clientRead).not.toHaveBeenCalled();
      // The real SQL is sent with the current tenant and actor; the fixture only
      // supplies the rows it would return for the requested inactive identity.
      const query = h.membershipRead.mock.calls.at(-1)!;
      expect(query[0].join('')).toContain("m.status::text='active'");
      expect(query[0].join('')).toContain("t.status::text='active'");
      expect(query.slice(1)).toEqual([TENANT, ACTOR]);
    },
  );

  it('stops remaining generation units when the wall is revoked after the first admitted batch', async () => {
    const h = fixture();
    const meetings = Array.from({ length: 6 }, (_, index) => ({
      id: `meeting-${index + 1}`,
      section: null,
    }));
    h.db.wsHillDayMeeting.findMany.mockResolvedValue(meetings);
    // The durable job already holds the six selected meetings as queued units.
    h.job.units.push(
      ...meetings.map((meeting) => ({
        meetingId: meeting.id, state: 'queued', sectionId: meeting.id, reason: null,
        at: '2026-10-26T00:00:00.000Z',
      })),
    );
    // Only context composition/model output are seams. The run loop and every
    // assertDoc -> requireClient -> getClient admission are the real services.
    // `renew` is the lease heartbeat the durable worker supplies; here it always
    // succeeds so the test isolates the mid-run wall revocation.
    const internal = h.generation as unknown as {
      runClaimedJob(job: string, claim: { holder: string; attempt: number }, renew: () => Promise<boolean>): Promise<string>;
      sharedContext(): Promise<unknown>;
      generateUnit(
        tenant: string,
        meeting: { id: string },
      ): Promise<{ section: { status: string } }>;
    };
    jest.spyOn(internal, 'sharedContext').mockResolvedValue({ credential: null });
    const started: string[] = [];
    let releaseBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    jest.spyOn(internal, 'generateUnit').mockImplementation(async (_tenant, meeting) => {
      started.push(meeting.id);
      if (started.length === 2) {
        h.state.wallAllowed = false;
        releaseBatch();
      }
      await firstBatch;
      return { section: { status: 'done' } };
    });
    await internal.runClaimedJob('job', { holder: 'test-worker', attempt: 1 }, async () => true);
    expect(started.sort()).toEqual(['meeting-1', 'meeting-2']);
    // The failure is published through the claim FENCE, so a superseded holder
    // could never write this over a successor's job.
    expect(h.db.wsHillDayJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job', leaseHolder: 'test-worker', attemptCount: 1, status: 'running',
        }),
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
    expect(h.db.wsHillDayDocument.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'generated' }),
      }),
    );
  });
});
