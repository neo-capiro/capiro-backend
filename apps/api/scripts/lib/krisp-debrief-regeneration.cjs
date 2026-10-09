'use strict';

const { createHash } = require('node:crypto');
const { ownMeetingWhere } = require('../../dist/engagement/engagement-access.helpers.js');

const digest = (body) => createHash('sha256').update(body).digest('hex');
const sameEncryptedBody = (a, b) =>
  a.bodyCiphertext === b.bodyCiphertext && a.iv === b.iv && a.authTag === b.authTag;

/** Convert only untouched, unshared C2 Krisp copies. Safe to rerun after interruption. */
async function regenerateC2KrispDebriefs({
  prisma,
  service,
  crypto,
  generate,
  format,
  ctx,
  preference,
  apply = false,
  limit = Infinity,
  progress = () => {},
}) {
  if (ctx.tenantSlug !== 'c2-strategies' || preference.tenantId !== ctx.tenantId ||
      preference.userId !== ctx.userId)
    throw new Error('C2 tenant and connection scope required.');
  const result = { scanned: 0, eligible: 0, converted: 0, changed: 0, missing: 0, failed: 0 };
  let cursor;
  while (result.scanned < limit) {
    const batch = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.krispMeetingImport.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'done',
          noteId: { not: null }, debriefId: { not: null } },
        orderBy: { id: 'asc' }, take: Math.min(50, limit - result.scanned),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
    if (!batch.length) break;
    for (const item of batch) {
      cursor = item.id;
      result.scanned++;
      if ((await service.assertActive(ctx, preference)) !== 'direct_notes')
        throw new Error('C2 Krisp authorization or mode changed.');
      const pair = await prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const [note, debrief, meeting] = await Promise.all([
          tx.meetingNote.findFirst({ where: { id: item.noteId, tenantId: ctx.tenantId,
            meetingId: item.meetingId, authorUserId: ctx.userId } }),
          tx.meetingDebrief.findFirst({ where: { id: item.debriefId, tenantId: ctx.tenantId,
            meetingId: item.meetingId, authorUserId: ctx.userId } }),
          tx.meeting.findFirst({ where: { id: item.meetingId, tenantId: ctx.tenantId,
            ...ownMeetingWhere(ctx.userId) } }),
        ]);
        return { note, debrief, meeting };
      });
      const { note, debrief, meeting } = pair;
      if (!note || !debrief || !meeting) { result.missing++; continue; }
      // Imported pairs shared one encrypted payload. A different payload means
      // this debrief was already regenerated or someone edited it.
      if (debrief.sharedAt || !sameEncryptedBody(note, debrief)) {
        result.changed++;
        continue;
      }
      const sourceText = crypto.decrypt(note);
      if (!sourceText.trim()) { result.failed++; continue; }
      result.eligible++;
      if (!apply) continue;
      try {
        const body = format(await generate(ctx, meeting.id, sourceText));
        if (!body.trim()) throw new Error('Empty generated debrief.');
        const encrypted = crypto.encrypt(body);
        const count = await prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
          await tx.$queryRaw`SELECT id FROM krisp_notetaker_preferences WHERE id = ${preference.id}::uuid FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM clio_mcp_servers WHERE id = ${preference.serverId}::uuid FOR SHARE`;
          await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${ctx.tenantId}::uuid FOR SHARE`;
          await tx.$queryRaw`SELECT user_id FROM tenant_memberships WHERE tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid FOR SHARE`;
          await tx.$queryRaw`SELECT id FROM meetings WHERE id = ${meeting.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
          if ((await service.assertActiveTx(tx, ctx, preference)) !== 'direct_notes')
            throw new Error('C2 Krisp authorization or mode changed.');
          const [currentNote, currentDebrief, currentMeeting] = await Promise.all([
            tx.meetingNote.findFirst({ where: { id: note.id, tenantId: ctx.tenantId,
              meetingId: meeting.id, authorUserId: ctx.userId } }),
            tx.meetingDebrief.findFirst({ where: { id: debrief.id, tenantId: ctx.tenantId,
              meetingId: meeting.id, authorUserId: ctx.userId } }),
            tx.meeting.findFirst({ where: { id: meeting.id, tenantId: ctx.tenantId,
              ...ownMeetingWhere(ctx.userId) } }),
          ]);
          if (!currentNote || !currentDebrief || !currentMeeting ||
              currentMeeting.clientId !== meeting.clientId ||
              digest(crypto.decrypt(currentNote)) !== digest(sourceText) ||
              currentDebrief.sharedAt || !sameEncryptedBody(currentNote, currentDebrief))
            return 0;
          const updated = await tx.meetingDebrief.updateMany({
            where: { id: debrief.id, tenantId: ctx.tenantId, meetingId: meeting.id,
              authorUserId: ctx.userId, updatedAt: debrief.updatedAt, sharedAt: null },
            data: encrypted,
          });
          return updated.count;
        });
        if (count) result.converted++;
        else result.changed++;
      } catch {
        // Keep the original debrief and allow a bounded operator rerun.
        result.failed++;
      }
      progress({ ...result });
    }
  }
  return result;
}

module.exports = { regenerateC2KrispDebriefs };
