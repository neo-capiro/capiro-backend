import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import mammoth from 'mammoth';
import type { Prisma } from '@prisma/client';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { extractPdfText } from '../meri/meri-attachment-extract.js';
import { AttachmentContentService, type AttachmentReadinessRow } from '../engagement/attachment-content.service.js';
import { ownMailMessageWhere, ownMeetingWhere } from '../engagement/engagement-access.helpers.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import {
  EMBEDDING_MODEL,
  embedAndUpsert,
  embedText,
  normalize,
  vectorLiteral,
} from './embedder.js';
import {
  KB_MAX_CHUNKS_PER_CLIENT,
  KB_MAX_CHUNKS_PER_DOC,
  KB_SOURCE_TYPES,
  buildClientFacilityText,
  buildClientPersonText,
  buildClientProfileText,
  buildDocChunkText,
  buildKbSnapshot,
  chunkDocumentText,
  docChunkSourceId,
  docChunkSourceIdPrefix,
  type KbSourceType,
} from './client-kb.helpers.js';

type AttachmentIndexSnapshot = {
  id: string;
  clientId: string | null;
  meetingId: string | null;
  s3Key: string;
  viewerMode: string;
  lifecycleStatus: string;
  scanStatus: string | null;
  supersededByAttachmentId: string | null;
  fileName: string;
  contentType: string | null;
};

const attachmentReadiness = new AttachmentContentService();

/**
 * Client knowledge base (assistant-parity F5).
 *
 * One indexing pipeline, four source types into context_embeddings (all rows
 * tenant- AND client-scoped): client_profile, client_person, client_facility,
 * client_doc_chunk (EngagementAttachment text via the same extractors the chat
 * attachment path uses, chunked ~1k tokens / 15% overlap).
 *
 * Lives in the embeddings module so write-path modules (clients, engagement)
 * can fire lifecycle hooks without importing the Meri module; Meri consumes
 * retrieval (search_client_knowledge tool) and the always-on snapshot.
 *
 * Encrypted meeting notes never enter this index: the service reads only
 * Client / ClientPerson / ClientFacility / EngagementAttachment (S3 bytes).
 * All fire-and-forget hooks are fail-open — a Bedrock or S3 blip never fails
 * the user's mutation.
 */
@Injectable()
export class ClientKbService {
  private readonly logger = new Logger(ClientKbService.name);
  private readonly s3: S3Client;
  private readonly bucket: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.s3 = new S3Client({ region: this.config.get('AWS_REGION_DEFAULT', { infer: true }) });
    this.bucket = this.config.get('ASSETS_BUCKET', { infer: true });
  }

  private enabled(): boolean {
    return this.config.get('CLIO_CLIENT_KB_ENABLED', { infer: true });
  }

  private documentReady(row: AttachmentReadinessRow): boolean {
    return ['ready', 'legacy_ready'].includes(row.lifecycleStatus)
      && attachmentReadiness.readiness(row,
        this.config.get('ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED', { infer: true })).usable;
  }

  private canIndexDocument(row: AttachmentIndexSnapshot): boolean {
    // This shared index is consumed without a document-specific user context.
    // Private source bodies stay in the authorized document reader.
    return row.viewerMode === 'all' && row.supersededByAttachmentId === null
      && this.documentReady({ ...row, contentType: row.contentType ?? '' });
  }

  private async visibleDocuments(tx: Prisma.TransactionClient, tenantId: string,
    clientId: string, userId?: string, limit?: number) {
    if (!userId) return [];
    // Snapshot reads need only five filenames. Exclude unusable rows before
    // applying that bound so newer quarantined files cannot crowd them out.
    // The canonical readiness check below remains authoritative.
    const readinessFilter: Prisma.EngagementAttachmentWhereInput = limit === undefined ? {} : {
      lifecycleStatus: { in: ['ready', 'legacy_ready'] },
      ...(this.config.get('ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED', { infer: true })
        ? { scanStatus: 'clean' }
        : { OR: [{ scanStatus: null }, { scanStatus: { not: 'threat' } }] }),
    };
    const rows = await tx.engagementAttachment.findMany({
      where: { tenantId, clientId, supersededByAttachmentId: null,
        ...readinessFilter,
        AND: [
          { OR: [{ viewerMode: 'all' }, { viewerMode: 'restricted', viewerUserIds: { has: userId } },
            { uploadedByUserId: userId }] },
          { OR: [{ meetingId: null }, { meeting: ownMeetingWhere(userId) }] },
          { OR: [{ mailMessageId: null }, { mailMessage: ownMailMessageWhere(userId) }] },
        ],
      },
      select: { id: true, fileName: true, createdAt: true, contentType: true,
        lifecycleStatus: true, scanStatus: true, verifiedContentType: true },
      orderBy: { createdAt: 'desc' },
      ...(limit === undefined ? {} : { take: limit }),
    });
    return rows.filter(row => this.documentReady({ ...row, contentType: row.contentType ?? '' }));
  }

  // ── Fire-and-forget lifecycle hooks (called from write paths) ───────────

  indexClientProfileFireAndForget(tenantId: string, clientId: string): void {
    if (!this.enabled()) return;
    setImmediate(() => {
      this.indexClientProfile(tenantId, clientId).catch((err) =>
        this.logger.warn(`KB profile index failed [${clientId}]: ${(err as Error).message}`),
      );
    });
  }

  indexPersonFireAndForget(tenantId: string, personId: string): void {
    if (!this.enabled()) return;
    setImmediate(() => {
      this.indexPerson(tenantId, personId).catch((err) =>
        this.logger.warn(`KB person index failed [${personId}]: ${(err as Error).message}`),
      );
    });
  }

  indexFacilityFireAndForget(tenantId: string, facilityId: string): void {
    if (!this.enabled()) return;
    setImmediate(() => {
      this.indexFacility(tenantId, facilityId).catch((err) =>
        this.logger.warn(`KB facility index failed [${facilityId}]: ${(err as Error).message}`),
      );
    });
  }

  indexAttachmentFireAndForget(tenantId: string, attachmentId: string): void {
    if (!this.enabled()) return;
    setImmediate(() => {
      this.indexAttachment(tenantId, attachmentId).catch((err) =>
        this.logger.warn(`KB doc index failed [${attachmentId}]: ${(err as Error).message}`),
      );
    });
  }

  purgeFireAndForget(tenantId: string, sourceType: KbSourceType, sourceId: string): void {
    setImmediate(() => {
      this.purge(tenantId, sourceType, sourceId).catch((err) =>
        this.logger.warn(`KB purge failed [${sourceType}/${sourceId}]: ${(err as Error).message}`),
      );
    });
  }

  // ── Indexers ─────────────────────────────────────────────────────────────

  async indexClientProfile(tenantId: string, clientId: string): Promise<void> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: {
          id: true,
          name: true,
          description: true,
          productDescription: true,
          sectorTag: true,
          issueCodes: true,
          uei: true,
          naicsCodes: true,
          pscCodes: true,
          intakeData: true,
        },
      }),
    );
    if (!client) {
      await this.purge(tenantId, 'client_profile', clientId);
      return;
    }
    await embedAndUpsert(this.prisma, {
      tenantId,
      clientId,
      sourceType: 'client_profile',
      sourceId: clientId,
      text: normalize(buildClientProfileText(client)),
      bypassRls: true,
    });
  }

  async indexPerson(tenantId: string, personId: string): Promise<void> {
    const person = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientPerson.findFirst({
        where: { id: personId },
        select: {
          id: true,
          clientId: true,
          name: true,
          title: true,
          role: true,
          email: true,
          phone: true,
          lastContact: true,
          notes: true,
          client: { select: { name: true } },
        },
      }),
    );
    if (!person) {
      await this.purge(tenantId, 'client_person', personId);
      return;
    }
    await embedAndUpsert(this.prisma, {
      tenantId,
      clientId: person.clientId,
      sourceType: 'client_person',
      sourceId: personId,
      text: normalize(
        buildClientPersonText({ ...person, clientName: person.client?.name ?? 'client' }),
      ),
      bypassRls: true,
    });
  }

  async indexFacility(tenantId: string, facilityId: string): Promise<void> {
    const facility = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientFacility.findFirst({
        where: { id: facilityId },
        select: {
          id: true,
          clientId: true,
          name: true,
          addressLine: true,
          city: true,
          state: true,
          zip: true,
          congressionalDistrict: true,
          employeeCount: true,
          notes: true,
          client: { select: { name: true } },
        },
      }),
    );
    if (!facility) {
      await this.purge(tenantId, 'client_facility', facilityId);
      return;
    }
    await embedAndUpsert(this.prisma, {
      tenantId,
      clientId: facility.clientId,
      sourceType: 'client_facility',
      sourceId: facilityId,
      text: normalize(
        buildClientFacilityText({ ...facility, clientName: facility.client?.name ?? 'client' }),
      ),
      bypassRls: true,
    });
  }

  /**
   * Index one client document (EngagementAttachment): download from S3,
   * extract text (same pdf/docx/text extractors as chat attachments), chunk,
   * embed each chunk. Images index by filename + meeting context only (v1).
   * Always purges first so a re-uploaded/changed doc never leaves stale
   * chunks behind.
   */
  async indexAttachment(tenantId: string, attachmentId: string): Promise<void> {
    const attachment = await this.prisma.withTenant(tenantId, (tx) =>
      tx.engagementAttachment.findFirst({
        where: { id: attachmentId },
        select: {
          id: true,
          clientId: true,
          fileName: true,
          contentType: true,
          s3Key: true,
          meetingId: true,
          createdAt: true,
          viewerMode: true,
          lifecycleStatus: true,
          scanStatus: true,
          supersededByAttachmentId: true,
        },
      }),
    );
    if (!attachment) {
      await this.purge(tenantId, 'client_doc_chunk', attachmentId);
      return;
    }
    if (!this.canIndexDocument(attachment)) {
      await this.purge(tenantId, 'client_doc_chunk', attachmentId);
      return;
    }
    if (!attachment.clientId) {
      await this.prisma.withTenant(tenantId, async (tx) => {
        if (await this.lockAttachmentSnapshot(tx, tenantId, attachment)) {
          await this.purgeAttachmentChunks(tx, tenantId, attachmentId);
        }
      });
      return;
    }
    const quota = await this.countClientChunks(tenantId, attachment.clientId);
    if (quota >= KB_MAX_CHUNKS_PER_CLIENT) {
      this.logger.warn(
        `KB chunk quota reached for client ${attachment.clientId} (${quota}); skipping ${attachmentId}`,
      );
      return;
    }

    const clientName = await this.clientName(tenantId, attachment.clientId);
    const meetingSubject = attachment.meetingId
      ? await this.prisma
          .withTenant(tenantId, (tx) =>
            tx.meeting.findFirst({
              where: { id: attachment.meetingId ?? undefined },
              select: { subject: true },
            }),
          )
          .then((m) => m?.subject ?? null)
          .catch(() => null)
      : null;

    // Clear a prior success before any operation which may fail. Filename-only
    // embeddings are useful for discovery but are not searchable document text.
    const started = await this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await this.lockAttachmentSnapshot(tx, tenantId, attachment))) return false;
      await tx.engagementAttachment.update({
        where: { id: attachmentId }, data: { indexedAt: null },
      });
      return true;
    });
    if (!started) return;
    let extraction: Awaited<ReturnType<ClientKbService['extractAttachmentTextForKb']>>;
    try {
      extraction = await this.extractAttachmentTextForKb(attachment);
    } catch (error) {
      await this.prisma.withTenant(tenantId, async (tx) => {
        if (!(await this.lockAttachmentSnapshot(tx, tenantId, attachment))) return;
        await tx.engagementAttachment.update({
          where: { id: attachmentId }, data: {
            indexedAt: null, extractionStatus: 'failed',
            extractionMetadata: { chars: 0, contentScope: 'unavailable', reason: 'text_extraction_failed' },
          },
        });
      });
      throw error;
    }
    // Retain previous chunks if S3/parsing failed. Only replace evidence once
    // its current bytes were actually read (including a confirmed empty result).
    const current = await this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await this.lockAttachmentSnapshot(tx, tenantId, attachment))) return false;
      await this.purgeAttachmentChunks(tx, tenantId, attachmentId);
      return true;
    });
    if (!current) return;
    const text = extraction?.text?.trim() || null;
    const chunks = text
      ? chunkDocumentText(text)
      : [`Image or non-text attachment: ${attachment.fileName}`];
    const contentTruncated = Boolean(extraction?.truncated) || chunks.length >= KB_MAX_CHUNKS_PER_DOC;
    for (let i = 0; i < chunks.length; i += 1) {
      let sourceCurrent = true;
      await embedAndUpsert(this.prisma, {
        tenantId,
        clientId: attachment.clientId,
        sourceType: 'client_doc_chunk',
        sourceId: docChunkSourceId(attachmentId, i),
        text: normalize(
          buildDocChunkText({
            clientName,
            fileName: attachment.fileName,
            chunk: chunks[i] ?? '',
            chunkIndex: i,
            chunkCount: chunks.length,
            meetingSubject,
          }),
        ),
        bypassRls: true,
        beforeWrite: async (tx) => {
          sourceCurrent = await this.lockAttachmentSnapshot(tx, tenantId, attachment);
          return sourceCurrent;
        },
      });
      if (!sourceCurrent) return;
    }

    // Stamp content as indexed (Meetings v2 §5) — reached only after the
    // whole chunk loop succeeds, so the two early returns above (missing/no-client,
    // quota exceeded) correctly leave indexedAt null. Drives the Documents-tab
    // per-file "Indexed" badge. withTenant (not withSystem): the row is
    // tenant-scoped and RLS must allow the UPDATE for this tenant.
    await this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await this.lockAttachmentSnapshot(tx, tenantId, attachment))) return;
      await tx.engagementAttachment.update({
        where: { id: attachmentId },
        data: {
          indexedAt: text ? new Date() : null,
          extractionStatus: !text ? 'empty' : contentTruncated ? 'truncated' : 'extracted',
          extractionMetadata: {
            chars: text?.length ?? 0,
            contentScope: text ? 'extractable_text_only' : 'metadata_only',
            truncated: contentTruncated,
            indexedChunks: text ? chunks.length : 0,
            pages: extraction?.pages ?? null, pagesRead: extraction?.pagesRead ?? null,
            needsVisualRead: !text && /pdf/i.test(attachment.contentType ?? attachment.fileName),
            note: text
              ? 'Text indexed; images and diagrams require a visual page read.'
              : 'Only file metadata is searchable. Document contents have not been read.',
            extractedAt: new Date().toISOString(),
          },
        },
      });
    });
  }

  /** Parent first, then attachment: same lock order as meeting reassignment.
   * Keep these locks until the caller's write/purge/stamp commits. Checking
   * before S3 or embedding calls would leave a window for an old job to write
   * its previous client's evidence after reassignment already purged it. */
  private async lockAttachmentSnapshot(
    tx: Prisma.TransactionClient,
    tenantId: string,
    snapshot: AttachmentIndexSnapshot,
  ): Promise<boolean> {
    if (snapshot.meetingId) {
      const meetings = await tx.$queryRawUnsafe<Array<{ clientId: string | null; isInternal: boolean }>>(
        `SELECT client_id AS "clientId", is_internal AS "isInternal" FROM meetings
          WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        tenantId, snapshot.meetingId,
      );
      if (!meetings[0] || meetings[0].clientId !== snapshot.clientId
        || (snapshot.clientId !== null && meetings[0].isInternal)) return false;
    }
    const attachments = await tx.$queryRawUnsafe<AttachmentIndexSnapshot[]>(
      `SELECT id, client_id AS "clientId", meeting_id AS "meetingId", s3_key AS "s3Key",
              viewer_mode AS "viewerMode", lifecycle_status AS "lifecycleStatus",
              scan_status AS "scanStatus", superseded_by_attachment_id AS "supersededByAttachmentId",
              file_name AS "fileName", content_type AS "contentType"
        FROM engagement_attachments WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
      tenantId, snapshot.id,
    );
    const current = attachments[0];
    return Boolean(current && this.canIndexDocument(current) && current.clientId === snapshot.clientId
      && current.meetingId === snapshot.meetingId && current.s3Key === snapshot.s3Key);
  }

  private async purgeAttachmentChunks(tx: Prisma.TransactionClient, tenantId: string, attachmentId: string): Promise<void> {
    await tx.$executeRawUnsafe(
      `DELETE FROM context_embeddings
        WHERE tenant_id = $1::uuid AND source_type = $2
          AND (source_id = $3 OR source_id LIKE $4)`,
      tenantId, 'client_doc_chunk', attachmentId, docChunkSourceIdPrefix(attachmentId),
    );
  }

  /** S3 download + text extraction; null for image/unsupported kinds. */
  private async extractAttachmentTextForKb(attachment: {
    fileName: string;
    contentType: string | null;
    s3Key: string;
  }): Promise<{ text: string; truncated: boolean; pages?: number; pagesRead?: number } | null> {
    if (!this.bucket) throw new Error('Document storage is not configured');
    const name = attachment.fileName.toLowerCase();
    const ct = (attachment.contentType ?? '').toLowerCase();
    const isPdf = ct === 'application/pdf' || name.endsWith('.pdf');
    const isDocx =
      ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      name.endsWith('.docx');
    const isText =
      ct.startsWith('text/') ||
      name.endsWith('.txt') ||
      name.endsWith('.md') ||
      name.endsWith('.csv');
    if (!isPdf && !isDocx && !isText) return null;
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: attachment.s3Key }),
    );
    const bytes = Buffer.from(await res.Body!.transformToByteArray());
    if (isText) return { text: bytes.toString('utf8'), truncated: false };
    if (isDocx) return { text: (await mammoth.extractRawText({ buffer: bytes })).value, truncated: false };
    const extracted = await extractPdfText(bytes);
    return { ...extracted,
      truncated: extracted.truncated || extracted.unreadablePages.length > 0 };
  }

  // ── Purge / status / backfill ────────────────────────────────────────────

  /** Delete index rows for a source (doc purge sweeps every chunk). */
  async purge(tenantId: string, sourceType: KbSourceType, sourceId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      sourceType === 'client_doc_chunk'
        ? tx.$executeRawUnsafe(
            `DELETE FROM context_embeddings
              WHERE tenant_id = $1::uuid AND source_type = $2
                AND (source_id = $3 OR source_id LIKE $4)`,
            tenantId,
            sourceType,
            sourceId,
            docChunkSourceIdPrefix(sourceId),
          )
        : tx.$executeRawUnsafe(
            `DELETE FROM context_embeddings
              WHERE tenant_id = $1::uuid AND source_type = $2 AND source_id = $3`,
            tenantId,
            sourceType,
            sourceId,
          ),
    );
  }

  private async countClientChunks(tenantId: string, clientId: string): Promise<number> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*) AS count FROM context_embeddings
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND source_type = 'client_doc_chunk'`,
        tenantId,
        clientId,
      ),
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async clientName(tenantId: string, clientId: string): Promise<string> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { name: true } }),
    );
    return client?.name ?? 'client';
  }

  /** Index status for the Documents-tab chip. */
  async indexStatus(
    tenantId: string,
    clientId: string,
  ): Promise<{ counts: Record<string, number>; lastIndexedAt: string | null }> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ source_type: string; count: bigint; last: Date | null }>>(
        `SELECT source_type, COUNT(*) AS count, MAX(updated_at) AS last
           FROM context_embeddings
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            AND source_type IN (${KB_SOURCE_TYPES.map((t) => `'${t}'`).join(', ')})
          GROUP BY source_type`,
        tenantId,
        clientId,
      ),
    );
    const counts: Record<string, number> = {};
    let last: Date | null = null;
    for (const row of rows) {
      counts[row.source_type] = Number(row.count);
      if (row.last && (!last || row.last > last)) last = row.last;
    }
    return { counts, lastIndexedAt: last ? last.toISOString() : null };
  }

  /** Re-index everything for one client (manual backfill / repair). */
  async backfillClient(
    tenantId: string,
    clientId: string,
  ): Promise<{ profile: number; people: number; facilities: number; documents: number }> {
    const result = { profile: 0, people: 0, facilities: 0, documents: 0 };
    await this.indexClientProfile(tenantId, clientId);
    result.profile = 1;
    const people = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientPerson.findMany({ where: { clientId }, select: { id: true } }),
    );
    for (const p of people) {
      await this.indexPerson(tenantId, p.id);
      result.people += 1;
    }
    const facilities = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientFacility.findMany({ where: { clientId }, select: { id: true } }),
    );
    for (const f of facilities) {
      await this.indexFacility(tenantId, f.id);
      result.facilities += 1;
    }
    const docs = await this.prisma.withTenant(tenantId, (tx) =>
      tx.engagementAttachment.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      }),
    );
    for (const d of docs) {
      await this.indexAttachment(tenantId, d.id);
      result.documents += 1;
    }
    return result;
  }

  /** Batched tenant backfill (used by the ops script). */
  async backfillTenant(tenantId: string): Promise<number> {
    const clients = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findMany({ where: { status: { not: 'archived' } }, select: { id: true } }),
    );
    for (const c of clients) {
      await this.backfillClient(tenantId, c.id).catch((err) =>
        this.logger.warn(`KB backfill failed [client ${c.id}]: ${(err as Error).message}`),
      );
    }
    return clients.length;
  }

  // ── Retrieval ────────────────────────────────────────────────────────────

  async search(
    tenantId: string,
    input: { query: string; clientId: string; kind?: string; limit?: number; userId?: string },
  ): Promise<Array<{ kind: string; id: string; title: string; snippet: string; score: number }>> {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
    const kindFilter =
      input.kind && (KB_SOURCE_TYPES as readonly string[]).includes(input.kind) ? input.kind : null;
    const vector = await embedText(normalize(input.query));
    const literal = vectorLiteral(vector);
    const rows = await this.prisma.withTenant(tenantId, async (tx) => {
      if (!await clientMemoryAllowed(tx, tenantId, input.userId ?? null, input.clientId)) return [];
      const allowedDocuments = await this.visibleDocuments(tx, tenantId, input.clientId, input.userId);
      return tx.$queryRawUnsafe<
        Array<{ source_type: string; source_id: string; content_text: string; score: number }>
      >(
        `SELECT source_type, source_id, content_text,
                1 - (embedding <=> '${literal}'::vector) AS score
           FROM context_embeddings
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            AND source_type IN (${KB_SOURCE_TYPES.map((t) => `'${t}'`).join(', ')})
            AND ($4::text IS NULL OR source_type = $4::text)
            AND (source_type <> 'client_doc_chunk' OR split_part(source_id, ':', 1) = ANY($5::text[]))
            AND model = $3
          ORDER BY embedding <=> '${literal}'::vector
          LIMIT ${limit}`,
        ...([
          tenantId,
          input.clientId,
          EMBEDDING_MODEL,
          kindFilter,
          allowedDocuments.map(document => document.id),
        ] as unknown[]),
      );
    });
    return rows
      .filter((r) => Number(r.score) > 0.2)
      .map((r) => {
        const text = r.content_text.replace(/\s+/g, ' ').trim();
        const titleEnd = text.indexOf('\n') > 0 ? text.indexOf('\n') : Math.min(text.length, 110);
        return {
          kind: r.source_type,
          id: r.source_id,
          title: text.slice(0, titleEnd).slice(0, 110),
          snippet: text.slice(0, 280),
          score: Number(r.score),
        };
      });
  }

  /** Always-on KB snapshot for client-scoped conversations (≤~1.2k tokens). */
  async buildSnapshot(tenantId: string, clientId: string, userId?: string): Promise<string | null> {
    if (!this.enabled()) return null;
    if (!await this.prisma.withTenant(tenantId, tx => clientMemoryAllowed(tx, tenantId, userId ?? null, clientId))) return null;
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: {
          name: true,
          description: true,
          productDescription: true,
          sectorTag: true,
          issueCodes: true,
          uei: true,
        },
      }),
    );
    if (!client) return null;
    const [people, facilities, recentDocs] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientPerson.findMany({
          where: { clientId },
          orderBy: [{ lastContact: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
          take: 8,
          select: { name: true, title: true, role: true, lastContact: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientFacility.findMany({
          where: { clientId },
          take: 30,
          select: {
            name: true,
            city: true,
            state: true,
            congressionalDistrict: true,
            employeeCount: true,
          },
        }),
      ),
      this.prisma.withTenant(tenantId, tx =>
        this.visibleDocuments(tx, tenantId, clientId, userId, 5)),
    ]);
    return buildKbSnapshot({ client, people, facilities, recentDocs });
  }
}
