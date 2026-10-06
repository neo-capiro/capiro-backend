'use strict';

// Operator-only library: no HTTP route, scheduler, model, or application bootstrap.
// Caller resolves one exact tenant/user, supplies their personal OAuth connection,
// and invokes the same consent checks and atomic direct-notes importer as the worker.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  krispRows,
  normalizeKrispMeeting,
  matchKrispMeeting,
  krispNextPage,
  krispNotes,
} = require('../../dist/engagement/krisp/krisp.helpers.js');
const { ownMeetingWhere } = require('../../dist/engagement/engagement-access.helpers.js');

async function backfillKrisp({
  prisma,
  service,
  crypto,
  ctx,
  preference,
  since,
  until,
  apply = false,
  createHistorical = false,
  progress = () => {},
}) {
  assert.ok(since instanceof Date && until instanceof Date && since < until && until <= new Date());
  assert.equal(preference.tenantId, ctx.tenantId);
  assert.equal(preference.userId, ctx.userId);
  const scope = { tenantId: ctx.tenantId, userId: ctx.userId };
  const result = {
    apply,
    since: since.toISOString(),
    until: until.toISOString(),
    discovered: 0,
    ready: 0,
    completed: 0,
    alreadyDone: 0,
    missingNotes: 0,
    needsMatch: 0,
    historical: 0,
    failed: 0,
  };
  const seen = new Set();
  const cursors = new Set();
  const documents = [];
  let offset = 0,
    cursor;
  // Finish discovery before writes: changes in our DB cannot affect provider pagination.
  for (let page = 0; page < 200; page++) {
    await service.assertActive(ctx, preference);
    const payload = await service.read(ctx, 'search_meetings', {
      since: since.toISOString(),
      until: until.toISOString(),
      folderId: preference.folderId,
      offset,
      page: page + 1,
      cursor,
    });
    const rows = krispRows(payload, ['meetings', 'results', 'items', 'documents']);
    for (const row of rows) {
      const source = normalizeKrispMeeting(row);
      assert.ok(source, 'Unsupported meeting metadata');
      if (source.startsAt < since || source.startsAt > until || seen.has(source.documentId))
        continue;
      seen.add(source.documentId);
      documents.push(source);
    }
    const next = krispNextPage(payload, rows.length, offset);
    if (!next.more) break;
    assert.ok(rows.length && page < 199, 'Incomplete provider pagination');
    offset += rows.length;
    if (next.cursor) {
      assert.ok(!cursors.has(next.cursor), 'Repeated provider cursor');
      cursors.add(next.cursor);
    }
    cursor = next.cursor;
  }
  result.discovered = documents.length;
  progress({ ...result });
  for (const source of documents) {
    await service.assertActive(ctx, preference);
    const unique = { tenantId_userId_documentId: { ...scope, documentId: source.documentId } };
    const existing = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.krispMeetingImport.findUnique({ where: unique }),
    );
    if (existing?.status === 'done') {
      result.alreadyDone++;
      continue;
    }
    // Never steal a current worker lease, revive an explicitly skipped import, or overwrite artifacts.
    if (
      existing?.status === 'skipped' ||
      existing?.noteId ||
      existing?.debriefId ||
      (existing?.status === 'processing' && existing.leaseUntil > new Date())
    ) {
      result.failed++;
      continue;
    }
    const body = krispNotes(
      await service.read(ctx, 'get_multiple_documents', { ids: [source.documentId] }),
      source.documentId,
    );
    if (!body) {
      result.missingNotes++;
      continue;
    }
    result.ready++;
    const planned = await prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const candidates = await tx.meeting.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...ownMeetingWhere(ctx.userId),
          startsAt: {
            gte: new Date(source.startsAt.getTime() - 600000),
            lte: new Date(source.startsAt.getTime() + 600000),
          },
        },
      });
      const externalId = `krisp:${ctx.userId}:${source.documentId}`;
      const historical = candidates.find(
        (m) => m.source === 'manual' && m.externalId === externalId,
      );
      const matched =
        existing?.meetingId ?? historical?.id ?? matchKrispMeeting(source, candidates);
      return { meetingId: matched, externalId };
    });
    if (!planned.meetingId && (!createHistorical || !source.endsAt)) {
      result.needsMatch++;
      continue;
    }
    if (!planned.meetingId) result.historical++;
    if (!apply) {
      progress({ ...result });
      continue;
    }
    const item = await prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM krisp_notetaker_preferences WHERE id = ${preference.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM clio_mcp_servers WHERE id = ${preference.serverId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${ctx.tenantId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT user_id FROM tenant_memberships WHERE tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid FOR SHARE`;
      await service.assertActiveTx(tx, ctx, preference);
      const current = await tx.krispMeetingImport.findUnique({ where: unique });
      if (
        current?.status === 'done' ||
        current?.status === 'skipped' ||
        current?.noteId ||
        current?.debriefId ||
        (current?.status === 'processing' && current.leaseUntil > new Date())
      )
        return current;
      let meetingId = current?.meetingId ?? planned.meetingId;
      if (!meetingId) {
        // Deterministic identity allows safe restart; preserve any subsequently edited meeting.
        const meeting = await tx.meeting.upsert({
          where: {
            tenantId_source_externalId: {
              tenantId: ctx.tenantId,
              source: 'manual',
              externalId: planned.externalId,
            },
          },
          create: {
            tenantId: ctx.tenantId,
            source: 'manual',
            externalId: planned.externalId,
            subject: source.title,
            startsAt: source.startsAt,
            endsAt: source.endsAt,
            status: 'completed',
            visibility: 'private',
            createdByUserId: ctx.userId,
            clientId: null,
            metadata: { importedFrom: 'krisp', krispDocumentId: source.documentId },
          },
          update: {},
        });
        meetingId = meeting.id;
      }
      const owned = await tx.meeting.findFirst({
        where: { tenantId: ctx.tenantId, id: meetingId, ...ownMeetingWhere(ctx.userId) },
      });
      assert.ok(owned, 'Meeting ownership changed');
      return tx.krispMeetingImport.upsert({
        where: unique,
        create: {
          ...scope,
          documentId: source.documentId,
          title: source.title,
          startsAt: source.startsAt,
          meetingId,
          status: 'pending',
        },
        update: {
          meetingId,
          status: 'pending',
          attempts: 0,
          leaseToken: null,
          leaseUntil: null,
          error: null,
        },
      });
    });
    await service.process(ctx, preference, item.id);
    const saved = await prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const imported = await tx.krispMeetingImport.findUnique({ where: unique });
      if (imported.status !== 'done') return null;
      const note = await tx.meetingNote.findFirst({
        where: {
          id: imported.noteId,
          tenantId: ctx.tenantId,
          authorUserId: ctx.userId,
          meetingId: imported.meetingId,
        },
      });
      const debrief = await tx.meetingDebrief.findFirst({
        where: {
          id: imported.debriefId,
          tenantId: ctx.tenantId,
          authorUserId: ctx.userId,
          meetingId: imported.meetingId,
        },
      });
      assert.ok(note && debrief, 'Missing imported pair');
      assert.equal(crypto.decrypt(note), crypto.decrypt(debrief), 'Notes and debrief differ');
      return createHash('sha256').update(crypto.decrypt(note)).digest('hex');
    });
    if (saved) {
      assert.equal(
        saved,
        createHash('sha256').update(body).digest('hex'),
        'Saved text differs from Krisp notes',
      );
      result.completed++;
    } else result.failed++;
    progress({ ...result });
  }
  return result;
}

module.exports = { backfillKrisp };
