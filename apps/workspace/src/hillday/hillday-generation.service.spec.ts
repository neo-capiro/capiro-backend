import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HillDayGenerationService } from './hillday-generation.service.js';

const doc = { id: '33333333-3333-4333-8333-333333333333', tenantId: 't', ownerId: 'user-1', clientId: 'client-1', timeZone: 'America/New_York', lookbackDays: 90 };
const meeting = {
  id: 'm-1',
  eventId: 'e-1',
  ordinal: 0,
  event: { subject: 'Meeting with Sen. Wicker', startsAt: '2026-09-14T13:00:00.000Z', endsAt: '2026-09-14T13:30:00.000Z' },
  resolution: { office: { member: 'Sen. Roger Wicker (R-MS)' }, attendees: [] },
  context: null,
  section: null,
};

function makeHarness(opts: { credential?: { provider: 'anthropic'; secret: string; model: string; usedTenantKey: boolean } | null } = {}) {
  const prisma = {
    wsHillDayDocument: { findFirst: jest.fn(async () => doc) },
    wsHillDayMeeting: { findFirst: jest.fn(async () => meeting) },
  };
  const credentials = {
    resolveAnthropic: jest.fn(async () => (opts.credential === undefined ? { provider: 'anthropic' as const, secret: 'sk-test', model: 'claude-sonnet-4-6', usedTenantKey: false } : opts.credential)),
  };
  const service = new HillDayGenerationService(prisma as never, { requireClient: jest.fn(async () => ({ id: 'client-1' })) } as never, credentials as never);
  return { service, prisma, credentials };
}

describe('HillDayGenerationService.refineText', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects when the caller is not the document owner', async () => {
    const { service } = makeHarness();
    await expect(service.refineText('t', 'intruder', '33333333-3333-4333-8333-333333333333', 'm-1', 'focus', 'Some draft text.')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an unknown section', async () => {
    const { service, prisma } = makeHarness();
    prisma.wsHillDayMeeting.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.refineText('t', 'user-1', '33333333-3333-4333-8333-333333333333', 'missing', 'focus', 'Some draft text.')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects empty text', async () => {
    const { service } = makeHarness();
    await expect(service.refineText('t', 'user-1', '33333333-3333-4333-8333-333333333333', 'm-1', 'focus', '   ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('surfaces a clear error when no model credential is configured', async () => {
    const { service } = makeHarness({ credential: null });
    await expect(service.refineText('t', 'user-1', '33333333-3333-4333-8333-333333333333', 'm-1', 'focus', 'Some draft text.')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('sends the draft to the model and returns the refined text', async () => {
    const { service } = makeHarness();
    const captured: { body: { system?: string; messages?: Array<{ content: string }> } | null } = { body: null };
    global.fetch = (async (_url: string, init: { body: string }) => {
      captured.body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'A tighter, cleaner version of the draft.' }] }),
      };
    }) as unknown as typeof fetch;

    const result = await service.refineText('t', 'user-1', '33333333-3333-4333-8333-333333333333', 'm-1', 'focus', 'a rough draft with some typos');
    expect(result.text).toBe('A tighter, cleaner version of the draft.');
    expect(captured.body?.messages?.[0]?.content).toContain('a rough draft with some typos');
    expect(captured.body?.messages?.[0]?.content).toContain('Sen. Roger Wicker (R-MS)');
    expect(captured.body?.system).toContain('never invent');
  });

  it('surfaces a clear error when the provider call fails', async () => {
    const { service } = makeHarness();
    global.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(service.refineText('t', 'user-1', '33333333-3333-4333-8333-333333333333', 'm-1', 'focus', 'Some draft text.')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

// ── WS-10 durable lifecycle witnesses ───────────────────────────────────────

const DOC_ID = '33333333-3333-4333-8333-333333333333';
const OWNER = 'user-1';
const TENANT = 't';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

/**
 * Minimal in-memory ws_hillday_job store so the start/retry/cancel transitions
 * are exercised against REAL state changes rather than call assertions.
 */
function jobStore(seed: Array<Record<string, unknown>> = []) {
  const jobs: Array<Record<string, unknown>> = seed.map((j) => ({ ...j, requestIds: [...((j.requestIds as string[]) ?? [])] }));
  const matches = (job: Record<string, unknown>, where: Record<string, any>): boolean => {
    if (where.id && job.id !== where.id) return false;
    if (where.tenantId && job.tenantId !== where.tenantId) return false;
    if (where.documentId && job.documentId !== where.documentId) return false;
    if (where.requestId && job.requestId !== where.requestId) return false;
    if (where.requestIds?.has && !(job.requestIds as string[]).includes(where.requestIds.has)) return false;
    if (where.status?.in && !where.status.in.includes(job.status)) return false;
    if (typeof where.status === 'string' && job.status !== where.status) return false;
    // The claim fence: holder AND generation must match, exactly as the real
    // where-clause does.
    if (where.leaseHolder !== undefined && job.leaseHolder !== where.leaseHolder) return false;
    if (where.attemptCount !== undefined && job.attemptCount !== where.attemptCount) return false;
    if (where.NOT?.id && job.id === where.NOT.id) return false;
    return true;
  };
  const delegate = {
    findFirst: jest.fn(async (args: { where?: Record<string, any> } = {}) =>
      jobs.find((job) => matches(job, args.where ?? {})) ?? null),
    findUnique: jest.fn(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const job = jobs.find((j) => j.id === args.where.id) ?? null;
      if (!job || !args.select) return job;
      // Honour a projection so `cancelRequestedAt`-only reads behave like Prisma.
      return Object.fromEntries(Object.keys(args.select).map((key) => [key, job[key]]));
    }),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      const job = { id: `job-${jobs.length + 1}`, ...args.data };
      jobs.push(job);
      return job;
    }),
    update: jest.fn(async (args: { where: { id: string }; data: Record<string, any> }) => {
      const job = jobs.find((j) => j.id === args.where.id)!;
      for (const [key, value] of Object.entries(args.data)) {
        if (value && typeof value === 'object' && 'push' in (value as object)) {
          (job[key] as string[]).push((value as { push: string }).push);
        } else {
          job[key] = value;
        }
      }
      return job;
    }),
    updateMany: jest.fn(async (args: { where: Record<string, any>; data: Record<string, unknown> }) => {
      const found = jobs.filter((job) => matches(job, args.where));
      for (const job of found) Object.assign(job, args.data);
      return { count: found.length };
    }),
  };
  return { jobs, delegate };
}

function lifecycleHarness(seed: Array<Record<string, unknown>> = []) {
  const store = jobStore(seed);
  const document = { id: DOC_ID, tenantId: TENANT, ownerId: OWNER, clientId: 'client-1', timeZone: 'UTC', lookbackDays: 90 };
  const tx = {
    wsHillDayJob: store.delegate,
    $executeRaw: jest.fn(async () => 1),
    wsHillDayDocument: { update: jest.fn(async () => document) },
    wsHillDayMeeting: { findMany: jest.fn(async () => [{ id: MEETING_ID }]) },
  };
  const prisma = {
    wsHillDayJob: store.delegate,
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    wsHillDayDocument: { findFirst: jest.fn(async () => document), update: tx.wsHillDayDocument.update },
    wsHillDayMeeting: { findMany: tx.wsHillDayMeeting.findMany, update: jest.fn(async () => ({})) },
  };
  const service = new HillDayGenerationService(
    prisma as never,
    { requireClient: jest.fn(async () => ({ id: 'client-1' })) } as never,
    { resolveAnthropic: jest.fn(async () => null) } as never,
  );
  return { service, prisma, tx, jobs: store.jobs };
}

describe('HillDayGenerationService.start — atomic admission and request binding', () => {
  it('replaying the same request returns the same job and creates nothing', async () => {
    const h = lifecycleHarness([{ id: 'job-1', tenantId: TENANT, documentId: DOC_ID, status: 'queued', requestId: 'req-a', requestIds: ['req-a'] }]);
    const first = await h.service.start(TENANT, OWNER, DOC_ID, 'req-a');
    const replay = await h.service.start(TENANT, OWNER, DOC_ID, 'req-a');
    expect(replay.jobId).toBe('job-1');
    expect(first.jobId).toBe('job-1');
    expect(h.jobs).toHaveLength(1);
  });

  it('binds a start that was answered by an already-active job, so it is replayable after that job ends', async () => {
    const h = lifecycleHarness([{ id: 'job-A', tenantId: TENANT, documentId: DOC_ID, status: 'queued', requestId: 'req-a', requestIds: ['req-a'] }]);
    // Request B arrives while A is active: it reuses A and is BOUND to it.
    const bound = await h.service.start(TENANT, OWNER, DOC_ID, 'req-b');
    expect(bound.jobId).toBe('job-A');
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]!.requestIds).toEqual(['req-a', 'req-b']);

    // A finishes; replaying the SAME request B must still return A.
    h.jobs[0]!.status = 'complete';
    const replay = await h.service.start(TENANT, OWNER, DOC_ID, 'req-b');
    expect(replay.jobId).toBe('job-A');
    expect(replay.status).toBe('complete');
    expect(h.jobs).toHaveLength(1);
  });

  it('returns the committed winner when a same-request race loses at the unique key', async () => {
    const h = lifecycleHarness([{ id: 'job-A', tenantId: TENANT, documentId: DOC_ID, status: 'queued', requestId: 'req-a', requestIds: ['req-a'] }]);
    h.tx.wsHillDayJob.create = jest.fn(async () => {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }) as never;
    const result = await h.service.start(TENANT, OWNER, DOC_ID, 'req-b');
    expect(result.jobId).toBe('job-A');
  });

  it('creates exactly one job when starting a document with no active job', async () => {
    const h = lifecycleHarness();
    const result = await h.service.start(TENANT, OWNER, DOC_ID, 'req-a');
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]!.requestIds).toEqual(['req-a']);
    expect(result.status).toBe('queued');
  });
});

describe('HillDayGenerationService retry/cancel — conditional transitions', () => {
  it('retry does not rewrite a job whose state moved under it', async () => {
    const h = lifecycleHarness([{
      id: 'job-1', tenantId: TENANT, documentId: DOC_ID, status: 'complete',
      units: [{ meetingId: 'm-1', state: 'done', sectionId: 'm-1', reason: null, at: 'x' },
        { meetingId: 'm-2', state: 'failed', sectionId: 'm-2', reason: 'provider_unavailable', at: 'x' }],
    }]);
    h.tx.wsHillDayJob.updateMany = jest.fn(async () => ({ count: 0 })) as never;
    const result = await h.service.retryFailedUnits(TENANT, OWNER, DOC_ID, 'job-1');
    // The compare-and-set lost: the persisted state is reported, not overwritten.
    expect(result.status).toBe('complete');
    expect(h.tx.wsHillDayDocument.update).not.toHaveBeenCalled();
  });

  it('retry re-queues failed units when the state it read is still current', async () => {
    const h = lifecycleHarness([{
      id: 'job-1', tenantId: TENANT, documentId: DOC_ID, status: 'complete',
      units: [{ meetingId: 'm-1', state: 'done', sectionId: 'm-1', reason: null, at: 'x' },
        { meetingId: 'm-2', state: 'failed', sectionId: 'm-2', reason: 'provider_unavailable', at: 'x' }],
    }]);
    const result = await h.service.retryFailedUnits(TENANT, OWNER, DOC_ID, 'job-1');
    expect(result.status).toBe('queued');
    expect(h.jobs[0]!.units).toMatchObject([
      { meetingId: 'm-1', state: 'done' },
      { meetingId: 'm-2', state: 'queued' },
    ]);
  });

  it('refuses a retry while a different job for the document is active', async () => {
    const h = lifecycleHarness([
      { id: 'job-1', tenantId: TENANT, documentId: DOC_ID, status: 'failed', units: [] },
      { id: 'job-2', tenantId: TENANT, documentId: DOC_ID, status: 'running', units: [] },
    ]);
    await expect(h.service.retryFailedUnits(TENANT, OWNER, DOC_ID, 'job-1')).rejects.toMatchObject({ status: 409 });
  });

  it('records only the cancellation request when a worker claimed the job first', async () => {
    const h = lifecycleHarness([{ id: 'job-1', tenantId: TENANT, documentId: DOC_ID, status: 'queued', units: [] }]);
    // The conditional `queued -> cancelled` update matches nothing because the
    // worker claimed the job in between; the running branch then records it.
    h.tx.wsHillDayJob.updateMany = jest.fn(async (args: { where: Record<string, any>; data: Record<string, unknown> }) => {
      if (args.where.status === 'queued') return { count: 0 };
      Object.assign(h.jobs[0]!, args.data);
      return { count: 1 };
    }) as never;
    h.jobs[0]!.status = 'running';
    const result = await h.service.requestCancel(TENANT, OWNER, DOC_ID, 'job-1');
    // Honest: provider work is in flight, so the job is NOT reported cancelled.
    expect(result.status).toBe('running');
    expect(result.cancelRequestedAt).not.toBeNull();
  });

  it('cancels a queued job outright', async () => {
    const h = lifecycleHarness([{ id: 'job-1', tenantId: TENANT, documentId: DOC_ID, status: 'queued', units: [] }]);
    const result = await h.service.requestCancel(TENANT, OWNER, DOC_ID, 'job-1');
    expect(result.status).toBe('cancelled');
    expect(h.tx.wsHillDayDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'partial' } }),
    );
  });
});

describe('HillDayGenerationService — accepted-then-disconnected provider boundary', () => {
  function runHarness() {
    const store = jobStore([{
      id: 'job-1', tenantId: TENANT, documentId: DOC_ID, actorId: OWNER, status: 'running',
      leaseHolder: 'w', attemptCount: 1, startedAt: null,
      units: [{ meetingId: MEETING_ID, state: 'queued', sectionId: MEETING_ID, reason: null, at: 'x' }],
      events: [],
    }]);
    const document = { id: DOC_ID, tenantId: TENANT, ownerId: OWNER, clientId: 'client-1', timeZone: 'UTC', lookbackDays: 90 };
    const raw: string[] = [];
    const published: Input = { section: null, writes: 0 };
    /** Ordered record of the writes that actually reach the store. */
    const journal: string[] = [];
    const fails = { documentWrite: false };
    /** Mirrors the database: the claim exists only while that exact claim is current. */
    const claimHeld = () => store.jobs[0]!.leaseHolder === 'w'
      && store.jobs[0]!.attemptCount === 1
      && store.jobs[0]!.status === 'running';
    const fencedJobWrite = store.delegate.updateMany;
    store.delegate.updateMany = jest.fn(async (args: never) => {
      const result = await fencedJobWrite(args);
      if ((result as { count: number }).count === 1) journal.push('job-write');
      return result;
    }) as never;
    const tx = {
      wsHillDayJob: store.delegate,
      wsHillDayDocument: {
        update: jest.fn(async () => {
          if (fails.documentWrite) throw new Error('document write failed');
          journal.push('document-write');
          return document;
        }),
      },
      wsHillDayMeeting: { findUnique: jest.fn(async () => ({ documentId: DOC_ID })) },
      $executeRaw: jest.fn(async (parts: TemplateStringsArray) => {
        const sql = parts.join('$PARAM');
        raw.push(sql);
        if (sql.includes('FROM ws_hillday_document')) journal.push('lock-document');
        if (sql.includes('UPDATE ws_hillday_meeting')) published.writes += 1;
        return 1;
      }),
      $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
        const sql = parts.join('$PARAM');
        raw.push(sql);
        if (sql.includes('FROM ws_hillday_job')) return claimHeld() ? [{ id: 'job-1' }] : [];
        if (sql.includes('FROM ws_hillday_meeting')) return [{ section: published.section }];
        return [];
      }),
    };
    const prisma = {
      ...tx,
      // PostgreSQL semantics: the whole callback is one transaction, so a throw
      // rolls every write inside it back.
      $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
        const snapshot = JSON.parse(JSON.stringify(store.jobs)) as Array<Record<string, unknown>>;
        const commit = journal.length;
        journal.push('tx-open');
        try {
          const result = await fn(tx);
          journal.push('tx-close');
          return result;
        } catch (error) {
          store.jobs.length = 0;
          store.jobs.push(...snapshot);
          journal.length = commit;
          throw error;
        }
      }),
      wsHillDayDocument: { findFirst: jest.fn(async () => document), update: tx.wsHillDayDocument.update },
      wsHillDayMeeting: {
        findMany: jest.fn(async () => [{
          id: MEETING_ID, eventId: 'e-1', ordinal: 0, context: null, resolution: null,
          section: published.section,
          event: { eventId: 'e-1', subject: 'Meeting', startsAt: '2026-10-26T13:00:00.000Z', endsAt: '2026-10-26T13:30:00.000Z' },
        }]),
        update: jest.fn(async () => ({})),
        findUnique: tx.wsHillDayMeeting.findUnique,
      },
    };
    const credentials = {
      resolveAnthropic: jest.fn(async () => ({ provider: 'anthropic' as const, secret: 'sk-test', model: 'claude-sonnet-4-6', usedTenantKey: false })),
    };
    const source = {
      requireClient: jest.fn(async () => ({ id: 'client-1' })),
      resolveUserId: jest.fn(async () => null),
      tenantName: jest.fn(async () => 'Firm'),
      getClient: jest.fn(async () => ({ name: 'Client', sectorTag: null, description: null, productDescription: null })),
      listStrategies: jest.fn(async () => []),
      listThreads: jest.fn(async () => []),
      threadMessages: jest.fn(async () => []),
      priorMeetings: jest.fn(async () => []),
    };
    const service = new HillDayGenerationService(prisma as never, source as never, credentials as never);
    return { service, source, prisma, jobs: store.jobs, raw, published, journal, fails, claimHeld };
  }

  type Input = { section: unknown; writes: number };

  const UNIT_JSON = '{"focus":"f","background":"b","unsupported":[]}';
  const ANSWER = { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: UNIT_JSON }] }) };

  it('never issues a second provider call after a transport drop, and parks the unit unknown', async () => {
    const h = runHarness();
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      // The provider accepted the request, then the connection dropped.
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    const lifecycle = await h.service.runClaimedJob('job-1', { holder: 'w', attempt: 1 }, async () => true);

    expect(calls).toBe(1);
    expect(lifecycle).toBe('complete');
    const units = h.jobs[0]!.units as Array<{ state: string; reason: string | null }>;
    expect(units[0]!.state).toBe('unknown');
    expect(units[0]!.reason).toBe('provider_uncertain');
  });

  it('locks the job row before writing the section, so publication serializes with takeover', async () => {
    const h = runHarness();
    global.fetch = (async () => ANSWER) as unknown as typeof fetch;

    await h.service.runClaimedJob('job-1', { holder: 'w', attempt: 1 }, async () => true);

    const jobLock = h.raw.findIndex((sql) => sql.includes('FROM ws_hillday_job') && sql.includes('FOR UPDATE'));
    const meetingLock = h.raw.findIndex((sql) => sql.includes('FROM ws_hillday_meeting') && sql.includes('FOR UPDATE'));
    const sectionWrite = h.raw.findIndex((sql) => sql.includes('UPDATE ws_hillday_meeting'));
    expect(jobLock).toBeGreaterThanOrEqual(0);
    // The claim's own row is locked FIRST — the row a takeover changes — and the
    // section write only happens after it, inside the same transaction.
    expect(meetingLock).toBeGreaterThan(jobLock);
    expect(sectionWrite).toBeGreaterThan(meetingLock);
    expect(h.published.writes).toBe(1);
  });

  it('drops the generated section when the user edited it while the call was out', async () => {
    const h = runHarness();
    // A manual edit landed while the provider call was out.
    h.published.section = { sectionId: MEETING_ID, edited: { focus: true, background: false, at: 'x' } };
    global.fetch = (async () => ANSWER) as unknown as typeof fetch;

    await h.service.runClaimedJob('job-1', { holder: 'w', attempt: 1 }, async () => true);

    expect(h.published.writes).toBe(0);
    const units = h.jobs[0]!.units as Array<{ state: string; reason: string | null }>;
    expect(units[0]!.reason).toBe('edited_preserved');
  });

  it('drops a late provider result once its claim was taken over mid-call, and does not terminalize', async () => {
    const h = runHarness();
    global.fetch = (async () => {
      // Another claim takes the job over while this provider call is out.
      h.jobs[0]!.leaseHolder = 'other-worker';
      h.jobs[0]!.attemptCount = 2;
      return ANSWER;
    }) as unknown as typeof fetch;

    const lifecycle = await h.service.runClaimedJob('job-1', { holder: 'w', attempt: 1 }, async () => true);

    expect(lifecycle).toBe('running');
    expect(h.claimHeld()).toBe(false);
    // The late success was neither published nor terminalized...
    expect(h.published.writes).toBe(0);
    expect(h.jobs[0]!.status).toBe('running');
    // ...and the unit never advanced past the pre-takeover running marker.
    expect((h.jobs[0]!.units as Array<{ state: string }>)[0]!.state).toBe('running');
  });

  it('keeps an uncertain FORMAT-REPAIR outcome instead of reporting a parsing failure', async () => {
    const h = runHarness();
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        // Acknowledged, but not the JSON the unit expects: a repair call follows.
        return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'I could not comply.' }] }) };
      }
      // The repair call is accepted, then the connection drops.
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    await h.service.runClaimedJob('job-1', { holder: 'w', attempt: 1 }, async () => true);

    // Exactly two dispatches: the first answer plus ONE repair, and no third call.
    expect(calls).toBe(2);
    const units = h.jobs[0]!.units as Array<{ state: string; reason: string | null }>;
    expect(units[0]!.state).toBe('unknown');
    expect(units[0]!.reason).toBe('provider_uncertain');
  });

  it('refuses to publish when current access is revoked while the provider call is out', async () => {
    const h = runHarness();
    let wallAllowed = true;
    (h.source.requireClient as jest.Mock).mockImplementation(async () => {
      if (!wallAllowed) throw new NotFoundException('Client not found');
      return { id: 'client-1' };
    });
    global.fetch = (async () => {
      // Admission passed; the wall is revoked while THIS unit's call is out.
      wallAllowed = false;
      return ANSWER;
    }) as unknown as typeof fetch;

    const lifecycle = await h.service.runClaimedJob('job-1', { holder: 'w', attempt: 1 }, async () => true);

    // The unit was generated, but access is re-checked at the publication
    // boundary, so its text is never published and the job fails honestly.
    expect(h.published.writes).toBe(0);
    expect(lifecycle).toBe('failed');
  });

  it('finalizes the terminal job and the owning document in ONE transaction, document lock first', async () => {
    const h = runHarness();
    global.fetch = (async () => ANSWER) as unknown as typeof fetch;

    const lifecycle = await h.service.runClaimedJob('job-1', { holder: 'w', attempt: 1 }, async () => true);

    expect(lifecycle).toBe('complete');
    // The owning document's admission lock (the lock start/retry already take),
    // then the fenced terminal job write, then the document status — all inside
    // ONE transaction, which closes only after both writes.
    expect(h.journal.slice(h.journal.lastIndexOf('lock-document'))).toEqual([
      'lock-document',
      'job-write',
      'document-write',
      'tx-close',
    ]);
  });

  it('leaves no committed terminal job when the owning-document write fails', async () => {
    const h = runHarness();
    h.fails.documentWrite = true;
    global.fetch = (async () => ANSWER) as unknown as typeof fetch;

    const lifecycle = await h.service.runClaimedJob('job-1', { holder: 'w', attempt: 1 }, async () => true);

    // The finalization transaction rolled back: no terminal job was committed
    // against a document that never moved, and the run does not claim success.
    expect(h.journal).not.toContain('document-write');
    expect(h.jobs[0]!.status).toBe('running');
    expect(lifecycle).toBe('running');
  });
});
