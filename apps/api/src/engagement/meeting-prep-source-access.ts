import { authorizeResearchPortfolioArtifact } from '../research-portfolios/research-portfolio-artifact-authority.js';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
  const rp = generatedFrom as {
    schemaVersion?: unknown;
    artifactId?: unknown;
    actorUserId?: unknown;
    meetingId?: unknown;
  } | null;
  if (rp?.schemaVersion === 'research_portfolio_institutional_v1') {
    if (typeof rp.artifactId !== 'string' || rp.actorUserId !== ctx.userId)
      throw new ForbiddenException('Research Portfolio preparation source access changed');
    const artifact = await tx.clioArtifact.findFirst({
      where: { id: rp.artifactId, tenantId: ctx.tenantId, userId: ctx.userId },
    });
    if (!artifact)
      throw new ForbiddenException('Research Portfolio preparation source is unavailable');
    const { metadata } = await authorizeResearchPortfolioArtifact(tx, ctx, artifact);
    const prepId = metadata.meetingPrepId;
    if (typeof prepId !== 'string')
      throw new ForbiddenException('Research Portfolio preparation binding is unavailable');
    const peek = await tx.meetingPrep.findFirst({
      where: { id: prepId, tenantId: ctx.tenantId },
      select: { meetingId: true },
    });
    if (!peek)
      throw new ForbiddenException('Research Portfolio preparation binding is unavailable');
    // Canonical reassignment locks the meeting before its prep children.
    await tx.$executeRaw`SELECT id FROM meetings WHERE tenant_id=${ctx.tenantId}::uuid AND id=${peek.meetingId}::uuid FOR SHARE`;
    // Serialize RP prep guards with subsequent edits instead of lock upgrades.
    await tx.$executeRaw`SELECT id FROM meeting_preps WHERE tenant_id=${ctx.tenantId}::uuid AND id=${prepId}::uuid FOR UPDATE`;
    const linked = await tx.meetingPrep.findFirst({
      where: { id: prepId, tenantId: ctx.tenantId },
      select: { id: true, meetingId: true, clientId: true, generatedFrom: true },
    });
    const stored = linked?.generatedFrom as {
      schemaVersion?: unknown;
      artifactId?: unknown;
      actorUserId?: unknown;
      meetingId?: unknown;
    } | null;
    if (
      !linked ||
      linked.meetingId !== peek.meetingId ||
      linked.clientId !== null ||
      stored?.schemaVersion !== 'research_portfolio_institutional_v1' ||
      stored.artifactId !== artifact.id ||
      stored.actorUserId !== ctx.userId
    )
      throw new ForbiddenException('Research Portfolio preparation binding changed');
    // Legacy unreleased drafts have a reciprocal artifact/prep ID binding.
    // Derive their meeting from that canonical stored row, never caller JSON.
    // New captures also retain the original meeting ID on both native owners.
    if (
      (rp.meetingId !== undefined && rp.meetingId !== linked.meetingId) ||
      (stored.meetingId !== undefined && stored.meetingId !== linked.meetingId) ||
      (metadata.meetingId !== undefined && metadata.meetingId !== linked.meetingId)
    )
      throw new ForbiddenException('Research Portfolio preparation meeting identity changed');
    const meeting = await tx.meeting.findFirst({
      where: { id: linked.meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
      select: { id: true, clientId: true, isInternal: true },
    });
    if (!meeting || meeting.clientId !== null || meeting.isInternal !== true)
      throw new ForbiddenException(
        'An owned internal meeting is required for this Research Portfolio preparation',
      );
    return;
  }
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

/** Filter only private RP preparations; ordinary preparations retain behavior. */
export async function filterResearchPortfolioMeetingPreps<T extends { generatedFrom?: unknown }>(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  preps: T[],
): Promise<T[]> {
  const visible: T[] = [];
  for (const prep of preps) {
    const provenance = prep.generatedFrom as { schemaVersion?: unknown } | null;
    if (provenance?.schemaVersion === 'research_portfolio_institutional_v1') {
      try {
        await assertSavedMeetingPrepAccess(tx, ctx, provenance);
      } catch (error) {
        if (error instanceof ForbiddenException || error instanceof NotFoundException) continue;
        throw error;
      }
    }
    visible.push(prep);
  }
  return visible;
}
