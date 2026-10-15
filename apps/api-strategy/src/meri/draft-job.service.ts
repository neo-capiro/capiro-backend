import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { withContextRetry } from './context-load.js';
import { STRATEGY_CONTEXT_RETRY, type ContextRetryRuntime } from './strategy-time.providers.js';
import type { DraftStrategyDto } from './dto/meri.dto.js';
import { admitObjective } from './objective-generation-admission.js';
import { digest, parseObjectiveDraft, pendingReceipt, requestConflict, requestKey } from './objective-generation.types.js';
import {
  computeDraftRequestKey,
  toPublicDraftJob,
  type DraftJobInput,
  type PublicDraftJob,
} from './draft-job.types.js';

/** Generous budget for the WORST case orchestrator repair loop (up to ~3
 *  attempts x up to 8 rounds x 120s, plus retries) — this is a background
 *  ceiling, not a UX target; DraftJobWorkerService streams progress well
 *  before this is ever approached. */
const DEFAULT_DEADLINE_MS = Number.parseInt(
  process.env.STRATEGY_DRAFT_JOB_DEADLINE_MS ?? '',
  10,
) || 45 * 60 * 1000;

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/**
 * POST /strategies/draft used to run the ENTIRE orchestrator draft (context
 * compile, grounding fan-out, the model's own repair/retry loop, verify,
 * persist) inline on the HTTP request — a shape with no safe fixed timeout
 * (the orchestrator's own loop can legitimately take many minutes). This
 * service does only what the request path can safely do fast: validate
 * exactly what the old synchronous handler validated up front, then enqueue an
 * SpDraftJob for DraftJobWorkerService's claim-sweep to run off the request
 * path. See MeriService.draft()'s jobRuntime parameter for where the
 * relocated generation logic actually lives.
 */
@Injectable()
export class DraftJobService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRATEGY_CONTEXT_RETRY) private readonly retryRuntime: ContextRetryRuntime,
  ) {}

  /** Explicit actor+request identity, distinct from the generic content key. */
  async submitObjective(ctx: AuthTenantContext, body: unknown) {
    const request = parseObjectiveDraft(body);
    const key = requestKey(ctx.tenantId, ctx.clerkUserId, request.requestId);
    const fingerprint = digest(request);
    const create = () => this.prisma.withTenant(ctx.tenantId, async tx => {
      const admitted = await admitObjective(tx, ctx, request);
      const existing = await tx.spDraftJob.findUnique({ where: { tenantId_requestKey: { tenantId: ctx.tenantId, requestKey: key } } });
      if (existing) {
        const old = (existing.input as unknown as DraftJobInput).objectiveGeneration;
        if (!old || existing.ownerUserId !== ctx.clerkUserId || old.fingerprint !== fingerprint ||
            digest(old.receipt.source) !== digest(admitted.source)) requestConflict();
        return existing;
      }
      const input: DraftJobInput = { bearer: null,
        dto: { clientId: request.clientId, type: request.type, goal: admitted.intent.outcome },
        objectiveGeneration: { request, fingerprint, receipt: pendingReceipt(request, admitted.source) } };
      return tx.spDraftJob.create({ data: { tenantId: ctx.tenantId, clientId: request.clientId, ownerUserId: ctx.clerkUserId,
        requestKey: key, input: json(input), status: 'queued', deadlineAt: new Date(Date.now() + DEFAULT_DEADLINE_MS) } });
    });
    let job;
    try { job = await create(); } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      job = await create();
    }
    const view = toPublicDraftJob(job);
    return { jobId: view.jobId, status: view.status, objectiveGeneration: view.objectiveGeneration! };
  }

  /**
   * Enqueues a draft job (or returns the existing one for the same input).
   * requestKey (a hash of the fields that define what would be generated) +
   * the (tenantId, requestKey) unique index make a double-submit — a dropped
   * response the client retries, a double-click — resolve to the SAME job
   * instead of starting a second generation: create, catch the unique-key
   * race (P2002), refetch. A pre-check alone is not enough (two concurrent
   * submissions can both pass it), so both layers are needed.
   */
  async submit(
    ctx: AuthTenantContext,
    bearer: string | undefined,
    dto: DraftStrategyDto,
  ): Promise<{ jobId: string; status: string }> {
    // Same check MeriService.draft() has always run first: capiro_app is NOT
    // RLS-bypass on `clients`, so this must run inside withTenant (sets
    // app.current_tenant) or the clients RLS false-negatives every valid
    // client. Kept here (in addition to the worker re-running it) so an
    // unknown client 400s immediately instead of only surfacing as a failed
    // job minutes later.
    const clientRows = await withContextRetry('client-existence', () =>
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM clients WHERE id = ${dto.clientId}::uuid AND tenant_id = ${ctx.tenantId}::uuid LIMIT 1`,
      ),
      this.retryRuntime,
    );
    if (clientRows.length === 0) {
      throw new BadRequestException('Unknown client for this tenant');
    }

    const requestKey = computeDraftRequestKey(dto);
    const input: DraftJobInput = { dto, bearer: bearer ?? null };
    const deadlineAt = new Date(Date.now() + DEFAULT_DEADLINE_MS);

    const create = () =>
      this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const existing = await tx.spDraftJob.findUnique({
          where: { tenantId_requestKey: { tenantId: ctx.tenantId, requestKey } },
        });
        if (existing) return existing;
        return tx.spDraftJob.create({
          data: {
            tenantId: ctx.tenantId,
            clientId: dto.clientId,
            ownerUserId: ctx.clerkUserId,
            requestKey,
            input: json(input),
            status: 'queued',
            deadlineAt,
          },
        });
      });

    let job;
    try {
      job = await create();
    } catch (err) {
      // A concurrent idempotent submission can win the unique key race.
      if ((err as { code?: string }).code === 'P2002') job = await create();
      else throw err;
    }
    return { jobId: job.id, status: job.status };
  }

  /**
   * GET /strategies/draft-jobs/:jobId. Tenant-scoped (withTenant injects
   * where.tenantId): a job id from another tenant reads as 404, never
   * distinguished from "unknown id" — same posture as every other cross-tenant
   * lookup in this service.
   */
  async get(ctx: AuthTenantContext, jobId: string): Promise<PublicDraftJob> {
    const job = await this.prisma.withTenant(ctx.tenantId, async tx => {
      const row = await tx.spDraftJob.findFirst({ where: { id: jobId, tenantId: ctx.tenantId } });
      const objective = (row?.input as unknown as DraftJobInput | undefined)?.objectiveGeneration;
      if (row && objective) {
        if (row.ownerUserId !== ctx.clerkUserId || row.clientId !== objective.receipt.source.clientId) throw new NotFoundException('Draft job not found');
        const admitted = await admitObjective(tx, ctx, objective.request);
        if (digest(admitted.source) !== digest(objective.receipt.source)) throw new NotFoundException('Draft job not found');
      }
      return row;
    });
    if (!job) throw new NotFoundException('Draft job not found');
    return toPublicDraftJob(job);
  }
}
