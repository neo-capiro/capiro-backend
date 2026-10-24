import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ClientActivityCommand, Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { projectActivityDetails } from '../client-activity-details.js';

type Tx = Prisma.TransactionClient;
type Undo = { requestId: string; payloadDigest: string; removedAt: string };
const inputSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
    activityId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
    expectedRevision: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  })
  .strict();
export function activityUndoInput(raw: unknown) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException('Invalid activity Undo');
  return parsed.data;
}
export function activityUndoDigest(row: ClientActivityCommand, input: z.infer<typeof inputSchema>) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'activity-command-undo',
        1,
        row.tenantId,
        row.actorUserId,
        row.clientId,
        row.id,
        row.requestId,
        input.requestId,
        input.activityId,
        input.expectedRevision,
      ]),
    )
    .digest('hex');
}
function identity(row: ClientActivityCommand) {
  return {
    schemaVersion: 1 as const,
    commandId: row.id,
    creationRequestId: row.requestId,
    tenantId: row.tenantId,
    clientId: row.clientId,
    actorUserId: row.actorUserId,
    activityId: row.activityId,
  };
}
async function storedUndo(tx: Tx, row: ClientActivityCommand) {
  const rows = await tx.$queryRaw<Undo[]>`SELECT undo_request_id::text AS "requestId",
    undo_request_hash AS "payloadDigest",
    to_char(undone_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "removedAt"
    FROM client_activity_commands WHERE tenant_id=${row.tenantId}::uuid AND id=${row.id}::uuid
      AND undo_request_id IS NOT NULL`;
  return rows[0];
}
function completed(row: ClientActivityCommand, undo: Undo) {
  return { ...identity(row), status: 'removed' as const, undo };
}
function requirePlain(row: ClientActivityCommand) {
  if (row.assigneeUserId || row.status !== 'completed')
    throw new ConflictException(
      'Undo is available only for a completed activity without a follow-up',
    );
}

/** Caller holds canonical client/actor/wall locks. The row lock keeps the exact
 * database revision and its projected snapshot together, including microseconds. */
export async function readCommandUndo(tx: Tx, ctx: TenantContext, row: ClientActivityCommand) {
  requirePlain(row);
  const undo = await storedUndo(tx, row);
  if (undo) return completed(row, undo);
  const versions = await tx.$queryRaw<Array<{ revision: string }>>`
    SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision
    FROM client_activity WHERE tenant_id=${row.tenantId}::uuid AND client_id=${row.clientId}::uuid
      AND id=${row.activityId}::uuid FOR SHARE`;
  const activity = versions.length
    ? await tx.clientActivity.findFirst({
        where: { id: row.activityId, tenantId: row.tenantId, clientId: row.clientId },
      })
    : null;
  if (
    !activity ||
    activity.sourceType !== 'activity_command' ||
    activity.sourceId !== row.id ||
    activity.createdByUserId !== row.actorUserId ||
    activity.pinned ||
    activity.settledAt
  )
    return { ...identity(row), status: 'unavailable' as const };
  const [details] = await projectActivityDetails(tx, ctx, row.clientId, [activity]);
  return {
    ...identity(row),
    status: 'available' as const,
    revision: versions[0]!.revision,
    activity: {
      id: activity.id,
      kind: activity.kind,
      title: activity.title,
      body: activity.body,
      personId: activity.personId,
      occurredAt: activity.occurredAt.toISOString(),
      dueAt: activity.dueAt?.toISOString() ?? null,
      pinned: activity.pinned,
      settledAt: null,
      sourceType: activity.sourceType,
      sourceId: activity.sourceId,
      origin: 'recorded' as const,
      ...details,
    },
  };
}

/** Same transaction as the owner's command lock and authority locks. A missing
 * row without our tuple is never evidence that this Undo completed. */
export async function commitCommandUndo(
  tx: Tx,
  row: ClientActivityCommand,
  input: ReturnType<typeof activityUndoInput>,
) {
  requirePlain(row);
  if (input.activityId !== row.activityId) throw new ConflictException('Undo activity changed');
  const payloadDigest = activityUndoDigest(row, input);
  const prior = await storedUndo(tx, row);
  if (prior) {
    if (prior.requestId !== input.requestId || prior.payloadDigest !== payloadDigest)
      throw new ConflictException('This activity already has a different Undo');
    return completed(row, prior);
  }
  const deleted = await tx.$queryRaw<Array<{ id: string }>>`DELETE FROM client_activity
    WHERE tenant_id=${row.tenantId}::uuid AND client_id=${row.clientId}::uuid
      AND id=${row.activityId}::uuid AND created_by_user_id=${row.actorUserId}::uuid
      AND source_type='activity_command' AND source_id=${row.id}
      AND NOT pinned AND settled_at IS NULL
      AND to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=${input.expectedRevision}
    RETURNING id::text`;
  if (deleted.length !== 1)
    throw new ConflictException('The activity changed or is unavailable. Undo is not confirmed.');
  const saved = await tx.$queryRaw<Undo[]>`UPDATE client_activity_commands
    SET undo_request_id=${input.requestId}::uuid, undo_request_hash=${payloadDigest}, undone_at=clock_timestamp()
    WHERE tenant_id=${row.tenantId}::uuid AND id=${row.id}::uuid AND undo_request_id IS NULL
    RETURNING undo_request_id::text AS "requestId",undo_request_hash AS "payloadDigest",
      to_char(undone_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "removedAt"`;
  if (saved.length !== 1) throw new ConflictException('Undo receipt could not be committed');
  return completed(row, saved[0]!);
}
