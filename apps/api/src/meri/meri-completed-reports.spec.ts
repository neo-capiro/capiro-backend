import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  completedReportPage,
  completedReportQuery,
  type CompletedReportSummary,
} from './meri-completed-reports.js';
import { MeriCompletedReportsController } from './meri-completed-reports.controller.js';
import { MeriResearchService } from './meri-research.service.js';

const ctx = { tenantId: 'tenant-test', userId: 'user-test', tenantSlug: 'test' } as TenantContext;
const secret = 'synthetic-read-only-report-continuation-key';
const now = Date.parse('2026-10-27T12:00:00.000Z');
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const date = new Date(now - 1000).toISOString();

function pageFixture(count = 63) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: id(count - i), createdAt: date }));
  const denied = new Set<string>(),
    calls: string[] = [];
  const read = jest.fn(async (recordId: string): Promise<CompletedReportSummary | null> => {
    calls.push(recordId);
    return denied.has(recordId)
      ? null
      : {
          id: recordId,
          artifactId: id(1000),
          title: 'Retained report',
          kind: 'research',
          clientId: null,
          createdAt: date,
          updatedAt: date,
        };
  });
  const candidates = jest.fn(
    async ({ after, take }: { after: { id: string } | null; take: number }) =>
      rows.filter((row) => after === null || row.id < after.id).slice(0, take),
  );
  const page = (query: ReturnType<typeof completedReportQuery>, overrides = {}) =>
    completedReportPage({
      ctx,
      query,
      secret,
      now: () => now,
      candidates,
      read,
      ...overrides,
    });
  return { rows, denied, calls, read, candidates, page };
}

describe('completed legacy report continuation', () => {
  it('returns every authorized original identity beyond the old fifty-row cap with bounded work', async () => {
    const f = pageFixture(),
      found: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await f.page(
        completedReportQuery({ limit: '10', ...(cursor ? { cursor } : {}) }),
      );
      found.push(...result.reports.map((row) => row.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(f.rows.map((row) => row.id));
    expect(f.candidates).toHaveBeenCalledTimes(7);
    expect(f.candidates.mock.calls.every(([q]) => q.take === 11)).toBe(true);
    expect(f.calls).toHaveLength(126);
  });

  it('continues after an entirely denied candidate page without exposing hidden IDs or totals', async () => {
    const f = pageFixture(12);
    f.rows.slice(0, 10).forEach((row) => f.denied.add(row.id));
    const first = await f.page(completedReportQuery({ limit: '10' }));
    expect(first.reports).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const raw = Buffer.from(first.nextCursor!, 'base64url').toString('utf8');
    expect(raw).not.toContain(f.rows[9]!.id);
    expect(Object.keys(first).sort()).toEqual(['nextCursor', 'reports']);
    const second = await f.page(completedReportQuery({ limit: '10', cursor: first.nextCursor }));
    expect(second.reports.map((row) => row.id)).toEqual(f.rows.slice(10).map((row) => row.id));
    expect(second.nextCursor).toBeNull();
  });

  it('refuses tampering, cross-actor/client/query reuse and expired continuation without reading candidates', async () => {
    const f = pageFixture(12),
      first = await f.page(completedReportQuery({ limit: '10' }));
    const cursor = first.nextCursor!;
    f.candidates.mockClear();
    await expect(f.page(completedReportQuery({ cursor, limit: '9' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      f.page(completedReportQuery({ cursor, limit: '10', clientId: 'general' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.page(completedReportQuery({ cursor, limit: '10' }), { ctx: { ...ctx, userId: 'other' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.page(completedReportQuery({ cursor, limit: '10' }), { now: () => now + 3600001 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const tampered = Buffer.from(cursor, 'base64url');
    tampered[30] = tampered[30]! ^ 1;
    await expect(
      f.page(completedReportQuery({ cursor: tampered.toString('base64url'), limit: '10' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.candidates).not.toHaveBeenCalled();
  });

  it('checks current access again before release and propagates unknown backend failure', async () => {
    const f = pageFixture(1);
    f.read
      .mockResolvedValueOnce({ id: id(1) } as CompletedReportSummary)
      .mockResolvedValueOnce(null);
    expect((await f.page(completedReportQuery({}))).reports).toEqual([]);
    f.read.mockRejectedValueOnce(new Error('backend unavailable'));
    await expect(f.page(completedReportQuery({}))).rejects.toThrow('backend unavailable');
  });

  it('requires configured continuation encryption and refuses unsupported query fields', async () => {
    const f = pageFixture(12);
    await expect(f.page(completedReportQuery({}), { secret: undefined })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    for (const query of [
      { limit: '0' },
      { limit: '26' },
      { clientId: 'not-a-client' },
      { limit: ['10'] },
      { execute: 'true' },
    ])
      expect(() => completedReportQuery(query)).toThrow(BadRequestException);
  });
});

function ownerFixture() {
  const session = {
    id: id(1),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null as string | null,
    status: 'complete',
    kind: 'deliverable',
    reportArtifactId: id(1000),
    metadata: {},
    createdAt: new Date(date),
    updatedAt: new Date(date),
  };
  const artifact = {
    title: 'Original report',
    bodyText: 'Original retained report body',
    metadata: {},
    kind: 'research_report',
  };
  const sourceCheck = jest.fn(async () => undefined),
    forbiddenWrite = jest.fn(() => {
      throw Error('write invoked');
    });
  const sessionRead = jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
    where.id === session.id && where.tenantId === ctx.tenantId && where.userId === ctx.userId
      ? session
      : null,
  );
  const wall = jest.fn(async () => [{ allowed: true }]);
  const tx = {
    $queryRawUnsafe: wall,
    clioResearchSession: {
      findFirst: sessionRead,
      findMany: jest.fn(async () => [{ id: session.id, createdAt: session.createdAt }]),
      update: forbiddenWrite,
      create: forbiddenWrite,
    },
    clioArtifact: { findFirst: jest.fn(async () => artifact), update: forbiddenWrite },
  };
  const service = Object.assign(Object.create(MeriResearchService.prototype) as object, {
    prisma: {
      withTenant: async (_tenant: string, body: (value: typeof tx) => unknown) => body(tx),
      withTenantUser: async (_tenant: string, _user: string, body: (value: typeof tx) => unknown) =>
        body(tx),
    },
    config: { get: () => secret },
    assertReplayedReportSourcesAuthorized: sourceCheck,
    settleJobApprovals: forbiddenWrite,
    createSession: forbiddenWrite,
    streamResearch: forbiddenWrite,
  }) as unknown as MeriResearchService;
  return { service, session, artifact, sourceCheck, forbiddenWrite, sessionRead, tx, wall };
}

describe('existing Core completed-report owner', () => {
  it('reads exact saved text and identities through real ensureSession/getReportMarkdown without settlement or generation', async () => {
    const f = ownerFixture(),
      controller = new MeriCompletedReportsController(f.service);
    const result = await controller.read(ctx, id(1));
    expect(result).toMatchObject({
      id: id(1),
      artifactId: id(1000),
      markdown: f.artifact.bodyText,
      kind: 'deliverable',
    });
    expect(f.sourceCheck).toHaveBeenCalledWith(ctx, id(1), null, null, {
      reportArtifactId: id(1000),
    });
    expect(f.sessionRead).toHaveBeenCalledTimes(3);
    expect(f.forbiddenWrite).not.toHaveBeenCalled();
    const page = await controller.list(ctx, {});
    expect(page.reports).toHaveLength(1);
    expect(page.reports[0]).not.toHaveProperty('markdown');
    expect(f.forbiddenWrite).not.toHaveBeenCalled();
    for (const action of ['list', 'read'] as const)
      expect(Reflect.getMetadata(METHOD_METADATA, controller[action])).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, MeriCompletedReportsController)).toBe(
      'clio/completed-reports',
    );
  });

  it('requires completed output and refuses held reports, wrong actor and current source revocation', async () => {
    const f = ownerFixture();
    f.session.status = 'researching';
    await expect(f.service.readCompletedReport(ctx, id(1))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.sourceCheck).not.toHaveBeenCalled();
    f.session.status = 'complete';
    f.artifact.metadata = { heldForReview: true };
    await expect(f.service.readCompletedReport(ctx, id(1))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    f.artifact.metadata = {};
    await expect(
      f.service.readCompletedReport({ ...ctx, userId: 'other' }, id(1)),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.sourceCheck.mockRejectedValueOnce(
      new ConflictException('A research source is no longer authorized.'),
    );
    await expect(f.service.readCompletedReport(ctx, id(1))).rejects.toBeInstanceOf(
      ConflictException,
    );
    f.sourceCheck.mockRejectedValueOnce(
      new ConflictException('A research source is no longer authorized.'),
    );
    expect((await f.service.readCompletedReports(ctx, completedReportQuery({}))).reports).toEqual(
      [],
    );
    f.sourceCheck.mockRejectedValueOnce(new Error('unknown database failure'));
    await expect(f.service.readCompletedReports(ctx, completedReportQuery({}))).rejects.toThrow(
      'unknown database failure',
    );
    expect(f.forbiddenWrite).not.toHaveBeenCalled();
  });

  it('refuses report replacement while source authorization is in flight', async () => {
    const f = ownerFixture();
    f.sourceCheck.mockImplementationOnce(async () => {
      f.session.reportArtifactId = id(1001);
    });
    await expect(f.service.readCompletedReport(ctx, id(1))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('preserves the existing current client-wall predicate and exact selected-client filtering', async () => {
    const f = ownerFixture();
    f.session.clientId = id(10);
    expect((await f.service.readCompletedReport(ctx, id(1))).clientId).toBe(id(10));
    expect(f.wall).toHaveBeenCalledWith(expect.any(String), ctx.tenantId, id(10), ctx.userId);
    f.wall.mockResolvedValueOnce([{ allowed: false }]);
    await expect(f.service.readCompletedReport(ctx, id(1))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      (await f.service.readCompletedReports(ctx, completedReportQuery({ clientId: id(11) })))
        .reports,
    ).toEqual([]);
    expect(f.forbiddenWrite).not.toHaveBeenCalled();
  });
});
