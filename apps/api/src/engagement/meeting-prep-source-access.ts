import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import {
  canReadEncryptedEntry,
  ownMailMessageWhere,
  ownMeetingWhere,
} from './engagement-access.helpers.js';
import type { PrepEvidenceSource } from './meeting-prep-grounding.js';
import { managedAppAvailable } from '../meri/meri-managed-mcp.helpers.js';

/** Rechecks mutable native-source ACLs at persistence and artifact display. */
export async function assertMeetingPrepSourceAccess(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  sources: Array<Pick<PrepEvidenceSource, 'access'>>,
): Promise<void> {
  const ids = (key: keyof NonNullable<PrepEvidenceSource['access']>) => [
    ...new Set(sources.flatMap((source) => source.access?.[key] ?? [])),
  ];
  const meetingIds = ids('meetings');
  const mailIds = ids('mail');
  const taskIds = ids('tasks');
  const clientIds = ids('clients');
  const noteIds = ids('notes');
  const debriefIds = ids('debriefs');
  // Reassignment is also an ACL change: ownership alone must not allow an
  // old artifact to retain evidence now attached to a different client wall.
  const sourceClientScope = { OR: [{ clientId: null }, { clientId: { in: clientIds } }] };
  const mondayUsers = ids('mondayUsers');
  const mondayBoards = ids('mondayBoards');
  if (mondayUsers.length || mondayBoards.length) {
    if (
      !managedAppAvailable('monday', { tenantId: ctx.tenantId, userId: ctx.userId }) ||
      mondayUsers.length !== 1 ||
      mondayUsers[0] !== ctx.userId ||
      !mondayBoards.length ||
      !clientIds.length
    )
      throw new ForbiddenException('Monday.com source access changed.');
    // Some existing display callers open tenant-only transactions. Establish
    // the authenticated actor for the personal connector's user-level RLS.
    await tx.$executeRaw`SELECT set_config('app.current_user', ${ctx.userId}, true)`;
    const [connected] = await Promise.all([
      tx.clioMcpServer.count({
        where: {
          tenantId: ctx.tenantId,
          scope: 'user',
          ownerUserId: ctx.userId,
          catalogId: 'meriv3-monday',
          enabled: true,
          connectionStatus: 'connected',
        },
      }),
    ]);
    // Board selection is durable in this artifact's immutable accessSources.
    // Requiring the mutable saved default mapping here would make request-local
    // explicit boards unreadable and would revoke old preps merely because the
    // user's default board selection changed. The connector owner, tenant,
    // requester and client wall remain rechecked on every display/export.
    if (!connected) throw new ForbiddenException('Monday.com source access changed.');
  }
  const noteSelect = {
    id: true,
    confidential: true,
    accessLevel: true,
    authorUserId: true,
  } as const;
  const [meetings, mail, tasks, clients, notes, debriefs] = await Promise.all([
    meetingIds.length
      ? tx.meeting.count({
          where: {
            tenantId: ctx.tenantId,
            id: { in: meetingIds },
            AND: [ownMeetingWhere(ctx.userId), sourceClientScope],
          },
        })
      : 0,
    mailIds.length
      ? tx.mailMessage.count({
          where: {
            tenantId: ctx.tenantId,
            id: { in: mailIds },
            ...ownMailMessageWhere(ctx.userId),
            thread: sourceClientScope,
          },
        })
      : 0,
    taskIds.length
      ? tx.engagementTask.count({
          where: {
            tenantId: ctx.tenantId,
            id: { in: taskIds },
            OR: [{ clientId: { in: clientIds } }, { clientId: null, ownerUserId: ctx.userId }],
          },
        })
      : 0,
    clientIds.length
      ? tx.client.count({
          where: {
            tenantId: ctx.tenantId,
            id: { in: clientIds },
            status: { not: 'archived' },
            OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: ctx.userId } } }],
          },
        })
      : 0,
    noteIds.length
      ? tx.meetingNote.findMany({
          where: { tenantId: ctx.tenantId, id: { in: noteIds }, meetingId: { in: meetingIds } },
          select: noteSelect,
        })
      : [],
    debriefIds.length
      ? tx.meetingDebrief.findMany({
          where: { tenantId: ctx.tenantId, id: { in: debriefIds }, meetingId: { in: meetingIds } },
          select: noteSelect,
        })
      : [],
  ]);
  if (
    meetings !== meetingIds.length ||
    mail !== mailIds.length ||
    tasks !== taskIds.length ||
    clients !== clientIds.length ||
    notes.length !== noteIds.length ||
    debriefs.length !== debriefIds.length ||
    [...notes, ...debriefs].some((entry) => !canReadEncryptedEntry(ctx, entry))
  )
    throw new ForbiddenException(
      'Meeting preparation source access changed. Regenerate with current permissions.',
    );
}

export async function assertSavedMeetingPrepAccess(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  generatedFrom: unknown,
): Promise<void> {
  const provenance = generatedFrom as {
    briefing?: unknown;
    grounding?: {
      sources?: PrepEvidenceSource[];
      accessSources?: Array<Pick<PrepEvidenceSource, 'access'>>;
    };
  } | null;
  if (!provenance?.briefing) return;
  const sources = provenance.grounding?.accessSources ?? provenance.grounding?.sources;
  if (!Array.isArray(sources) || !sources.length)
    throw new ForbiddenException(
      'Meeting preparation source provenance is missing. Regenerate this briefing.',
    );
  await assertMeetingPrepSourceAccess(tx, ctx, sources);
}
