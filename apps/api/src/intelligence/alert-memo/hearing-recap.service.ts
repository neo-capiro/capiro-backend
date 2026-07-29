import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../../engagement/engagement.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DOCX_MIME, markdownToMemoDocInput, renderMemoDocx } from './alert-memo-docx.js';

export interface SaveHearingRecapInput {
  sessionId: string;
  title: string;
  markdown: string;
  replaceAttachmentId?: string;
}

interface RecapCursor {
  t: string;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ t: row.createdAt.toISOString(), id: row.id } satisfies RecapCursor),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(value?: string): RecapCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as RecapCursor;
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
    const date = new Date(parsed.t);
    return Number.isNaN(date.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Files a hearing recap as an ordinary client Document while retaining enough
 * generic provenance to reopen the source session and render a real Saved view.
 * A recap is not an alert memo and does not inherit alert-memo governance.
 */
@Injectable()
export class HearingRecapService {
  private readonly logger = new Logger(HearingRecapService.name);

  constructor(
    private readonly engagement: EngagementService,
    private readonly prisma: PrismaService,
  ) {}

  private async clientOrThrow(ctx: TenantContext, clientId: string) {
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { id: true, name: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  private async accessibleSession(ctx: TenantContext, sessionId: string) {
    const rows = await this.prisma.withTenant(
      ctx.tenantId,
      (tx) =>
        tx.$queryRaw<Array<{ id: string; title: string }>>`
        SELECT id, title
        FROM intel_live_hearing_session
        WHERE id = ${sessionId}
          AND tenant_id = ${ctx.tenantId}
          AND (
            source_type::text IN ('hearing', 'markup')
            OR created_by = ${ctx.clerkUserId}
          )
        LIMIT 1
      `,
    );
    if (!rows[0]) throw new NotFoundException('Live hearing session not found');
    return rows[0];
  }

  private async currentRecap(ctx: TenantContext, clientId: string, sessionId: string) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.findFirst({
        where: {
          tenantId: ctx.tenantId,
          clientId,
          source: 'hearing_recap',
          sourceEntityType: 'hearing_session',
          sourceEntityId: sessionId,
          supersededByAttachmentId: null,
          lifecycleStatus: { notIn: ['delete_pending', 'delete_failed', 'blocked'] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, fileName: true, createdAt: true, indexedAt: true },
      }),
    );
  }

  async save(ctx: TenantContext, clientId: string, input: SaveHearingRecapInput) {
    const [client, session] = await Promise.all([
      this.clientOrThrow(ctx, clientId),
      this.accessibleSession(ctx, input.sessionId),
    ]);
    const existing = await this.currentRecap(ctx, clientId, input.sessionId);

    // A repeated click or retry is idempotent. Regeneration is explicit and must
    // name the current document it replaces.
    if (existing && !input.replaceAttachmentId) {
      return {
        title: input.title,
        sessionId: input.sessionId,
        reused: true,
        document: { attachmentId: existing.id, fileName: existing.fileName },
      };
    }
    if (input.replaceAttachmentId && existing?.id !== input.replaceAttachmentId) {
      throw new NotFoundException('Current hearing recap not found');
    }

    const buffer = await renderMemoDocx(
      markdownToMemoDocInput(input.markdown, client.name, input.title),
    );
    const fileName = `${input.title}.docx`.replace(/[\/:*?"<>|]+/g, '-');
    const saved = await this.engagement.createAttachmentFromBuffer(ctx, {
      clientId,
      fileName,
      contentType: DOCX_MIME,
      buffer,
      source: 'hearing_recap',
      sourceEntityType: 'hearing_session',
      sourceEntityId: input.sessionId,
    });

    if (input.replaceAttachmentId) {
      await this.engagement
        .supersedeAttachment(ctx, input.replaceAttachmentId, saved.id)
        .catch((err) =>
          this.logger.warn(`superseding prior hearing recap failed: ${(err as Error).message}`),
        );
    }

    return {
      title: input.title,
      sessionId: session.id,
      reused: false,
      document: { attachmentId: saved.id, fileName: saved.fileName },
    };
  }

  async list(ctx: TenantContext, clientId: string, opts?: { cursor?: string; limit?: number }) {
    await this.clientOrThrow(ctx, clientId);
    const limit = Math.min(Math.max(Math.floor(opts?.limit ?? 25), 1), 100);
    const cursor = decodeCursor(opts?.cursor);
    const cursorClause = cursor
      ? Prisma.sql`AND (a.created_at < ${new Date(cursor.t)} OR (a.created_at = ${new Date(
          cursor.t,
        )} AND a.id < ${cursor.id}::uuid))`
      : Prisma.sql``;

    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<
        Array<{
          id: string;
          fileName: string;
          indexedAt: Date | null;
          createdAt: Date;
          sessionId: string | null;
          sessionTitle: string | null;
          sourceType: string | null;
        }>
      >(Prisma.sql`
        SELECT
          a.id,
          a.file_name AS "fileName",
          a.indexed_at AS "indexedAt",
          a.created_at AS "createdAt",
          a.source_entity_id AS "sessionId",
          s.title AS "sessionTitle",
          s.source_type::text AS "sourceType"
        FROM engagement_attachments a
        LEFT JOIN intel_live_hearing_session s
          ON a.source_entity_type = 'hearing_session'
         AND s.id = a.source_entity_id
         AND s.tenant_id = a.tenant_id::text
        WHERE a.tenant_id = ${ctx.tenantId}::uuid
          AND a.client_id = ${clientId}::uuid
          AND a.source = 'hearing_recap'
          AND a.superseded_by_attachment_id IS NULL
          AND a.lifecycle_status NOT IN ('delete_pending', 'delete_failed', 'blocked')
          AND (
            (s.id IS NULL AND a.uploaded_by_user_id = ${ctx.userId}::uuid)
            OR s.source_type::text IN ('hearing', 'markup')
            OR s.created_by = ${ctx.clerkUserId}
          )
          ${cursorClause}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit + 1}
      `),
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }
}
