import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { ClientActivityCommand } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientActivityService } from '../client-activity.service.js';
import {
  commandAssignee,
  commandIssue,
  requireCommandActor,
  type CommandTx,
} from './activity-command.access.js';
import {
  activityCommandHash,
  activityCommandInput,
  commandUuid,
  plannerPayload,
  resumeVersion,
} from './activity-command.input.js';
import {
  ActivityCommandPlanner,
  requireCommandBearer,
  type PlannerResult,
} from './activity-command.planner.js';

const unavailable = () => new NotFoundException('Activity command not found');
type Snapshot = { row: ClientActivityCommand; issue: string | null };

@Injectable()
export class ActivityCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ClientActivityService,
    private readonly planner: ActivityCommandPlanner,
  ) {}

  async create(ctx: TenantContext, rawClientId: string, raw: unknown, authorization?: string) {
    const clientId = commandUuid(rawClientId);
    const input = activityCommandInput(raw);
    const bearer = requireCommandBearer(authorization);
    if (input.followUp) this.planner.origin();
    const hash = activityCommandHash(input);
    const created = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lock(tx, ctx, clientId, input.requestId);
      await requireCommandActor(tx, ctx, clientId);
      const existing = await tx.clientActivityCommand.findFirst({
        where: this.where(ctx, clientId, input.requestId),
      });
      if (existing) {
        this.requireIdentity(ctx, existing);
        if (existing.requestHash !== hash)
          throw new ConflictException('Request ID already belongs to different activity data');
        return { row: existing, fresh: false };
      }
      const assignee = input.followUp
        ? await commandAssignee(tx, ctx, clientId, input.followUp.assigneeUserId)
        : null;
      if (input.followUp && !assignee)
        throw new BadRequestException('Follow-up assignee is unavailable');
      const id = randomUUID();
      const activity = await this.activities.createInTransaction(tx, ctx, clientId, {
        ...input.activity,
        sourceType: 'activity_command',
        sourceId: id,
      });
      const row = await tx.clientActivityCommand.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          clientId,
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
          requestId: input.requestId,
          requestHash: hash,
          activityId: activity.id,
          personId: input.activity.personId,
          assigneeUserId: input.followUp?.assigneeUserId ?? null,
          assigneeClerkUserId: assignee,
          ...(input.followUp ? { plannerPayload: plannerPayload(input.followUp, assignee!) } : {}),
          status: input.followUp ? 'pending' : 'completed',
        },
      });
      return { row, fresh: true };
    });
    if (created.fresh && created.row.assigneeUserId)
      return this.resume(
        ctx,
        clientId,
        input.requestId,
        { expectedVersion: created.row.version },
        bearer,
      );
    return this.get(ctx, clientId, input.requestId, bearer);
  }

  async get(ctx: TenantContext, rawClientId: string, rawRequestId: string, authorization?: string) {
    const clientId = commandUuid(rawClientId),
      requestId = commandUuid(rawRequestId);
    const bearer = requireCommandBearer(authorization);
    const first = await this.snapshot(ctx, clientId, requestId);
    // A stored receipt never grants access to the task's current ACL or links.
    const remote =
      first.row.taskId && !first.issue
        ? await this.planner.lookup(ctx, bearer, first.row.id)
        : undefined;
    const current = await this.snapshot(ctx, clientId, requestId);
    return this.receipt(current, remote);
  }

  async resume(
    ctx: TenantContext,
    rawClientId: string,
    rawRequestId: string,
    raw: unknown,
    authorization?: string,
  ) {
    const clientId = commandUuid(rawClientId),
      requestId = commandUuid(rawRequestId);
    const expectedVersion = resumeVersion(raw),
      bearer = requireCommandBearer(authorization);
    const claimed = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lock(tx, ctx, clientId, requestId);
      const row = await this.read(tx, ctx, clientId, requestId);
      if (row.version !== expectedVersion)
        throw new ConflictException('Activity command version changed');
      if (row.status === 'completed') return { row, claimed: false };
      if (row.leaseUntil && row.leaseUntil.getTime() > Date.now())
        throw new ConflictException('Activity command is already being attempted');
      const issue = await commandIssue(tx, ctx, row);
      if (issue) {
        return {
          row: await tx.clientActivityCommand.update({
            where: { id: row.id },
            data: {
              errorCode: issue,
              attemptToken: null,
              leaseUntil: null,
              version: { increment: 1 },
            },
          }),
          claimed: false,
        };
      }
      this.planner.origin();
      return {
        row: await tx.clientActivityCommand.update({
          where: { id: row.id },
          data: {
            attemptToken: randomUUID(),
            leaseUntil: new Date(Date.now() + 60000),
            errorCode: null,
            version: { increment: 1 },
          },
        }),
        claimed: true,
      };
    });
    if (!claimed.claimed) return this.get(ctx, clientId, requestId, bearer);
    const attempt = claimed.row;
    // Remote I/O is never inside a retryable database transaction. A 404 is
    // ambiguous (absent, deleted or denied); only the SAME-key POST is safe.
    let result = await this.planner.lookup(ctx, bearer, attempt.id);
    if (result.kind === 'missing') {
      const checked = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const row = await this.read(tx, ctx, clientId, requestId);
        if (
          row.attemptToken !== attempt.attemptToken ||
          !row.leaseUntil ||
          row.leaseUntil.getTime() <= Date.now()
        )
          return false;
        return !(await commandIssue(tx, ctx, row));
      });
      if (checked)
        result = await this.planner.create(ctx, bearer, attempt.id, attempt.plannerPayload);
      else result = { kind: 'blocked', code: 'planner_access_denied' };
    }
    const final = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lock(tx, ctx, clientId, requestId);
      const row = await this.read(tx, ctx, clientId, requestId);
      const issue = await commandIssue(tx, ctx, row);
      if (row.attemptToken !== attempt.attemptToken) return { row, issue };
      const success = result.kind === 'found';
      const saved = await tx.clientActivityCommand.update({
        where: { id: row.id },
        data: {
          status: success ? 'completed' : 'pending',
          ...(result.kind === 'found' ? { taskId: result.taskId } : {}),
          errorCode:
            issue ??
            (result.kind === 'blocked' ? result.code : success ? null : 'planner_unavailable'),
          attemptToken: null,
          leaseUntil: null,
          version: { increment: 1 },
        },
      });
      return { row: saved, issue };
    });
    return this.receipt(final, result);
  }

  private where(ctx: TenantContext, clientId: string, requestId: string) {
    return { tenantId: ctx.tenantId, clientId, actorUserId: ctx.userId, requestId };
  }
  private requireIdentity(ctx: TenantContext, row: ClientActivityCommand) {
    if (row.actorClerkUserId !== ctx.clerkUserId) throw unavailable();
  }
  private async read(tx: CommandTx, ctx: TenantContext, clientId: string, requestId: string) {
    await requireCommandActor(tx, ctx, clientId);
    const row = await tx.clientActivityCommand.findFirst({
      where: this.where(ctx, clientId, requestId),
    });
    if (!row) throw unavailable();
    this.requireIdentity(ctx, row);
    return row;
  }
  private snapshot(ctx: TenantContext, clientId: string, requestId: string): Promise<Snapshot> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.read(tx, ctx, clientId, requestId);
      return { row, issue: await commandIssue(tx, ctx, row) };
    });
  }
  private async lock(tx: CommandTx, ctx: TenantContext, clientId: string, requestId: string) {
    const key = `activity-command:${ctx.tenantId}:${ctx.userId}:${clientId}:${requestId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
  private receipt({ row, issue }: Snapshot, remote?: PlannerResult) {
    const taskAvailable = !issue && remote?.kind === 'found' && remote.taskId === row.taskId;
    const remoteIssue = row.taskId && !taskAvailable ? 'planner_receipt_unavailable' : null;
    const reason = issue ?? remoteIssue ?? row.errorCode;
    return {
      receiptVersion: 1,
      commandId: row.id,
      requestId: row.requestId,
      version: row.version,
      tenantId: row.tenantId,
      clientId: row.clientId,
      actorUserId: row.actorUserId,
      status: reason
        ? 'needs_attention'
        : row.status === 'completed'
          ? 'completed'
          : row.leaseUntil && row.leaseUntil.getTime() > Date.now()
            ? 'in_progress'
            : 'pending',
      reason,
      activity: {
        id: row.activityId,
        personId: row.personId,
        available: issue !== 'activity_removed',
      },
      followUp: row.assigneeUserId
        ? {
            owner: 'planner',
            requestId: row.id,
            assigneeUserId: row.assigneeUserId,
            state: row.taskId ? (taskAvailable ? 'completed' : 'unavailable') : 'pending',
            taskId: taskAvailable ? row.taskId : null,
          }
        : null,
    };
  }
}
