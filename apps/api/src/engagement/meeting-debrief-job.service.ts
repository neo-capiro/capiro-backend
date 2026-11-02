import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, MeetingDebriefJob } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from './engagement.service.js';
import { ClientAssociationService } from './client-association.service.js';
import { MeetingNotesCryptoService } from './meeting-notes-crypto.service.js';
import { MeetingPrepJobService } from './meeting-prep-job.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import { MEETING_DEBRIEF_POLICY as POLICY, meetingDebriefJobEnabled } from './meeting-prep-policy.js';

/** D1: the only input the debrief job accepts; the source is encrypted at rest. */
interface JobInput {
  method: 'upload' | 'manual' | 'voice';
  sourceText: string;
  /** Assignment digest; a changed meeting assignment fails the job rather than guessing. */
  assignment: string;
}

/** Stage vocabulary the frontend polls. Documented in the handoff. */
export const MEETING_DEBRIEF_STAGES = [
  'queued',
  'assembling',
  'generating',
  'recording',
  'completed',
  'failed',
  'cancelled',
] as const;
export type MeetingDebriefStage = (typeof MEETING_DEBRIEF_STAGES)[number];

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/**
 * D1: debrief generation as a job, mirroring MeetingPrepJobService (same table shape,
 * lease, deadline, attempts and requestKey idempotency) with no new queue, broker,
 * scheduler framework or worker process.
 */
@Injectable()
export class MeetingDebriefJobService {
  private readonly logger = new Logger(MeetingDebriefJobService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    private readonly crypto: MeetingNotesCryptoService,
    private readonly runtime: EngagementRuntimePolicyService,
    private readonly prepJobs: MeetingPrepJobService,
    @Optional() private readonly associations?: ClientAssociationService,
  ) {}

  async submit(
    ctx: TenantContext,
    meetingId: string,
    input: {
      method: 'upload' | 'manual' | 'voice';
      sourceText: string;
      requestKey?: string;
    },
  ) {
    this.runtime.assertExternalAction('meeting_debrief_generate');
    if (!meetingDebriefJobEnabled())
      throw new ServiceUnavailableException('Asynchronous debrief generation is not enabled.');
    if (!['upload', 'manual', 'voice'].includes(input.method))
      throw new BadRequestException('Invalid debrief source method.');
    const sourceText = (input.sourceText ?? '').trim();
    if (!sourceText) throw new BadRequestException('sourceText is required');
    const requestKey = input.requestKey ?? randomUUID();
    if (!/^[\w-]{8,128}$/.test(requestKey)) throw new BadRequestException('Invalid request key.');
    // Only the source identity is hashed: the same key with a different transcript is a
    // conflict, and a retry of the same request returns the same job.
    const requestHash = digest({
      meetingId,
      method: input.method,
      sourceTextHash: createHash('sha256').update(sourceText).digest('hex'),
      policy: POLICY.version,
    });
    const create = () =>
      this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const { assignment } = await this.prepJobs.authorizeJobMeeting(tx, ctx, meetingId);
        const existing = await tx.meetingDebriefJob.findUnique({
          where: {
            tenantId_userId_requestKey: {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              requestKey,
            },
          },
        });
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new ConflictException(
              'This request key was already used for a different debrief request.',
            );
          // Same stored-result admission as the read path: a replay must not project a
          // draft that belongs to an assignment the meeting no longer holds.
          await this.assertRecordedAssignment(tx, ctx, existing);
          return this.publicJob(existing);
        }
        const job = await tx.meetingDebriefJob.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            meetingId,
            requestKey,
            requestHash,
            deadlineAt: new Date(Date.now() + POLICY.deadlineMs),
            input: json(
              this.crypto.encrypt(
                JSON.stringify({ method: input.method, sourceText, assignment } satisfies JobInput),
              ),
            ),
          },
        });
        return this.publicJob(job);
      });
    try {
      return await create();
    } catch (error) {
      // A concurrent idempotent submission can win the unique key race.
      if ((error as { code?: string }).code === 'P2002') return create();
      throw error;
    }
  }

  async get(ctx: TenantContext, meetingId: string, jobId?: string) {
    if (!meetingDebriefJobEnabled()) return null;
    return this.readJob(ctx, meetingId, jobId);
  }

  private async readJob(ctx: TenantContext, meetingId: string, jobId?: string) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.prepJobs.authorizeJobMeeting(tx, ctx, meetingId);
      const job = await tx.meetingDebriefJob.findFirst({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          meetingId,
          ...(jobId ? { id: jobId } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!job && jobId) throw new NotFoundException('Debrief job not found.');
      if (!job) return null;
      // Stored job content belongs to the assignment it was assembled under. Re-admit
      // through the same job-meeting owner with that recorded assignment: a meeting
      // that moved to another client (or lost access) does not publish its draft.
      await this.assertRecordedAssignment(tx, ctx, job);
      return this.publicJob(job);
    });
  }

  async cancel(ctx: TenantContext, meetingId: string, jobId: string) {
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.prepJobs.authorizeJobMeeting(tx, ctx, meetingId);
      await tx.meetingDebriefJob.updateMany({
        where: {
          id: jobId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          meetingId,
          status: { in: ['queued', 'running'] },
        },
        data: { status: 'cancelled', stage: 'cancelled', leaseToken: null, leaseUntil: null },
      });
    });
    // The committed write proved table access; return the persisted outcome.
    return this.readJob(ctx, meetingId, jobId);
  }

  async resume(ctx: TenantContext, meetingId: string, jobId: string) {
    this.runtime.assertExternalAction('meeting_debrief_generate');
    if (!meetingDebriefJobEnabled())
      throw new ServiceUnavailableException('Asynchronous debrief generation is not enabled.');
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const job = await tx.meetingDebriefJob.findFirst({
        where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId, meetingId },
      });
      if (!job) throw new NotFoundException('Debrief job not found.');
      const input = JSON.parse(
        this.crypto.decrypt(
          job.input as unknown as Parameters<MeetingNotesCryptoService['decrypt']>[0],
        ),
      ) as JobInput;
      await this.prepJobs.authorizeJobMeeting(tx, ctx, meetingId, input.assignment);
      if (job.deadlineAt.getTime() <= Date.now() || job.attempts >= POLICY.maxAttempts)
        throw new BadRequestException(
          'This debrief budget is exhausted. Start a new debrief run.',
        );
      await tx.meetingDebriefJob.updateMany({
        where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId, status: 'failed' },
        data: { status: 'queued', stage: 'queued', errorCode: null, leaseToken: null, leaseUntil: null },
      });
    });
    return this.get(ctx, meetingId, jobId);
  }

  /** Only the explicit background-owner module calls this system-level claim. */
  async runWorkerTick(): Promise<void> {
    if (!meetingDebriefJobEnabled()) return;
    this.runtime.assertMeetingDebriefWorker();
    this.runtime.assertExternalAction('meeting_debrief_generate');
    const now = new Date();
    const token = randomUUID();
    const job = await this.prisma.withSystem(async (tx) => {
      await tx.meetingDebriefJob.updateMany({
        where: {
          status: { in: ['queued', 'running'] },
          OR: [{ deadlineAt: { lte: now } }, { attempts: { gte: POLICY.maxAttempts }, leaseUntil: { lt: now } }],
        },
        data: {
          status: 'failed',
          stage: 'failed',
          errorCode: 'DEBRIEF_BUDGET_EXHAUSTED',
          leaseToken: null,
          leaseUntil: null,
        },
      });
      const candidate = await tx.meetingDebriefJob.findFirst({
        where: {
          deadlineAt: { gt: now },
          attempts: { lt: POLICY.maxAttempts },
          OR: [{ status: 'queued' }, { status: 'running', leaseUntil: { lt: now } }],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;
      const claimed = await tx.meetingDebriefJob.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          leaseToken: candidate.leaseToken,
          ...(candidate.status === 'running' ? { leaseUntil: { lt: now } } : {}),
        },
        data: {
          status: 'running',
          stage: 'assembling',
          leaseToken: token,
          leaseUntil: new Date(Date.now() + POLICY.leaseMs),
          attempts: { increment: 1 },
        },
      });
      return claimed.count === 1 ? candidate : null;
    });
    if (job) await this.process(job, token);
  }

  private async process(job: MeetingDebriefJob, token: string): Promise<void> {
    const abort = new AbortController();
    const deadline = setTimeout(
      () => abort.abort(new Error('meeting_debrief_deadline_exceeded')),
      Math.max(1, job.deadlineAt.getTime() - Date.now()),
    );
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.prisma
        .withTenantUser(job.tenantId, job.userId, async (tx) => {
          const renewed = await tx.meetingDebriefJob.updateMany({
            where: this.leaseWhere(job, token),
            data: { leaseUntil: new Date(Date.now() + POLICY.leaseMs) },
          });
          if (renewed.count !== 1) abort.abort(new Error('meeting_debrief_lease_lost'));
        })
        .catch(() => abort.abort(new Error('meeting_debrief_lease_unavailable')))
        .finally(() => {
          heartbeatBusy = false;
        });
    }, POLICY.heartbeatMs);
    heartbeat.unref?.();
    try {
      const input = JSON.parse(
        this.crypto.decrypt(
          job.input as unknown as Parameters<MeetingNotesCryptoService['decrypt']>[0],
        ),
      ) as JobInput;
      const ctx = await this.prisma.withTenantUser(job.tenantId, job.userId, async (tx) => {
        const membership = await tx.tenantMembership.findFirst({
          where: { tenantId: job.tenantId, userId: job.userId, status: 'active' },
          include: { user: true, tenant: true },
        });
        if (!membership) throw new Error('meeting_debrief_access_revoked');
        const actor: TenantContext = {
          tenantId: job.tenantId,
          userId: job.userId,
          tenantSlug: membership.tenant.slug,
          clerkUserId: membership.user.clerkUserId,
          role: membership.role,
        };
        await this.prepJobs.authorizeJobMeeting(tx, actor, job.meetingId, input.assignment);
        return actor;
      });

      await this.stage(job, token, 'generating');
      abort.signal.throwIfAborted();
      const draft = await this.engagement.generateMeetingDebriefDraft(ctx, job.meetingId, {
        method: input.method,
        sourceText: input.sourceText,
      });
      abort.signal.throwIfAborted();

      await this.stage(job, token, 'recording');
      // Publish only while the recorded assignment still holds. The lease proves the
      // claim; this proves the meeting is still the one the job was assembled for.
      await this.prisma.withTenantUser(job.tenantId, job.userId, (tx) =>
        this.prepJobs.authorizeJobMeeting(tx, ctx, job.meetingId, input.assignment),
      );
      const saved = await this.prisma.withTenantUser(job.tenantId, job.userId, async (tx) =>
        tx.meetingDebriefJob.updateMany({
          where: this.leaseWhere(job, token),
          data: {
            status: 'completed',
            stage: 'completed',
            // The draft is user content: stored encrypted, like prep checkpoints.
            checkpoints: json({ draft: this.crypto.encrypt(JSON.stringify(draft)) }),
            leaseToken: null,
            leaseUntil: null,
          },
        }),
      );
      if (saved.count !== 1) throw new Error('meeting_debrief_lease_lost');
    } catch (error) {
      abort.abort(new Error('meeting_debrief_stopped'));
      const message = error instanceof Error ? error.message : '';
      const code = /budget/i.test(message)
        ? 'DEBRIEF_BUDGET_EXHAUSTED'
        : /deadline/i.test(message)
        ? 'DEBRIEF_DEADLINE_EXCEEDED'
        : /access|assignment|client changed|revoked/i.test(message)
          ? 'DEBRIEF_SCOPE_CHANGED'
          : 'DEBRIEF_GENERATION_FAILED';
      const causeCode = (error as { code?: unknown } | null)?.code;
      (this.logger as Logger | undefined)?.warn(
        JSON.stringify({
          event: 'meeting_debrief_failed',
          jobId: job.id,
          errorCode: code,
          causeCode:
            typeof causeCode === 'string' && /^[A-Z0-9_]{2,80}$/.test(causeCode) ? causeCode : null,
        }),
      );
      await this.prisma.withTenantUser(job.tenantId, job.userId, (tx) =>
        tx.meetingDebriefJob.updateMany({
          where: {
            id: job.id,
            tenantId: job.tenantId,
            userId: job.userId,
            leaseToken: token,
            status: 'running',
          },
          data: {
            status: 'failed',
            stage: 'failed',
            errorCode: code,
            leaseToken: null,
            leaseUntil: null,
          },
        }),
      );
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
  }

  private async stage(job: MeetingDebriefJob, token: string, stage: MeetingDebriefStage) {
    const saved = await this.prisma.withTenantUser(job.tenantId, job.userId, (tx) =>
      tx.meetingDebriefJob.updateMany({
        where: this.leaseWhere(job, token),
        data: { stage },
      }),
    );
    if (saved.count !== 1) throw new Error('meeting_debrief_lease_lost');
  }

  private leaseWhere(job: MeetingDebriefJob, token: string): Prisma.MeetingDebriefJobWhereInput {
    return {
      id: job.id,
      tenantId: job.tenantId,
      userId: job.userId,
      status: 'running',
      leaseToken: token,
      leaseUntil: { gt: new Date() },
      deadlineAt: { gt: new Date() },
    };
  }

  /**
   * The ONE stored-result admission: re-admit the job's RECORDED assignment through the
   * existing job-meeting owner before any public projection, in the read path and in the
   * submit replay alike. A completed job whose recorded assignment cannot be read is not
   * publishable at all.
   */
  private async assertRecordedAssignment(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    job: MeetingDebriefJob,
  ): Promise<void> {
    const recorded = this.recordedAssignment(job);
    if (job.status === 'completed' && !recorded)
      throw new Error('meeting_debrief_assignment_unreadable');
    await this.prepJobs.authorizeJobMeeting(tx, ctx, job.meetingId, recorded);
  }

  /**
   * The assignment digest recorded with the job, or undefined when it cannot be read
   * (a job with no readable input). Callers refuse to publish stored content in that
   * case; a job without content falls back to the current assignment.
   */
  private recordedAssignment(job: MeetingDebriefJob): string | undefined {
    try {
      const input = JSON.parse(
        this.crypto.decrypt(
          job.input as unknown as Parameters<MeetingNotesCryptoService['decrypt']>[0],
        ),
      ) as JobInput;
      if (typeof input.assignment === 'string' && input.assignment) return input.assignment;
    } catch {
      // fall through
    }
    return undefined;
  }

  /**
   * The persisted checkpoint is the encrypted envelope OBJECT that crypto.encrypt
   * returns; a legacy string envelope is accepted too. A completed job with a
   * checkpoint that cannot be read is reported (and logged) rather than crashing or
   * silently pretending the result is fine.
   */
  private decodeCompletedDraft(job: MeetingDebriefJob, value: unknown): unknown {
    if (value === null || value === undefined) {
      (this.logger as Logger | undefined)?.warn(
        JSON.stringify({ event: 'meeting_debrief_checkpoint_missing', jobId: job.id }),
      );
      return undefined;
    }
    try {
      const envelope = typeof value === 'string' ? JSON.parse(value) : value;
      if (!envelope || typeof envelope !== 'object')
        throw new Error('meeting_debrief_checkpoint_malformed');
      return JSON.parse(
        this.crypto.decrypt(envelope as Parameters<MeetingNotesCryptoService['decrypt']>[0]),
      );
    } catch (error) {
      (this.logger as Logger | undefined)?.warn(
        JSON.stringify({
          event: 'meeting_debrief_checkpoint_unreadable',
          jobId: job.id,
          causeCode:
            error instanceof Error && /^[a-z_]{2,80}$/.test(error.message)
              ? error.message
              : null,
        }),
      );
      return undefined;
    }
  }

  private publicJob(job: MeetingDebriefJob) {
    const checkpoint = (job.checkpoints ?? {}) as { draft?: unknown };
    const draft =
      job.status === 'completed'
        ? this.decodeCompletedDraft(job, checkpoint.draft)
        : undefined;
    return {
      jobId: job.id,
      meetingId: job.meetingId,
      status: job.status,
      stage: job.stage,
      requestKey: job.requestKey,
      debriefId: job.debriefId,
      errorCode: job.errorCode,
      deadlineAt: job.deadlineAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(draft ? { draft } : {}),
    };
  }
}
