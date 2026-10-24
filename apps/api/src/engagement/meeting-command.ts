import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLE_RANK, type TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ownMeetingWhere } from './engagement-access.helpers.js';
import { assertMeetingClient, currentMeetingActor } from './meeting-resource-authority.js';
import {
  meetingCommandDigest,
  meetingCommandRequestId,
  parseMeetingCommand,
  type MeetingCommand,
} from './meeting-command.input.js';

export type MeetingExecution = { tx: Prisma.TransactionClient; afterCommit: Array<() => void> };
export type MeetingCommandResult = {
  meetingId: string;
  clientId: string | null;
  revision: string;
  artifacts: Array<{
    type: 'note' | 'debrief' | 'prep' | 'attachment';
    id: string;
    revision: string;
  }>;
};
type Saved = {
  requestId: string;
  payloadDigest: string;
  operation: MeetingCommand['operation'];
  requestedMeetingId: string | null;
  expectedClientId: string | null;
  clientIds: string[];
  status: 'completed' | 'refused';
  result: MeetingCommandResult | null;
  message: string | null;
  createdAt: Date;
};
const unavailable = () => new NotFoundException('Meeting command not found');
const artifactTables = {
  note: 'meeting_notes',
  debrief: 'meeting_debriefs',
  prep: 'meeting_preps',
  attachment: 'engagement_attachments',
} as const;

async function actor(tx: Prisma.TransactionClient, ctx: TenantContext) {
  const current = await currentMeetingActor(tx, ctx);
  const rank = ROLE_RANK[current.role];
  if (typeof rank !== 'number' || rank < ROLE_RANK.standard_user) throw new ForbiddenException();
  return current;
}
async function lock(tx: Prisma.TransactionClient, ctx: TenantContext, requestId: string) {
  const key = JSON.stringify(['meeting-command', ctx.tenantId, ctx.userId, requestId]);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`;
}
async function saved(tx: Prisma.TransactionClient, ctx: TenantContext, requestId: string) {
  const rows = await tx.$queryRaw<Saved[]>`
    SELECT request_id::text AS "requestId", payload_digest AS "payloadDigest", operation,
      requested_meeting_id::text AS "requestedMeetingId", expected_client_id::text AS "expectedClientId",
      client_ids AS "clientIds", status, result_jsonb AS result, message, created_at AS "createdAt"
    FROM meeting_command_receipts WHERE tenant_id=${ctx.tenantId}::uuid
      AND actor_user_id=${ctx.userId}::uuid AND request_id=${requestId}::uuid`;
  return rows[0];
}
async function receipt(tx: Prisma.TransactionClient, ctx: TenantContext, row: Saved) {
  for (const clientId of row.clientIds) await assertMeetingClient(tx, ctx, clientId);
  let available = false;
  if (row.result) {
    const meeting = await tx.meeting.findFirst({
      where: { id: row.result.meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
      select: { id: true, clientId: true },
    });
    if (meeting) {
      await assertMeetingClient(tx, ctx, meeting.clientId);
      available = meeting.clientId === row.result.clientId;
      for (const item of row.result.artifacts) {
        const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id FROM ${Prisma.raw(artifactTables[item.type])}
          WHERE tenant_id=${ctx.tenantId}::uuid AND meeting_id=${meeting.id}::uuid AND id=${item.id}::uuid`);
        if (!rows.length) available = false;
      }
    }
  }
  return {
    schemaVersion: 1 as const,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    requestId: row.requestId,
    payloadDigest: row.payloadDigest,
    operation: row.operation,
    requestedMeetingId: row.requestedMeetingId,
    expectedClientId: row.expectedClientId,
    status: row.status,
    result: row.result,
    refusal:
      row.status === 'refused'
        ? { code: 'MEETING_COMMAND_REFUSED' as const, message: row.message! }
        : null,
    createdAt: row.createdAt.toISOString(),
    available,
  };
}

/** Lock/recheck the reviewed parent and selected revisions before the existing writer. */
async function admit(tx: Prisma.TransactionClient, ctx: TenantContext, command: MeetingCommand) {
  await assertMeetingClient(tx, ctx, command.expectedClientId);
  if (command.meeting?.assignClient) await assertMeetingClient(tx, ctx, command.meeting.clientId);
  if (!command.meetingId) return;
  await tx.$queryRaw`SELECT id FROM meetings WHERE tenant_id=${ctx.tenantId}::uuid AND id=${command.meetingId}::uuid FOR UPDATE`;
  const meeting = await tx.meeting.findFirst({
    where: {
      id: command.meetingId,
      tenantId: ctx.tenantId,
      ...(command.operation === 'unshare' ? {} : ownMeetingWhere(ctx.userId)),
    },
    select: { id: true, clientId: true, updatedAt: true },
  });
  if (!meeting) throw unavailable();
  await assertMeetingClient(tx, ctx, meeting.clientId);
  if (
    meeting.clientId !== command.expectedClientId ||
    meeting.updatedAt.toISOString() !== command.expectedRevision
  )
    throw new ConflictException('The reviewed meeting changed');
  const refs = command.artifact?.id
    ? [
        {
          type: command.operation.startsWith('note-') ? ('note' as const) : ('debrief' as const),
          id: command.artifact.id,
          revision: command.artifact.revision!,
        },
      ]
    : command.artifacts;
  for (const item of refs) {
    const rows = await tx.$queryRaw<Array<{ updatedAt: Date }>>(Prisma.sql`
      SELECT updated_at AS "updatedAt" FROM ${Prisma.raw(artifactTables[item.type])}
      WHERE tenant_id=${ctx.tenantId}::uuid AND meeting_id=${meeting.id}::uuid AND id=${item.id}::uuid FOR UPDATE`);
    if (rows.length !== 1 || rows[0]!.updatedAt.toISOString() !== item.revision)
      throw new ConflictException('A reviewed artifact changed');
  }
}
async function insert(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  command: MeetingCommand,
  digest: string,
  result: MeetingCommandResult | null,
  message: string | null,
) {
  const clientIds = [
    ...new Set(
      [
        command.expectedClientId,
        command.meeting?.assignClient ? command.meeting.clientId : null,
        result?.clientId,
      ].filter((value): value is string => Boolean(value)),
    ),
  ].sort();
  const status = result ? 'completed' : 'refused';
  await tx.$executeRaw`
    INSERT INTO meeting_command_receipts
      (tenant_id,actor_user_id,request_id,payload_digest,operation,requested_meeting_id,expected_client_id,client_ids,status,result_jsonb,message)
    VALUES (${ctx.tenantId}::uuid,${ctx.userId}::uuid,${command.requestId}::uuid,${digest},${command.operation},
      ${command.meetingId}::uuid,${command.expectedClientId}::uuid,${clientIds}::uuid[],${status},${result ? JSON.stringify(result) : null}::jsonb,${message})`;
  return (await saved(tx, ctx, command.requestId))!;
}

export async function commitMeetingCommand(
  prisma: PrismaService,
  ctx: TenantContext,
  raw: unknown,
  run: (
    tx: Prisma.TransactionClient,
    current: TenantContext,
    command: MeetingCommand,
  ) => Promise<MeetingCommandResult>,
) {
  const command = parseMeetingCommand(raw);
  const digest = meetingCommandDigest(ctx, command);
  let admittedOriginal = false;
  try {
    return await prisma.withTenant(ctx.tenantId, async (tx) => {
      await lock(tx, ctx, command.requestId);
      let current = await actor(tx, ctx);
      const previous = await saved(tx, current, command.requestId);
      if (previous) {
        if (previous.payloadDigest !== digest)
          throw new ConflictException('Request ID belongs to another meeting action');
        return { receipt: await receipt(tx, current, previous), fresh: false };
      }
      admittedOriginal = true;
      await admit(tx, current, command);
      // A parent/artifact lock may wait behind another transaction. Recheck
      // current authority after every wait, before entering the existing writer.
      current = await actor(tx, current);
      await assertMeetingClient(tx, current, command.expectedClientId);
      if (command.meeting?.assignClient)
        await assertMeetingClient(tx, current, command.meeting.clientId);
      const result = await run(tx, current, command);
      if (command.meetingId && result.meetingId !== command.meetingId)
        throw new Error('Meeting command result mismatch');
      await tx.auditLog.create({
        data: {
          tenantId: current.tenantId,
          actorUserId: current.userId,
          actorRole: current.role,
          action: 'meeting.command.completed',
          entityType: 'meeting',
          entityId: result.meetingId,
          requestId: command.requestId,
          before: {
            operation: command.operation,
            payloadDigest: digest,
            expectedRevision: command.expectedRevision,
          },
          after: result as Prisma.InputJsonValue,
        },
      });
      return {
        receipt: await receipt(
          tx,
          current,
          await insert(tx, current, command, digest, result, null),
        ),
        fresh: true,
      };
    });
  } catch (error) {
    // Only our original transaction's known rollback can become a durable refusal.
    // Authentication, unavailable reads, commit failures and conflicting replays stay errors.
    if (
      !admittedOriginal ||
      !(error instanceof BadRequestException || error instanceof ConflictException)
    )
      throw error;
    return prisma.withTenant(ctx.tenantId, async (tx) => {
      await lock(tx, ctx, command.requestId);
      const current = await actor(tx, ctx);
      const previous = await saved(tx, current, command.requestId);
      if (previous) {
        if (previous.payloadDigest !== digest)
          throw new ConflictException('Request ID belongs to another meeting action');
        return { receipt: await receipt(tx, current, previous), fresh: false };
      }
      await assertMeetingClient(tx, current, command.expectedClientId);
      if (command.meeting?.assignClient)
        await assertMeetingClient(tx, current, command.meeting.clientId);
      const message =
        error instanceof ConflictException
          ? 'The reviewed meeting or artifact changed. Review this action again.'
          : 'This meeting action could not be applied. Review it again.';
      return {
        receipt: await receipt(
          tx,
          current,
          await insert(tx, current, command, digest, null, message),
        ),
        fresh: false,
      };
    });
  }
}
export async function readMeetingCommand(
  prisma: PrismaService,
  ctx: TenantContext,
  rawRequestId: string,
) {
  const requestId = meetingCommandRequestId(rawRequestId);
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await lock(tx, ctx, requestId);
    const current = await actor(tx, ctx);
    const row = await saved(tx, current, requestId);
    if (!row) throw unavailable();
    return receipt(tx, current, row);
  });
}

export async function meetingCommandResult(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  command: MeetingCommand,
  meetingId: string,
  artifactId?: string,
): Promise<MeetingCommandResult> {
  const meeting = await tx.meeting.findFirst({
    where: { id: meetingId, tenantId: ctx.tenantId },
    select: { clientId: true, updatedAt: true },
  });
  if (!meeting) throw new Error('Meeting command result is unavailable');
  const refs = artifactId
    ? [
        {
          type: command.operation.startsWith('note-') ? ('note' as const) : ('debrief' as const),
          id: artifactId,
        },
      ]
    : command.artifacts;
  const artifacts: MeetingCommandResult['artifacts'] = [];
  for (const item of refs) {
    const rows = await tx.$queryRaw<Array<{ updatedAt: Date }>>(Prisma.sql`
      SELECT updated_at AS "updatedAt" FROM ${Prisma.raw(artifactTables[item.type])}
      WHERE tenant_id=${ctx.tenantId}::uuid AND meeting_id=${meetingId}::uuid AND id=${item.id}::uuid`);
    if (rows.length !== 1) throw new Error('Artifact command result is unavailable');
    artifacts.push({ type: item.type, id: item.id, revision: rows[0]!.updatedAt.toISOString() });
  }
  return {
    meetingId,
    clientId: meeting.clientId,
    revision: meeting.updatedAt.toISOString(),
    artifacts,
  };
}
