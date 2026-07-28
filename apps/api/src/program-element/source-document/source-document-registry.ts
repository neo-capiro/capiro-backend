/**
 * Step 0.1 — SourceDocument registry upsert (idempotent, version-chained) + sha256 helpers.
 *
 * Invariant enforced here (not at the DB level, since Prisma 5 cannot express a partial
 * unique index): exactly ONE live document per sourceKey — the row whose
 * supersededByDocumentId IS NULL.
 *
 *   - same (sourceKey, sha256) already ingested  -> no-op, returns the existing row.
 *   - changed sha256 for an existing sourceKey    -> inserts a new row AND chains the prior
 *                                                    live head via supersededByDocumentId.
 *
 * Works against either PrismaService or PrismaClient (both expose `sourceDocument`); the
 * narrow SourceDocumentClient interface also lets the specs drive it with an in-memory mock.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

export interface SourceDocumentRow {
  id: string;
  sourceKey: string;
  sha256: string | null;
  supersededByDocumentId: string | null;
  [key: string]: unknown;
}

export interface SourceDocumentDelegate {
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<SourceDocumentRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<SourceDocumentRow>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<SourceDocumentRow>;
}

export interface SourceDocumentClient {
  sourceDocument: SourceDocumentDelegate;
}

export interface UpsertSourceDocumentInput {
  sourceKey: string;
  sha256: string | null;
  fiscalYear?: number | null;
  budgetCycle: string;
  component?: string | null;
  documentType: string;
  title: string;
  sourceUrl: string;
  byteSize?: number | null;
  pageCount?: number | null;
  downloadedAt?: Date | null;
  artifactPath?: string | null;
  extractionMethod: string;
  extractionToolVersion?: string | null;
  metadata?: Record<string, unknown>;
  // Immutable raw-archive provenance (PE Watch LlamaParse ingestion). Populated only
  // after original bytes are written to the Object-Lock raw bucket. A SourceDocument
  // row without these is NOT proof of archival.
  archiveBucket?: string | null;
  archiveS3Key?: string | null;
  archiveVersionId?: string | null;
  archiveKmsKeyArn?: string | null;
  retainUntil?: Date | null;
  archivedAt?: Date | null;
}

export interface UpsertSourceDocumentResult {
  /** The current live document for this sourceKey (existing on a no-op, or the new version). */
  document: SourceDocumentRow;
  /** True when a new row was inserted; false when an identical (sourceKey, sha256) existed. */
  created: boolean;
  /** The prior live head that was chained to the new version, or null. */
  supersededDocument: SourceDocumentRow | null;
}

export function sha256OfBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256OfFile(filePath: string): string {
  return sha256OfBuffer(fs.readFileSync(filePath));
}

/**
 * Pull the extractor tool version out of an artifact's `_document` header (emitted by the
 * python _doc_header helper). Returns null when the artifact predates the header — committed
 * artifacts are not regenerated, so this is null today but populated once they are re-extracted.
 */
export function readDocumentToolVersion(artifact: unknown): string | null {
  const doc = (artifact as { _document?: { tool_version?: unknown } } | null | undefined)?._document;
  const v = doc?.tool_version;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function buildData(input: UpsertSourceDocumentInput): Record<string, unknown> {
  return {
    sourceKey: input.sourceKey,
    sha256: input.sha256,
    fiscalYear: input.fiscalYear ?? null,
    budgetCycle: input.budgetCycle,
    component: input.component ?? null,
    documentType: input.documentType,
    title: input.title,
    sourceUrl: input.sourceUrl,
    byteSize: input.byteSize ?? null,
    pageCount: input.pageCount ?? null,
    downloadedAt: input.downloadedAt ?? null,
    artifactPath: input.artifactPath ?? null,
    extractionMethod: input.extractionMethod,
    extractionToolVersion: input.extractionToolVersion ?? null,
    metadata: input.metadata ?? {},
    archiveBucket: input.archiveBucket ?? null,
    archiveS3Key: input.archiveS3Key ?? null,
    archiveVersionId: input.archiveVersionId ?? null,
    archiveKmsKeyArn: input.archiveKmsKeyArn ?? null,
    retainUntil: input.retainUntil ?? null,
    archivedAt: input.archivedAt ?? null,
  };
}

export async function upsertSourceDocument(
  client: SourceDocumentClient,
  input: UpsertSourceDocumentInput,
  options: { deferSupersede?: boolean } = {},
): Promise<UpsertSourceDocumentResult> {
  const sd = client.sourceDocument;

  // 1. Exact-content de-duplication: this content was already ingested for this key.
  const exact = await sd.findFirst({
    where: { sourceKey: input.sourceKey, sha256: input.sha256 },
  });
  if (exact) {
    return { document: exact, created: false, supersededDocument: null };
  }

  // 2. Current live head (if any) for the version chain.
  const head = await sd.findFirst({
    where: { sourceKey: input.sourceKey, supersededByDocumentId: null },
    orderBy: { ingestedAt: 'desc' },
  });

  // 3. Insert the new version.
  const document = await sd.create({ data: buildData(input) });

  // 4. Chain the prior live head to the new version.
  //
  // `deferSupersede` exists for callers that register a document BEFORE a separate
  // canonical transaction. Superseding here would be committed immediately, so a
  // later promotion failure would leave a previously valid head superseded by a
  // document whose values were never promoted. Such callers pass deferSupersede
  // and must apply `supersedeSourceDocumentHead` inside their transaction.
  // Default behavior is unchanged for every existing caller.
  if (!options.deferSupersede && head && head.id !== document.id) {
    await sd.update({ where: { id: head.id }, data: { supersededByDocumentId: document.id } });
  }

  return { document, created: true, supersededDocument: head ?? null };
}

/**
 * Apply the deferred head chaining. Safe to call inside a transaction so the head
 * flip commits atomically with the promotion that justifies it.
 */
export async function supersedeSourceDocumentHead(
  client: SourceDocumentClient,
  previousHeadId: string,
  newDocumentId: string,
): Promise<void> {
  if (previousHeadId === newDocumentId) return;
  await client.sourceDocument.update({
    where: { id: previousHeadId },
    data: { supersededByDocumentId: newDocumentId },
  });
}
