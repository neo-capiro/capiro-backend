import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, MeetingPrepJob } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from './engagement.service.js';
import { ClientAssociationService } from './client-association.service.js';
import { ownMeetingWhere } from './engagement-access.helpers.js';
import { MeetingNotesCryptoService } from './meeting-notes-crypto.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import {
  MEETING_PREP_DEPTHS,
  MEETING_PREP_POLICY as POLICY,
  meetingPrepEnabled,
  type MeetingPrepDepth,
} from './meeting-prep-policy.js';
import { withMeetingPrepExecution } from './meeting-prep-job-runtime.js';

interface JobInput {
  additionalContext?: string;
  assignment: string;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class MeetingPrepJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    private readonly crypto: MeetingNotesCryptoService,
    private readonly runtime: EngagementRuntimePolicyService,
    @Optional() private readonly associations?: ClientAssociationService,
  ) {}

  async submit(
    ctx: TenantContext,
    meetingId: string,
    input: {
      additionalContext?: string;
      depth?: MeetingPrepDepth;
      requestKey?: string;
    },
  ) {
    this.runtime.assertExternalAction('meeting_prep_generate');
    if (!meetingPrepEnabled())
      throw new ServiceUnavailableException('Comprehensive meeting preparation is not enabled.');
    const depth = input.depth ?? 'standard';
    if (!(MEETING_PREP_DEPTHS as readonly string[]).includes(depth))
      throw new BadRequestException('Invalid preparation depth.');
    if ((input.additionalContext?.length ?? 0) > 4_000)
      throw new BadRequestException('Preparation focus is too long.');
    const requestKey = input.requestKey ?? randomUUID();
    if (!/^[\w-]{8,128}$/.test(requestKey)) throw new BadRequestException('Invalid request key.');
    const requestHash = digest({
      meetingId,
      depth,
      additionalContext: input.additionalContext?.trim() ?? '',
      policy: POLICY.version,
    });
    const create = () =>
      this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const { assignment } = await this.authorize(tx, ctx, meetingId);
        const existing = await tx.meetingPrepJob.findUnique({
          where: {
            tenantId_userId_requestKey: { tenantId: ctx.tenantId, userId: ctx.userId, requestKey },
          },
        });
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new ConflictException(
              'This request key was already used for different preparation settings.',
            );
          return this.publicJob(existing);
        }
        const job = await tx.meetingPrepJob.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            meetingId,
            requestKey,
            requestHash,
            depth,
            deadlineAt: new Date(Date.now() + POLICY[depth].deadlineMs),
            input: json(
              this.crypto.encrypt(
                JSON.stringify({
                  additionalContext: input.additionalContext,
                  assignment,
                } satisfies JobInput),
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
    if (!meetingPrepEnabled()) return null;
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.authorize(tx, ctx, meetingId, undefined, true);
      const job = await tx.meetingPrepJob.findFirst({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          meetingId,
          ...(jobId ? { id: jobId } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!job && jobId) throw new NotFoundException('Preparation job not found.');
      return job ? this.publicJob(job) : null;
    });
  }

  async mondayMapping(ctx: TenantContext, meetingId: string, boardIds?: string[]) {
    if (!meetingPrepEnabled()) return null;
    if (boardIds && (boardIds.length > 20 || boardIds.some((id) => !/^\d{1,24}$/.test(id))))
      throw new BadRequestException('Supply up to 20 canonical Monday.com board IDs.');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const { clientId } = await this.authorize(tx, ctx, meetingId);
      if (!clientId)
        throw new BadRequestException(
          'Assign this meeting to a client before mapping Monday.com boards.',
        );
      const key = { tenantId: ctx.tenantId, userId: ctx.userId, clientId };
      if (boardIds)
        return tx.meetingPrepMondayMapping.upsert({
          where: { tenantId_userId_clientId: key },
          create: { ...key, boardIds: [...new Set(boardIds)] },
          update: { boardIds: [...new Set(boardIds)] },
          select: { clientId: true, boardIds: true },
        });
      return (
        (await tx.meetingPrepMondayMapping.findUnique({
          where: { tenantId_userId_clientId: key },
          select: { clientId: true, boardIds: true },
        })) ?? { clientId, boardIds: [] }
      );
    });
  }

  async cancel(ctx: TenantContext, meetingId: string, jobId: string) {
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.authorize(tx, ctx, meetingId, undefined, true);
      await tx.meetingPrepJob.updateMany({
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
    return this.get(ctx, meetingId, jobId);
  }

  async resume(ctx: TenantContext, meetingId: string, jobId: string) {
    this.runtime.assertExternalAction('meeting_prep_generate');
    if (!meetingPrepEnabled())
      throw new ServiceUnavailableException('Comprehensive preparation is disabled.');
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const job = await tx.meetingPrepJob.findFirst({
        where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId, meetingId },
      });
      if (!job) throw new NotFoundException('Preparation job not found.');
      const input = JSON.parse(
        this.crypto.decrypt(
          job.input as unknown as Parameters<MeetingNotesCryptoService['decrypt']>[0],
        ),
      ) as JobInput;
      await this.authorize(tx, ctx, meetingId, input.assignment);
      if (job.deadlineAt.getTime() <= Date.now() || job.attempts >= 3)
        throw new BadRequestException(
          'This search budget is exhausted. Start a new preparation run.',
        );
      await tx.meetingPrepJob.updateMany({
        where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId, status: 'failed' },
        data: {
          status: 'queued',
          stage: 'queued',
          errorCode: null,
          leaseToken: null,
          leaseUntil: null,
        },
      });
    });
    return this.get(ctx, meetingId, jobId);
  }

  /** Only the explicit background-owner module calls this system-level claim. */
  async runWorkerTick(): Promise<void> {
    if (!meetingPrepEnabled()) return;
    this.runtime.assertBackgroundOwner('meeting-prep-worker');
    this.runtime.assertExternalAction('meeting_prep_generate');
    const now = new Date();
    const token = randomUUID();
    const job = await this.prisma.withSystem(async (tx) => {
      await tx.meetingPrepJob.updateMany({
        where: {
          status: { in: ['queued', 'running'] },
          OR: [{ deadlineAt: { lte: now } }, { attempts: { gte: 3 }, leaseUntil: { lt: now } }],
        },
        data: {
          status: 'failed',
          stage: 'failed',
          errorCode: 'PREP_BUDGET_EXHAUSTED',
          leaseToken: null,
          leaseUntil: null,
        },
      });
      const candidate = await tx.meetingPrepJob.findFirst({
        where: {
          deadlineAt: { gt: now },
          attempts: { lt: 3 },
          OR: [{ status: 'queued' }, { status: 'running', leaseUntil: { lt: now } }],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;
      const claimed = await tx.meetingPrepJob.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          leaseToken: candidate.leaseToken,
          ...(candidate.status === 'running' ? { leaseUntil: { lt: now } } : {}),
        },
        data: {
          status: 'running',
          leaseToken: token,
          leaseUntil: new Date(Date.now() + POLICY.leaseMs),
          attempts: { increment: 1 },
        },
      });
      return claimed.count === 1 ? candidate : null;
    });
    if (job) await this.process(job, token);
  }

  private async process(job: MeetingPrepJob, token: string): Promise<void> {
    const abort = new AbortController();
    const deadline = setTimeout(
      () => abort.abort(new Error('meeting_prep_deadline_exceeded')),
      Math.max(1, job.deadlineAt.getTime() - Date.now()),
    );
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.prisma
        .withTenantUser(job.tenantId, job.userId, async (tx) => {
          const renewed = await tx.meetingPrepJob.updateMany({
            where: this.leaseWhere(job, token),
            data: { leaseUntil: new Date(Date.now() + POLICY.leaseMs) },
          });
          if (renewed.count !== 1) abort.abort(new Error('meeting_prep_lease_lost'));
        })
        .catch(() => abort.abort(new Error('meeting_prep_lease_unavailable')))
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
        if (!membership) throw new Error('meeting_prep_access_revoked');
        const actor: TenantContext = {
          tenantId: job.tenantId,
          userId: job.userId,
          tenantSlug: membership.tenant.slug,
          clerkUserId: membership.user.clerkUserId,
          role: membership.role,
        };
        await this.authorize(tx, actor, job.meetingId, input.assignment);
        return actor;
      });
      const checkpoints = { ...(job.checkpoints as Record<string, Prisma.JsonValue>) };
      await withMeetingPrepExecution(
        {
          jobId: job.id,
          depth: job.depth as MeetingPrepDepth,
          requestedAt: job.createdAt.getTime(),
          deadlineAt: job.deadlineAt.getTime(),
          signal: abort.signal,
          loadCheckpoint: <T>(stage: string) => {
            const value = checkpoints[stage];
            return value
              ? (JSON.parse(
                  this.crypto.decrypt(
                    value as unknown as Parameters<MeetingNotesCryptoService['decrypt']>[0],
                  ),
                ) as T)
              : undefined;
          },
          checkpoint: async (stage, value) => {
            abort.signal.throwIfAborted();
            this.runtime.assertExternalAction('meeting_prep_generate');
            if (!meetingPrepEnabled()) throw new Error('meeting_prep_disabled');
            if (value !== undefined)
              checkpoints[stage] = json(
                this.crypto.encrypt(JSON.stringify(value)),
              ) as Prisma.JsonValue;
            await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
              await this.authorize(tx, ctx, job.meetingId, input.assignment);
              const saved = await tx.meetingPrepJob.updateMany({
                where: this.leaseWhere(job, token),
                data: { stage, checkpoints: json(checkpoints) },
              });
              if (saved.count !== 1) throw new Error('meeting_prep_lease_lost');
            });
          },
          commit: async (tx, prepId) => {
            abort.signal.throwIfAborted();
            await this.authorize(tx, ctx, job.meetingId, input.assignment);
            const saved = await tx.meetingPrepJob.updateMany({
              where: this.leaseWhere(job, token),
              data: {
                status: 'completed',
                stage: 'completed',
                prepId,
                checkpoints: {},
                leaseToken: null,
                leaseUntil: null,
              },
            });
            if (saved.count !== 1) throw new Error('meeting_prep_lease_lost');
          },
        },
        () => this.engagement.generateMeetingPrep(ctx, job.meetingId, input.additionalContext),
      );
    } catch (error) {
      // No provider payloads, source bodies or credentials in public errors.
      abort.abort(new Error('meeting_prep_stopped'));
      const message = error instanceof Error ? error.message : '';
      const code = /deadline|budget/i.test(message)
        ? 'PREP_DEADLINE_EXCEEDED'
        : /access|assignment|client changed/i.test(message)
          ? 'PREP_SCOPE_CHANGED'
          : 'PREP_GENERATION_FAILED';
      await this.prisma.withTenantUser(job.tenantId, job.userId, (tx) =>
        tx.meetingPrepJob.updateMany({
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

  private leaseWhere(job: MeetingPrepJob, token: string): Prisma.MeetingPrepJobWhereInput {
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

  private async authorize(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    meetingId: string,
    expected?: string,
    allowCancelled = false,
  ) {
    const membership = await tx.tenantMembership.findFirst({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
      select: { role: true },
    });
    if (!membership || membership.role !== ctx.role)
      throw new NotFoundException('Preparation access changed.');
    const meeting = await tx.meeting.findFirst({
      where: { tenantId: ctx.tenantId, id: meetingId, ...ownMeetingWhere(ctx.userId) },
      select: {
        clientId: true,
        isInternal: true,
        associationSignals: true,
        status: true,
        subject: true,
        description: true,
        startsAt: true,
        endsAt: true,
        attendees: { select: { email: true, name: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!meeting) throw new NotFoundException('Meeting not found.');
    if (!allowCancelled && ['cancelled', 'canceled'].includes(meeting.status.toLowerCase()))
      throw new BadRequestException('Meeting is cancelled.');
    const signals = meeting.associationSignals as { manual?: boolean } | null;
    const manuallyCleared = !meeting.clientId && signals?.manual === true;
    const effectiveClientId =
      meeting.isInternal || manuallyCleared
        ? null
        : (meeting.clientId ??
          (this.associations
            ? (
                await this.associations.associate(tx, ctx.tenantId, {
                  subject: meeting.subject,
                  body: meeting.description,
                  attendeeEmails: meeting.attendees.flatMap((attendee) =>
                    attendee.email ? [attendee.email] : [],
                  ),
                })
              ).clientId
            : null));
    if (effectiveClientId) {
      const client = await tx.client.findFirst({
        where: {
          id: effectiveClientId,
          tenantId: ctx.tenantId,
          status: { not: 'archived' },
          OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: ctx.userId } } }],
        },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Meeting client access changed.');
    }
    const assignment = digest({
      clientId: effectiveClientId,
      isInternal: meeting.isInternal,
      manuallyCleared,
      subject: meeting.subject,
      startsAt: meeting.startsAt,
      endsAt: meeting.endsAt,
      attendees: meeting.attendees,
    });
    if (expected && assignment !== expected)
      throw new ConflictException('Meeting assignment changed during preparation.');
    return { assignment, clientId: effectiveClientId };
  }

  private publicJob(job: MeetingPrepJob) {
    return {
      jobId: job.id,
      meetingId: job.meetingId,
      status: job.status,
      stage: job.stage,
      depth: job.depth,
      prepId: job.prepId,
      errorCode: job.errorCode,
      deadlineAt: job.deadlineAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}
