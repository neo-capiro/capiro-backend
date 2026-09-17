import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DraftJobService } from './draft-job.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import type { DraftStrategyDto } from './dto/meri.dto.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const CTX: AuthTenantContext = {
  tenantId: 'tenant-1',
  clerkUserId: 'user-1',
  tenantSlug: 'acme',
  role: 'standard_user',
} as AuthTenantContext;

type JobRow = Record<string, unknown>;

/** A jest.fn() typed to take one Prisma-style args object and resolve T —
 *  plain `jest.fn()` infers a `never` parameter under this repo's ts-jest
 *  config, which then rejects any .mockResolvedValue/.mockRejectedValue
 *  argument (see meri.service.spec.ts's `jest.fn<() => Promise<...>>()` for
 *  the same pattern). Typed with one arg (not zero) so `.mock.calls[n]![0]`
 *  — used below to inspect what each call was made with — indexes into a
 *  real tuple slot instead of an empty one. */
function dbMock<T>() {
  return jest.fn<(args: unknown) => Promise<T>>();
}

function dto(overrides: Partial<DraftStrategyDto> = {}): DraftStrategyDto {
  return {
    clientId: CLIENT,
    type: 'appropriations',
    goal: 'Protect the program',
    ...overrides,
  } as DraftStrategyDto;
}

/** A minimal `tx` covering only what DraftJobService touches. `$queryRaw` is
 *  invoked as a tagged template (`tx.$queryRaw\`...\``); a plain jest.fn mock
 *  works identically either way since JS just calls fn(strings, ...values). */
function makeTx(opts: {
  clientRows?: Array<{ ok: number }>;
  findUnique: ReturnType<typeof dbMock<JobRow | null>>;
  create: ReturnType<typeof dbMock<JobRow>>;
  findFirst?: ReturnType<typeof dbMock<JobRow | null>>;
}) {
  const queryRaw = dbMock<Array<{ ok: number }>>();
  queryRaw.mockResolvedValue(opts.clientRows ?? [{ ok: 1 }]);
  return {
    $queryRaw: queryRaw,
    spDraftJob: {
      findUnique: opts.findUnique,
      create: opts.create,
      findFirst: opts.findFirst ?? dbMock<JobRow | null>(),
    },
  };
}

function service(tx: ReturnType<typeof makeTx>) {
  const prisma = {
    withTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { svc: new DraftJobService(prisma), prisma };
}

describe('DraftJobService.submit', () => {
  it('rejects an unknown client before ever touching sp_draft_job', async () => {
    const findUnique = dbMock<JobRow | null>();
    const create = dbMock<JobRow>();
    const tx = makeTx({ clientRows: [], findUnique, create });
    const { svc } = service(tx);

    await expect(svc.submit(CTX, 'token', dto())).rejects.toBeInstanceOf(BadRequestException);
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a new queued job with a deadline and stores the caller bearer', async () => {
    const findUnique = dbMock<JobRow | null>();
    findUnique.mockResolvedValue(null);
    const created: JobRow = { id: 'job-1', status: 'queued' };
    const create = dbMock<JobRow>();
    create.mockResolvedValue(created);
    const tx = makeTx({ findUnique, create });
    const { svc } = service(tx);

    const result = await svc.submit(CTX, 'token-abc', dto());

    expect(result).toEqual({ jobId: 'job-1', status: 'queued' });
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.tenantId).toBe('tenant-1');
    expect(args.data.clientId).toBe(CLIENT);
    expect(args.data.ownerUserId).toBe('user-1');
    expect(args.data.status).toBe('queued');
    expect(args.data.deadlineAt).toBeInstanceOf(Date);
    expect((args.data.deadlineAt as Date).getTime()).toBeGreaterThan(Date.now());
    const input = args.data.input as { dto: DraftStrategyDto; bearer: string | null };
    expect(input.bearer).toBe('token-abc');
    expect(input.dto.clientId).toBe(CLIENT);
  });

  it('a double-submit with the identical input returns the SAME job (no second create)', async () => {
    const existing: JobRow = { id: 'job-1', status: 'running' };
    const findUnique = dbMock<JobRow | null>();
    findUnique.mockResolvedValue(existing);
    const create = dbMock<JobRow>();
    const tx = makeTx({ findUnique, create });
    const { svc } = service(tx);

    const first = await svc.submit(CTX, 'token', dto());
    const second = await svc.submit(CTX, 'token', dto());

    expect(first).toEqual({ jobId: 'job-1', status: 'running' });
    expect(second).toEqual({ jobId: 'job-1', status: 'running' });
    expect(create).not.toHaveBeenCalled();
    // Both submissions must hash to the identical requestKey for the unique
    // index to actually dedupe them — assert the two lookups used the same key.
    const key1 = (findUnique.mock.calls[0]![0] as { where: { tenantId_requestKey: { requestKey: string } } })
      .where.tenantId_requestKey.requestKey;
    const key2 = (findUnique.mock.calls[1]![0] as { where: { tenantId_requestKey: { requestKey: string } } })
      .where.tenantId_requestKey.requestKey;
    expect(key1).toBe(key2);
  });

  it('a concurrent create race (P2002) refetches and returns the winner instead of throwing', async () => {
    const winner: JobRow = { id: 'job-1', status: 'queued' };
    const findUnique = dbMock<JobRow | null>();
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    const create = dbMock<JobRow>();
    create.mockRejectedValue({ code: 'P2002' });
    const tx = makeTx({ findUnique, create });
    const { svc } = service(tx);

    const result = await svc.submit(CTX, 'token', dto());

    expect(result).toEqual({ jobId: 'job-1', status: 'queued' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-P2002 create failure', async () => {
    const findUnique = dbMock<JobRow | null>();
    findUnique.mockResolvedValue(null);
    const create = dbMock<JobRow>();
    create.mockRejectedValue(new Error('db down'));
    const tx = makeTx({ findUnique, create });
    const { svc } = service(tx);

    await expect(svc.submit(CTX, 'token', dto())).rejects.toThrow('db down');
  });

  it('a different goal produces a different requestKey (not conflated with the first draft)', async () => {
    const findUnique = dbMock<JobRow | null>();
    findUnique.mockResolvedValue(null);
    const create = dbMock<JobRow>();
    create.mockResolvedValue({ id: 'job-x', status: 'queued' });
    const tx = makeTx({ findUnique, create });
    const { svc } = service(tx);

    await svc.submit(CTX, 'token', dto({ goal: 'Goal A' }));
    await svc.submit(CTX, 'token', dto({ goal: 'Goal B' }));

    const key1 = (findUnique.mock.calls[0]![0] as { where: { tenantId_requestKey: { requestKey: string } } })
      .where.tenantId_requestKey.requestKey;
    const key2 = (findUnique.mock.calls[1]![0] as { where: { tenantId_requestKey: { requestKey: string } } })
      .where.tenantId_requestKey.requestKey;
    expect(key1).not.toBe(key2);
  });
});

describe('DraftJobService.get', () => {
  it('404s when the job does not exist (or belongs to another tenant)', async () => {
    const findFirst = dbMock<JobRow | null>();
    findFirst.mockResolvedValue(null);
    const tx = makeTx({ findUnique: dbMock<JobRow | null>(), create: dbMock<JobRow>(), findFirst });
    const { svc } = service(tx);

    await expect(svc.get(CTX, 'missing-job')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the public job shape without leaking input/bearer/ownerUserId/claimedBy', async () => {
    const now = new Date();
    const job: JobRow = {
      id: 'job-1',
      tenantId: 'tenant-1',
      clientId: CLIENT,
      ownerUserId: 'user-1',
      requestKey: 'hash',
      input: { dto: dto(), bearer: 'super-secret-token' },
      status: 'running',
      stage: 'drafting',
      progressText: 'Drafting the plan',
      streamPreview: 'partial text so far',
      attempt: 1,
      strategyId: null,
      errorMessage: null,
      claimedBy: 'worker-abc',
      claimedAt: now,
      deadlineAt: new Date(now.getTime() + 1000),
      createdAt: now,
      updatedAt: now,
    };
    const findFirst = dbMock<JobRow | null>();
    findFirst.mockResolvedValue(job);
    const tx = makeTx({ findUnique: dbMock<JobRow | null>(), create: dbMock<JobRow>(), findFirst });
    const { svc } = service(tx);

    const result = await svc.get(CTX, 'job-1');

    expect(result).toEqual({
      jobId: 'job-1',
      status: 'running',
      stage: 'drafting',
      progressText: 'Drafting the plan',
      streamPreview: 'partial text so far',
      strategyId: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(result).not.toHaveProperty('input');
    expect(result).not.toHaveProperty('bearer');
    expect(result).not.toHaveProperty('ownerUserId');
    expect(result).not.toHaveProperty('claimedBy');
  });
});
