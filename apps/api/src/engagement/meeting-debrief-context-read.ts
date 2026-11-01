import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { canReadEncryptedEntry, ownMeetingWhere } from './engagement-access.helpers.js';
import { currentMeetingActor, assertMeetingClient } from './meeting-resource-authority.js';
import { debriefContextSummarySchema } from './meeting-command.input.js';

/** Read provenance only for one currently readable saved artifact, never a list/share DTO. */
export function readMeetingDebriefContext(
  prisma: PrismaService,
  ctx: TenantContext,
  meetingId: string,
  debriefId: string,
) {
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const actor = await currentMeetingActor(tx, ctx);
    const meeting = await tx.meeting.findFirst({
      where: { id: meetingId, tenantId: actor.tenantId, ...ownMeetingWhere(actor.userId) },
      select: { id: true, clientId: true },
    });
    if (!meeting) throw new NotFoundException('Meeting debrief not found');
    await assertMeetingClient(tx, actor, meeting.clientId);
    const debrief = await tx.meetingDebrief.findFirst({
      where: { id: debriefId, tenantId: actor.tenantId, meetingId, clientId: meeting.clientId },
      select: {
        id: true,
        meetingId: true,
        clientId: true,
        updatedAt: true,
        confidential: true,
        accessLevel: true,
        authorUserId: true,
        generatedFromJsonb: true,
      },
    });
    if (!debrief || !canReadEncryptedEntry(actor, debrief))
      throw new NotFoundException('Meeting debrief not found');
    const parsed =
      debrief.generatedFromJsonb == null
        ? null
        : debriefContextSummarySchema.safeParse(debrief.generatedFromJsonb);
    if (parsed && !parsed.success)
      throw new ServiceUnavailableException('Saved generation context is unavailable.');
    return {
      id: debrief.id,
      meetingId: debrief.meetingId,
      clientId: debrief.clientId,
      revision: debrief.updatedAt.toISOString(),
      generatedFrom: parsed?.data ?? null,
    };
  });
}
