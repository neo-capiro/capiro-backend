import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  IMPORT_JOB_PAGE_DEFAULT,
  IMPORT_JOB_PAGE_MAX,
  emptyPopulationCounts,
  importRequestSha256,
  toImportJobView,
  type FirmImportItemCode,
  type FirmImportItemOutcome,
  type FirmImportJobStatus,
  type ImportJobPopulationCounts,
  type ImportJobProjection,
  type ImportJobView,
} from './firm-import-job.contracts.js';

export const IMPORT_REQUEST_CONFLICT_CODE = 'IMPORT_REQUEST_CONFLICT';

export interface StartImportJobInput {
  requestKey: string;
  ldaRegistrantId: number;
  ids: readonly number[];
}

export interface ImportJobListOptions {
  limit?: number;
  cursor?: string;
  requestKey?: string;
  status?: FirmImportJobStatus;
}

export interface ImportJobListResult {
  jobs: ImportJobView[];
  nextCursor: string | null;
  population: ImportJobPopulationCounts;
}

const JOB_WITH_ITEMS = { items: true } as const;

/** Opaque, exact keyset cursor: (createdAt desc, id desc). */
export function encodeImportJobCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeImportJobCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    const createdAt = new Date(String(parsed.createdAt));
    if (
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.id) ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error('invalid cursor');
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException({ code: 'IMPORT_JOB_CURSOR_INVALID', message: 'Invalid cursor' });
  }
}

/**
 * Tenant-scoped persistence for the existing importer's durable job view.
 * Every read/write goes through withTenant so the tenant predicate is injected
 * and a foreign id resolves to "not found" rather than leaking.
 */
@Injectable()
export class FirmImportJobStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Same (tenant, requestKey) + same exact request reconciles the existing job;
   * a changed request conflicts instead of silently starting another import.
   */
  async createOrReconcile(
    ctx: TenantContext,
    input: StartImportJobInput,
  ): Promise<{ job: ImportJobView; created: boolean }> {
    const requestSha256 = importRequestSha256(input.ldaRegistrantId, input.ids);

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.firmImportJob.findFirst({
        where: { requestKey: input.requestKey },
        include: JOB_WITH_ITEMS,
      });
      if (existing) {
        this.assertSameRequest(existing.requestSha256, requestSha256);
        return { job: await this.toView(tx, existing.id), created: false };
      }

      try {
        const job = await tx.firmImportJob.create({
          data: {
            tenantId: ctx.tenantId,
            requestedByUserId: ctx.userId,
            requestKey: input.requestKey,
            requestSha256,
            ldaRegistrantId: input.ldaRegistrantId,
            requestedIds: [...input.ids],
            status: 'queued',
          },
          select: { id: true },
        });
        // Item identities are persisted BEFORE any client work.
        await tx.firmImportJobItem.createMany({
          data: input.ids.map((ldaClientId) => ({
            tenantId: ctx.tenantId,
            jobId: job.id,
            ldaClientId,
            outcome: 'pending' as const,
          })),
        });
        return { job: await this.toView(tx, job.id), created: true };
      } catch (error) {
        // Concurrent first writes of the same request: the unique key decides.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const raced = await tx.firmImportJob.findFirst({
            where: { requestKey: input.requestKey },
            select: { id: true, requestSha256: true },
          });
          if (raced) {
            this.assertSameRequest(raced.requestSha256, requestSha256);
            return { job: await this.toView(tx, raced.id), created: false };
          }
        }
        throw error;
      }
    });
  }

  async markRunning(ctx: TenantContext, jobId: string): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.firmImportJob.update({
        where: { id: jobId },
        data: { status: 'running', startedAt: new Date() },
      }),
    );
  }

  /**
   * Persist one item's terminal outcome. Called with the SAME transaction that
   * creates the canonical Client/mapping so a committed Client can never be
   * followed by a lost success record.
   */
  async markItemOutcome(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      jobId: string;
      ldaClientId: number;
      outcome: Exclude<FirmImportItemOutcome, 'pending'>;
      code?: FirmImportItemCode | null;
      clientId?: string | null;
    },
  ): Promise<void> {
    await tx.firmImportJobItem.update({
      where: {
        tenantId_jobId_ldaClientId: {
          tenantId: params.tenantId,
          jobId: params.jobId,
          ldaClientId: params.ldaClientId,
        },
      },
      data: {
        outcome: params.outcome,
        code: params.code ?? null,
        clientId: params.clientId ?? null,
        processedAt: new Date(),
      },
    });
    // Liveness for staleness: last update reflects real per-item progress.
    await tx.firmImportJob.update({ where: { id: params.jobId }, data: { updatedAt: new Date() } });
  }

  /** Write the projection's status; finishedAt only once the job is terminal. */
  async finalize(
    ctx: TenantContext,
    jobId: string,
    projection: ImportJobProjection,
  ): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.firmImportJob.update({
        where: { id: jobId },
        data: {
          status: projection.status,
          ...(projection.terminal ? { finishedAt: new Date() } : {}),
        },
      }),
    );
  }

  async getJob(ctx: TenantContext, jobId: string): Promise<ImportJobView> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.firmImportJob.findFirst({
        where: { id: jobId },
        include: JOB_WITH_ITEMS,
      });
      if (!row) throw new NotFoundException('Import job not found');
      return this.toView(tx, row.id);
    });
  }

  async getJobByRequest(ctx: TenantContext, requestKey: string): Promise<ImportJobView | null> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.firmImportJob.findFirst({
        where: { requestKey },
        include: JOB_WITH_ITEMS,
      });
      return row ? this.toView(tx, row.id) : null;
    });
  }

  async listJobs(
    ctx: TenantContext,
    options: ImportJobListOptions = {},
  ): Promise<ImportJobListResult> {
    const limit = Math.min(
      Math.max(options.limit ?? IMPORT_JOB_PAGE_DEFAULT, 1),
      IMPORT_JOB_PAGE_MAX,
    );
    const after = options.cursor ? decodeImportJobCursor(options.cursor) : null;
    const filters: Prisma.FirmImportJobWhereInput = {
      ...(options.requestKey ? { requestKey: options.requestKey } : {}),
      ...(options.status ? { status: options.status } : {}),
    };
    const pageWhere: Prisma.FirmImportJobWhereInput = after
      ? {
          ...filters,
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        }
      : filters;

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [rows, groups, populationTotal] = await Promise.all([
        tx.firmImportJob.findMany({
          where: pageWhere,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          include: JOB_WITH_ITEMS,
        }),
        tx.firmImportJob.groupBy({ by: ['status'], where: filters, _count: { _all: true } }),
        tx.firmImportJob.count({ where: filters }),
      ]);

      const page = rows.slice(0, limit);
      const population = emptyPopulationCounts();
      population.total = populationTotal;
      for (const group of groups) population[group.status] = group._count._all;

      const clientIds = [
        ...new Set(
          page.flatMap((row) =>
            row.items.map((item) => item.clientId).filter((id): id is string => !!id),
          ),
        ),
      ];
      const clientNames = new Map<string, string>();
      if (clientIds.length > 0) {
        const clients = await tx.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, name: true },
        });
        for (const client of clients) clientNames.set(client.id, client.name);
      }

      const last = page[page.length - 1];
      const now = new Date();
      return {
        jobs: page.map((row) => toImportJobView(row, clientNames, now, population)),
        nextCursor:
          rows.length > limit && last ? encodeImportJobCursor(last.createdAt, last.id) : null,
        population,
      };
    });
  }

  private assertSameRequest(storedSha256: string, requestSha256: string): void {
    if (storedSha256 !== requestSha256) {
      throw new ConflictException({
        code: IMPORT_REQUEST_CONFLICT_CODE,
        message: 'This import request identity was already used for a different selection.',
      });
    }
  }

  private async toView(
    tx: Prisma.TransactionClient,
    jobId: string,
    population?: ImportJobPopulationCounts,
  ): Promise<ImportJobView> {
    const row = await tx.firmImportJob.findFirstOrThrow({
      where: { id: jobId },
      include: JOB_WITH_ITEMS,
    });
    const clientIds = [
      ...new Set(row.items.map((item) => item.clientId).filter((id): id is string => !!id)),
    ];
    const clientNames = new Map<string, string>();
    if (clientIds.length > 0) {
      const clients = await tx.client.findMany({
        where: { id: { in: clientIds } },
        select: { id: true, name: true },
      });
      for (const client of clients) clientNames.set(client.id, client.name);
    }
    return toImportJobView(row, clientNames, new Date(), population);
  }
}
