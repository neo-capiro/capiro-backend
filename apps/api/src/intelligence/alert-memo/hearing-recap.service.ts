import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { ClientDocumentWriterService } from '../../client-documents/client-document-writer.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DOCX_MIME, markdownToMemoDocInput, renderMemoDocx } from './alert-memo-docx.js';
import { renderApprovedHearingRecap } from './approved-hearing-recap-docx.js';

export interface ApprovedHearingRecapInput {
  sessionId: string;
  publicationId: string;
  contentHash: string;
}
interface ApprovedRecapDocument extends ApprovedHearingRecapInput {
  schema: string;
  tenantId: string;
  clientId: string;
  version: number;
  title: string;
  markdown: string;
  approvedAt: string;
}

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

@Injectable()
export class HearingRecapService {
  private readonly logger = new Logger(HearingRecapService.name);

  constructor(
    private readonly documents: ClientDocumentWriterService,
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
        tx.$queryRaw<
          Array<{
            id: string;
            title: string;
            recordingPolicy: string;
            publicCaptureId: string | null;
            recapsEnabled: boolean;
          }>
        >`
        SELECT id, title, recording_policy::text AS "recordingPolicy",
          public_capture_id AS "publicCaptureId",
          EXISTS(SELECT 1 FROM intel_feature_flag f WHERE f.tenant_id=${ctx.tenantId}
            AND f.feature='legiwatch_hearing_recaps_v1' AND f.enabled) AS "recapsEnabled"
        FROM intel_live_hearing_session
        WHERE id = ${sessionId}
          AND tenant_id = ${ctx.tenantId}
          AND recording_policy::text <> 'no_storage'
          AND (
            (source_type::text IN ('hearing', 'markup') AND public_capture_id IS NULL)
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

  private async approvedVersion(
    ctx: TenantContext,
    clientId: string,
    input: ApprovedHearingRecapInput,
    authorization?: string,
    impersonation?: string,
  ) {
    await this.accessibleSession(ctx, input.sessionId);
    const client = await this.clientOrThrow(ctx, clientId);
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException();
    const route = `/intel-api/hearings/${encodeURIComponent(input.sessionId)}/publications/${encodeURIComponent(input.publicationId)}/approved-document?contentHash=${encodeURIComponent(input.contentHash)}`;
    const response = await fetch(
      (process.env.TRACKER_APP_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '') + route,
      {
        headers: {
          authorization,
          ...(impersonation ? { 'x-capiro-impersonate-tenant': impersonation } : {}),
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
    if (!response.ok) throw new ConflictException('APPROVED_RECAP_UNAVAILABLE_OR_ACCESS_CHANGED');
    const approved = (await response.json()) as ApprovedRecapDocument;
    if (
      approved.schema !== 'legiwatch.approved-recap-document.v1' ||
      approved.tenantId !== ctx.tenantId ||
      approved.clientId !== clientId ||
      approved.publicationId !== input.publicationId ||
      approved.sessionId !== input.sessionId ||
      approved.contentHash !== input.contentHash ||
      !Number.isSafeInteger(approved.version) ||
      approved.version < 1 ||
      typeof approved.markdown !== 'string' ||
      approved.markdown.length > 300000 ||
      typeof approved.title !== 'string' ||
      approved.title.length > 200 ||
      !Number.isFinite(Date.parse(approved.approvedAt))
    )
      throw new ServiceUnavailableException('APPROVED_RECAP_CONTRACT_INVALID');
    return { approved, client };
  }

  async exportApproved(
    ctx: TenantContext,
    clientId: string,
    input: ApprovedHearingRecapInput,
    authorization?: string,
    impersonation?: string,
  ) {
    const { approved, client } = await this.approvedVersion(
      ctx,
      clientId,
      input,
      authorization,
      impersonation,
    );
    return {
      buffer: await renderApprovedHearingRecap(approved, client.name),
      fileName: `${approved.title} - v${approved.version}.docx`.replace(/[\\/:*?"<>|]+/g, '-'),
    };
  }

  async saveApproved(
    ctx: TenantContext,
    clientId: string,
    input: ApprovedHearingRecapInput,
    authorization?: string,
    impersonation?: string,
  ) {
    const { approved, client } = await this.approvedVersion(
      ctx,
      clientId,
      input,
      authorization,
      impersonation,
    );
    const buffer = await renderApprovedHearingRecap(approved, client.name);
    // Recheck the approved content and authorization immediately before writing.
    const current = await this.approvedVersion(ctx, clientId, input, authorization, impersonation);
    if (
      current.approved.markdown !== approved.markdown ||
      current.approved.version !== approved.version
    )
      throw new ConflictException('APPROVED_RECAP_CHANGED');
    const saved = await this.documents.createAttachmentFromBuffer(ctx, {
      clientId,
      fileName: `${approved.title} - v${approved.version}.docx`.replace(/[\\/:*?"<>|]+/g, '-'),
      contentType: DOCX_MIME,
      buffer,
      source: 'hearing_recap',
      sourceEntityType: 'hearing_session',
      sourceEntityId: input.sessionId,
      sourceVersion: approved.version,
      sourceContentHash: approved.contentHash,
      idempotencyKey: `approved-hearing-recap:${approved.publicationId}:${approved.contentHash}`,
    });
    return {
      sessionId: input.sessionId,
      publicationId: approved.publicationId,
      contentHash: approved.contentHash,
      version: approved.version,
      reused: saved.reused ?? false,
      document: {
        attachmentId: saved.id,
        fileName: saved.fileName,
        indexedAt: saved.indexedAt ?? null,
      },
    };
  }

  async save(ctx: TenantContext, clientId: string, input: SaveHearingRecapInput) {
    const [client, session] = await Promise.all([
      this.clientOrThrow(ctx, clientId),
      this.accessibleSession(ctx, input.sessionId),
    ]);
    const requireLegacySession = (current: typeof session) => {
      if (
        current.recordingPolicy === 'audio_and_transcript' ||
        current.publicCaptureId ||
        current.recapsEnabled
      )
        throw new ConflictException('APPROVED_HEARING_RECAP_REQUIRED');
    };
    requireLegacySession(session);
    const existing = await this.currentRecap(ctx, clientId, input.sessionId);

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
    requireLegacySession(await this.accessibleSession(ctx, input.sessionId));
    const saved = await this.documents.createAttachmentFromBuffer(ctx, {
      clientId,
      fileName,
      contentType: DOCX_MIME,
      buffer,
      source: 'hearing_recap',
      sourceEntityType: 'hearing_session',
      sourceEntityId: input.sessionId,
    });

    if (input.replaceAttachmentId) {
      await this.documents
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
          AND (s.id IS NULL OR s.recording_policy::text <> 'no_storage')
          AND (
            (s.id IS NULL AND a.uploaded_by_user_id = ${ctx.userId}::uuid)
            OR (s.source_type::text IN ('hearing', 'markup') AND s.public_capture_id IS NULL)
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
