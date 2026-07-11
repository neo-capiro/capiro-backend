import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import mammoth from 'mammoth';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { extractPdfText } from '../meri/meri-attachment-extract.js';
import {
  EMBEDDING_MODEL,
  embedAndUpsert,
  embedText,
  normalize,
  vectorLiteral,
} from './embedder.js';
import {
  KB_MAX_CHUNKS_PER_CLIENT,
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
        },
      }),
    );
    if (!attachment || !attachment.clientId) {
      await this.purge(tenantId, 'client_doc_chunk', attachmentId);
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

    const text = await this.extractAttachmentTextForKb(attachment);
    // Replace any prior chunks for this doc before re-indexing.
    await this.purge(tenantId, 'client_doc_chunk', attachmentId);
    const chunks = text
      ? chunkDocumentText(text)
      : [`Image or non-text attachment: ${attachment.fileName}`];
    for (let i = 0; i < chunks.length; i += 1) {
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
      });
    }

    // Stamp the attachment as indexed (Meetings v2 §5) — reached only after the
    // whole chunk loop succeeds, so the two early returns above (missing/no-client,
    // quota exceeded) correctly leave indexedAt null. Drives the Documents-tab
    // per-file "Indexed" badge. withTenant (not withSystem): the row is
    // tenant-scoped and RLS must allow the UPDATE for this tenant.
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.engagementAttachment.update({
        where: { id: attachmentId },
        data: { indexedAt: new Date() },
      }),
    );
  }

  /** S3 download + text extraction; null for image/unsupported kinds. */
  private async extractAttachmentTextForKb(attachment: {
    fileName: string;
    contentType: string | null;
    s3Key: string;
  }): Promise<string | null> {
    if (!this.bucket) return null;
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
    if (isText) return bytes.toString('utf8');
    if (isDocx) return (await mammoth.extractRawText({ buffer: bytes })).value;
    return (await extractPdfText(bytes)).text;
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
    input: { query: string; clientId: string; kind?: string; limit?: number },
  ): Promise<Array<{ kind: string; id: string; title: string; snippet: string; score: number }>> {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
    const kindFilter =
      input.kind && (KB_SOURCE_TYPES as readonly string[]).includes(input.kind) ? input.kind : null;
    const vector = await embedText(normalize(input.query));
    const literal = vectorLiteral(vector);
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<
        Array<{ source_type: string; source_id: string; content_text: string; score: number }>
      >(
        `SELECT source_type, source_id, content_text,
                1 - (embedding <=> '${literal}'::vector) AS score
           FROM context_embeddings
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            AND source_type IN (${KB_SOURCE_TYPES.map((t) => `'${t}'`).join(', ')})
            ${kindFilter ? 'AND source_type = $4' : ''}
            AND model = $3
          ORDER BY embedding <=> '${literal}'::vector
          LIMIT ${limit}`,
        ...([
          tenantId,
          input.clientId,
          EMBEDDING_MODEL,
          ...(kindFilter ? [kindFilter] : []),
        ] as unknown[]),
      ),
    );
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
  async buildSnapshot(tenantId: string, clientId: string): Promise<string | null> {
    if (!this.enabled()) return null;
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
      this.prisma.withTenant(tenantId, (tx) =>
        tx.engagementAttachment.findMany({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { fileName: true, createdAt: true },
        }),
      ),
    ]);
    return buildKbSnapshot({ client, people, facilities, recentDocs });
  }
}
