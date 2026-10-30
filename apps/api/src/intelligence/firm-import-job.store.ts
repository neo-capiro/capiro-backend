import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { requireOwnerActor } from '../clients/client-ordered-owner.access.js';
import { fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  IMPORT_JOB_PAGE_DEFAULT,
  IMPORT_JOB_PAGE_MAX,
  emptyPopulationCounts,
  importRequestSha256,
  projectImportJob,
  toImportJobView,
  type FirmImportItemCode,
  type FirmImportItemOutcome,
  type FirmImportJobStatus,
  type ImportJobPopulationCounts,
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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

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
 *
 * Two invariants keep this safe on a connection that bypasses Postgres RLS:
 *  - every read first proves the CURRENT actor membership/identity and applies
 *    the canonical ethical-wall decision, before any client id/name or count is
 *    returned (a job with an inaccessible client outcome is wholly inaccessible);
 *  - an item outcome and the job projection it changes are written in the SAME
 *    transaction, so list filter, population counts and detail share one
 *    item-derived status with no post-commit finalize gap.
 */
@Injectable()
export class FirmImportJobStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Same (tenant, requestKey) + same exact request reconciles the existing job;
   * a changed request conflicts instead of silently starting another import.
   *
   * A concurrent first writer can only surface as a unique violation. PostgreSQL
   * aborts that transaction, so reconciliation of the winner happens in a NEW
   * tenant transaction, never by querying the aborted one.
   */
  async createOrReconcile(
    ctx: TenantContext,
    input: StartImportJobInput,
  ): Promise<{ job: ImportJobView; created: boolean }> {
    const requestSha256 = importRequestSha256(input.ldaRegistrantId, input.ids);

    try {
      return await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const denied = await this.authorize(tx, ctx);
        const existing = await tx.firmImportJob.findFirst({
          where: { requestKey: input.requestKey },
          select: { id: true, requestSha256: true },
        });
        if (existing) return this.reconcile(tx, existing, requestSha256, denied);

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
        return { job: await this.toView(tx, job.id, denied), created: true };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The creating transaction is aborted. Resolve the winner afresh.
      return this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const denied = await this.authorize(tx, ctx);
        const winner = await tx.firmImportJob.findFirst({
          where: { requestKey: input.requestKey },
          select: { id: true, requestSha256: true },
        });
        if (!winner) throw error;
        return this.reconcile(tx, winner, requestSha256, denied);
      });
    }
  }

  async markRunning(ctx: TenantContext, jobId: string): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.authorize(tx, ctx);
      await tx.firmImportJob.update({
        where: { id: jobId },
        data: { status: 'running', startedAt: new Date() },
      });
    });
  }

  /**
   * Persist one item's terminal outcome. Called with the SAME transaction that
   * creates the canonical Client/mapping and, in that same transaction, rewrites
   * the job projection (status/finishedAt) from the item rows. A committed
   * outcome therefore never leaves a stale queued/running status behind, and no
   * separate finalize step exists.
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

    const row = await tx.firmImportJob.findFirstOrThrow({
      where: { id: params.jobId },
      include: JOB_WITH_ITEMS,
    });
    const now = new Date();
    const projection = projectImportJob(
      { status: row.status, updatedAt: row.updatedAt, items: row.items },
      now,
    );
    await tx.firmImportJob.update({
      where: { id: params.jobId },
      data: {
        status: projection.status,
        updatedAt: now,
        ...(projection.terminal ? { finishedAt: row.finishedAt ?? now } : {}),
      },
    });
  }

  async getJob(ctx: TenantContext, jobId: string): Promise<ImportJobView> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const denied = await this.authorize(tx, ctx);
      const row = await tx.firmImportJob.findFirst({
        where: { id: jobId },
        select: { id: true },
      });
      if (!row) throw new NotFoundException('Import job not found');
      return this.toView(tx, row.id, denied);
    });
  }

  async getJobByRequest(ctx: TenantContext, requestKey: string): Promise<ImportJobView | null> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const denied = await this.authorize(tx, ctx);
      const row = await tx.firmImportJob.findFirst({
        where: { requestKey },
        select: { id: true },
      });
      if (!row) return null;
      if (await this.isHidden(tx, row.id, denied)) return null;
      return this.toView(tx, row.id, denied);
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

    // One snapshot for page, filter, counts and names.
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        const denied = await this.authorize(tx, ctx);
        // Whole-record visibility applies to the filter, the page and the
        // full-population counts; hidden jobs are absent from all three.
        const filters: Prisma.FirmImportJobWhereInput = {
          ...(options.requestKey ? { requestKey: options.requestKey } : {}),
          ...(options.status ? { status: options.status } : {}),
          ...(denied.size > 0 ? { items: { none: { clientId: { in: [...denied] } } } } : {}),
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
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  /** Current actor membership/identity, then the canonical ethical-wall decision. */
  private async authorize(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
  ): Promise<ReadonlySet<string>> {
    await requireOwnerActor(tx, ctx, false);
    return new Set(await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId));
  }

  private async isHidden(
    tx: Prisma.TransactionClient,
    jobId: string,
    denied: ReadonlySet<string>,
  ): Promise<boolean> {
    if (denied.size === 0) return false;
    const hit = await tx.firmImportJobItem.findFirst({
      where: { jobId, clientId: { in: [...denied] } },
      select: { id: true },
    });
    return hit !== null;
  }

  private async reconcile(
    tx: Prisma.TransactionClient,
    existing: { id: string; requestSha256: string },
    requestSha256: string,
    denied: ReadonlySet<string>,
  ): Promise<{ job: ImportJobView; created: boolean }> {
    // Visibility BEFORE the hash decision: a hidden record must not reveal its
    // existence through a 409 or through returned job data.
    const job = await this.toView(tx, existing.id, denied);
    this.assertSameRequest(existing.requestSha256, requestSha256);
    return { job, created: false };
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
    denied: ReadonlySet<string>,
  ): Promise<ImportJobView> {
    const row = await tx.firmImportJob.findFirstOrThrow({
      where: { id: jobId },
      include: JOB_WITH_ITEMS,
    });
    // Conservative whole-record convention: any inaccessible client outcome
    // makes the entire job inaccessible.
    for (const item of row.items) {
      if (item.clientId && denied.has(item.clientId)) {
        throw new NotFoundException('Import job not found');
      }
    }
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
    return toImportJobView(row, clientNames, new Date());
  }
}
