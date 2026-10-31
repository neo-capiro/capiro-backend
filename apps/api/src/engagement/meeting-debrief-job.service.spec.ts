import { describe, expect, test, jest } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeetingDebriefJobService } from './meeting-debrief-job.service.js';
import { MEETING_DEBRIEF_POLICY } from './meeting-prep-policy.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  tenantSlug: 'acme',
  userId: '22222222-2222-2222-2222-222222222222',
  clerkUserId: 'clerk-1',
  role: 'user' as TenantContext['role'],
};

interface Row {
  id: string;
  tenantId: string;
  userId: string;
  meetingId: string;
  requestKey: string;
  requestHash: string;
  status: string;
  stage: string;
  input: unknown;
  checkpoints: unknown;
  leaseToken: string | null;
  leaseUntil: Date | null;
  deadlineAt: Date;
  attempts: number;
  debriefId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'job-1',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    meetingId: 'meeting-1',
    requestKey: 'request-key-1',
    requestHash: 'hash',
    status: 'queued',
    stage: 'queued',
    input: {},
    checkpoints: {},
    leaseToken: null,
    leaseUntil: null,
    deadlineAt: new Date(Date.now() + MEETING_DEBRIEF_POLICY.deadlineMs),
    attempts: 0,
    debriefId: null,
    errorCode: null,
    createdAt: new Date('2026-10-31T09:00:00.000Z'),
    updatedAt: new Date('2026-10-31T09:00:00.000Z'),
    ...overrides,
  };
}

function harness(
  options: {
    gate?: string;
    rows?: Row[];
    authorize?: (
      tx?: unknown,
      ctx?: unknown,
      meetingId?: string,
      expected?: string,
    ) => Promise<unknown>;
  } = {},
) {
  process.env.MEETING_DEBRIEF_JOB_ENABLED = options.gate ?? 'true';
  const rows: Row[] = options.rows ?? [];
  const create = jest.fn(async ({ data }: { data: Partial<Row> }) => {
    const created = row({ ...data, id: `job-${rows.length + 1}` });
    rows.push(created);
    return created;
  });
  const findUnique = jest.fn(async ({ where }: { where: { tenantId_userId_requestKey: { requestKey: string } } }) =>
    rows.find((entry) => entry.requestKey === where.tenantId_userId_requestKey.requestKey) ?? null,
  );
  const findFirst = jest.fn(async ({ where }: { where: { id?: string } }) => {
    const match = rows.find((entry) => (where.id ? entry.id === where.id : true));
    return match ?? null;
  });
  const updateMany = jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const match = rows.find((entry) => entry.id === where.id);
    if (!match) return { count: 0 };
    Object.assign(match, data);
    return { count: 1 };
  });
  const tx = {
    meetingDebriefJob: { create, findUnique, findFirst, updateMany },
    tenantMembership: { findFirst: async () => ({ role: 'user' }) },
  };
  const service = Object.create(MeetingDebriefJobService.prototype) as MeetingDebriefJobService;
  Object.assign(service as unknown as Record<string, unknown>, {
    prisma: { withTenantUser: (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(tx) },
    // Base64, so "the source is not stored in plaintext" is a real assertion rather
    // than a property of the double.
    crypto: {
      encrypt: (value: string) => ({ cipher: Buffer.from(value, 'utf8').toString('base64') }),
      decrypt: (value: { cipher?: string } | string) =>
        typeof value === 'string'
          ? value
          : Buffer.from(value?.cipher ?? '', 'base64').toString('utf8') || '{}',
    },
    runtime: { assertExternalAction: () => undefined },
    prepJobs: { authorizeJobMeeting: options.authorize ?? (async () => ({ assignment: 'a', clientId: null })) },
    engagement: {},
  });
  return { service, rows, create, findUnique, updateMany };
}

const submitInput = { method: 'upload' as const, sourceText: 'Transcript body for the meeting.' };

describe('D1 debrief job', () => {
  test('submits a queued job with a >= 10 minute deadline and the requestKey echoed', async () => {
    const h = harness();
    const job = await h.service.submit(ctx, 'meeting-1', { ...submitInput, requestKey: 'request-key-1' });
    expect(job).toMatchObject({
      meetingId: 'meeting-1',
      status: 'queued',
      stage: 'queued',
      requestKey: 'request-key-1',
      debriefId: null,
    });
    const deadlineMs = (job.deadlineAt as Date).getTime() - Date.now();
    expect(deadlineMs).toBeGreaterThanOrEqual(10 * 60_000 - 5_000);
    expect(deadlineMs).toBeLessThanOrEqual(MEETING_DEBRIEF_POLICY.deadlineMs + 5_000);
    // The source never reaches the row in plaintext.
    expect(JSON.stringify(h.rows[0]?.input)).not.toContain(submitInput.sourceText);
  });

  test('a retry with the same requestKey returns the same job without a second create', async () => {
    const h = harness();
    const first = await h.service.submit(ctx, 'meeting-1', { ...submitInput, requestKey: 'request-key-1' });
    const second = await h.service.submit(ctx, 'meeting-1', { ...submitInput, requestKey: 'request-key-1' });
    expect(second.jobId).toBe(first.jobId);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  test('the same key with a different transcript is a conflict, not a silent regeneration', async () => {
    const h = harness();
    await h.service.submit(ctx, 'meeting-1', { ...submitInput, requestKey: 'request-key-1' });
    await expect(
      h.service.submit(ctx, 'meeting-1', {
        method: 'upload',
        sourceText: 'A different transcript.',
        requestKey: 'request-key-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  test('an empty source is refused before any job exists', async () => {
    const h = harness();
    await expect(
      h.service.submit(ctx, 'meeting-1', { method: 'manual', sourceText: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.create).not.toHaveBeenCalled();
  });

  test('with the gate off the job is refused and no state is readable', async () => {
    const h = harness({ gate: 'false' });
    await expect(h.service.submit(ctx, 'meeting-1', submitInput)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(await h.service.get(ctx, 'meeting-1')).toBeNull();
    expect(h.create).not.toHaveBeenCalled();
  });

  test('cancel marks the job cancelled and returns the persisted row', async () => {
    const h = harness({ rows: [row()] });
    const cancelled = await h.service.cancel(ctx, 'meeting-1', 'job-1');
    expect(cancelled).toMatchObject({ jobId: 'job-1', status: 'cancelled', stage: 'cancelled' });
  });

  test('resume requeues a failed job, and refuses an exhausted budget', async () => {
    const failed = row({
      status: 'failed',
      stage: 'failed',
      errorCode: 'DEBRIEF_GENERATION_FAILED',
      input: { cipher: Buffer.from(JSON.stringify({ method: 'upload', sourceText: 'x', assignment: 'a' }), 'utf8').toString('base64') },
    });
    const h = harness({ rows: [failed] });
    const resumed = await h.service.resume(ctx, 'meeting-1', 'job-1');
    expect(resumed).toMatchObject({ status: 'queued', stage: 'queued', errorCode: null });

    const exhausted = row({
      id: 'job-2',
      status: 'failed',
      deadlineAt: new Date(Date.now() - 1_000),
      input: { cipher: Buffer.from(JSON.stringify({ method: 'upload', sourceText: 'x', assignment: 'a' }), 'utf8').toString('base64') },
    });
    const h2 = harness({ rows: [exhausted] });
    await expect(h2.service.resume(ctx, 'meeting-1', 'job-2')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test('a changed meeting assignment fails the read rather than returning another job', async () => {
    const h = harness({
      rows: [row()],
      authorize: async () => {
        throw new NotFoundException('Meeting client access changed.');
      },
    });
    await expect(h.service.get(ctx, 'meeting-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  test('the public payload exposes no provider raw and no draft before completion', async () => {
    const h = harness({ rows: [row()] });
    const job = await h.service.get(ctx, 'meeting-1');
    expect(job).not.toHaveProperty('draft');
    expect(JSON.stringify(job)).not.toContain('raw');
  });
});

const envelope = (value: unknown) => ({
  cipher: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
});
const jobInput = (assignment: string) =>
  envelope({ method: 'upload', sourceText: 'Transcript body.', assignment });
const completedDraft = {
  recap: 'Recap.',
  actionItems: ['Send the one-pager'],
  notes: 'Notes.',
  provider: 'anthropic',
  model: 'synthetic-model',
};

function workerHarness(options: {
  rows: Row[];
  authorize: (expected?: string) => Promise<unknown>;
  draft?: unknown;
}) {
  process.env.MEETING_DEBRIEF_JOB_ENABLED = 'true';
  const rows = options.rows;
  const findFirst = jest.fn(async ({ where }: { where: { id?: string } }) => {
    // The claim query filters on queued/deadline; the read query filters by id.
    if (where.id) return rows.find((entry) => entry.id === where.id) ?? null;
    // The claim path filters for a queued row; a read returns the newest row.
    return rows.find((entry) => entry.status === 'queued') ?? rows[0] ?? null;
  });
  const updateMany = jest.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const match = rows.find((entry) => entry.id === where.id);
      if (!match) return { count: 0 };
      Object.assign(match, data);
      return { count: 1 };
    },
  );
  const tx = {
    meetingDebriefJob: { findFirst, updateMany, create: jest.fn(), findUnique: jest.fn() },
    tenantMembership: {
      findFirst: async () => ({
        role: 'user',
        user: { clerkUserId: 'clerk-1' },
        tenant: { slug: 'acme' },
      }),
    },
  };
  const service = Object.create(MeetingDebriefJobService.prototype) as MeetingDebriefJobService;
  Object.assign(service as unknown as Record<string, unknown>, {
    prisma: {
      withTenantUser: (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(tx),
      withSystem: (fn: (tx: unknown) => unknown) => fn(tx),
    },
    crypto: {
      encrypt: (value: string) => envelope(JSON.parse(value)),
      decrypt: (value: { cipher?: string }) =>
        Buffer.from(value?.cipher ?? '', 'base64').toString('utf8') || '{}',
    },
    runtime: {
      assertExternalAction: () => undefined,
      assertMeetingDebriefWorker: () => undefined,
    },
    prepJobs: {
      authorizeJobMeeting: (
        _tx: unknown,
        _ctx: unknown,
        _meetingId: string,
        expected?: string,
      ) => options.authorize(expected),
    },
    engagement: {
      generateMeetingDebriefDraft: jest.fn(async () => options.draft ?? completedDraft),
    },
  });
  return { service, rows, updateMany, engagement: service as unknown as { engagement: { generateMeetingDebriefDraft: jest.Mock } } };
}

describe('completion delivery and recorded-assignment binding', () => {
  test('a completed job returns the draft persisted as an encrypted envelope object', async () => {
    const h = harness({
      rows: [
        row({
          status: 'completed',
          stage: 'completed',
          input: envelope({ method: 'upload', sourceText: 'x', assignment: 'a' }),
          checkpoints: { draft: envelope(completedDraft) },
        }),
      ],
    });

    const job = await h.service.get(ctx, 'meeting-1');

    expect(job?.status).toBe('completed');
    expect(job?.draft).toEqual(completedDraft);
    // The stored envelope never leaks into the public payload.
    expect(JSON.stringify(job)).not.toContain('cipher');
  });

  test('a malformed completed checkpoint yields no draft instead of crashing', async () => {
    const h = harness({
      rows: [
        row({
          status: 'completed',
          stage: 'completed',
          input: envelope({ method: 'upload', sourceText: 'x', assignment: 'a' }),
          checkpoints: { draft: { cipher: 'not-json' } },
        }),
      ],
    });

    const job = await h.service.get(ctx, 'meeting-1');

    expect(job).toBeDefined();
    expect(job).not.toHaveProperty('draft');
  });

  test('the worker completes the job and the public read hands back the generated draft', async () => {
    const h = workerHarness({
      rows: [row({ status: 'queued', stage: 'queued', input: jobInput('assignment-A') })],
      authorize: async (expected) => ({ assignment: expected ?? 'assignment-A', clientId: null }),
    });

    await h.service.runWorkerTick();

    expect(h.rows[0]!.status).toBe('completed');
    const job = await h.service.get(ctx, 'meeting-1');
    expect(job?.draft).toEqual(completedDraft);
  });

  test('readback is refused after the meeting moved to another assignment', async () => {
    const seen: Array<string | undefined> = [];
    const h = harness({
      rows: [
        row({
          status: 'completed',
          stage: 'completed',
          input: jobInput('assignment-A'),
          checkpoints: { draft: envelope(completedDraft) },
        }),
      ],
      authorize: async (_tx, _ctx, _meetingId, expected) => {
        seen.push(expected);
        if (expected && expected !== 'assignment-B')
          throw new ConflictException('Meeting assignment changed during preparation.');
        return { assignment: 'assignment-B', clientId: null };
      },
    });

    await expect(h.service.get(ctx, 'meeting-1')).rejects.toBeInstanceOf(ConflictException);
    // The recorded assignment was what the readback re-admitted against.
    expect(seen).toContain('assignment-A');
  });

  test('completion fails closed when access was revoked after generation', async () => {
    let calls = 0;
    let revoke = true;
    const h = workerHarness({
      rows: [row({ status: 'queued', stage: 'queued', input: jobInput('assignment-A') })],
      authorize: async (expected) => {
        calls += 1;
        // 1: actor admission, 2: the completion re-admission.
        if (revoke && calls >= 2)
          throw new ConflictException('Meeting assignment changed during preparation.');
        return { assignment: expected ?? 'assignment-A', clientId: null };
      },
    });

    await h.service.runWorkerTick();
    // The refusal happened during completion; the later read is a normal failure read.
    revoke = false;

    expect(h.rows[0]!.status).toBe('failed');
    expect(h.rows[0]!.errorCode).toBe('DEBRIEF_SCOPE_CHANGED');
    // Nothing was published for a job that no longer holds its assignment.
    expect(h.rows[0]!.checkpoints).toEqual({});
    const read = await h.service.get(ctx, 'meeting-1');
    expect(read?.status).toBe('failed');
    expect(read).not.toHaveProperty('draft');
  });
});
