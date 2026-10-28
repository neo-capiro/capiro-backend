import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@prisma/client';
import { object, type RecordData } from './funding-catalog.mapper.js';

// A document inherits priority from its opportunity, not its role or catalog.
// Use the same stored status/deadline rules as description embeddings.
export const CURRENT_FUNDING_ATTACHMENT_SQL = `(EXISTS (SELECT 1 FROM federal_grant g
  WHERE g.id=opportunity_attachment.federal_grant_id AND g.status IN ('posted','forecasted')
    AND (g.close_date IS NULL OR g.close_date>=CURRENT_DATE))
  OR EXISTS (SELECT 1 FROM sam_opportunity s WHERE s.id=opportunity_attachment.sam_opportunity_id
    AND s.active AND (s.response_deadline IS NULL OR s.response_deadline>=now())))`;

// Paid provider text always wins. Local text is usable only for the exact
// currently archived bytes. No new text table or extraction service is needed.
export const LOCAL_TEXT_SQL = `(SELECT text FROM opportunity_document_text t WHERE t.attachment_id=opportunity_attachment.id
  AND t.attachment_content_sha256=opportunity_attachment.content_sha256 AND t.status='available' AND t.extraction_method='local_parser' LIMIT 1)`;
export const ATTACHMENT_BODY_SQL = `CASE WHEN length(provider_data->>'extracted_text')>10 THEN concat_ws(E'\n',file_name,provider_data->>'extracted_text')
  WHEN length(${LOCAL_TEXT_SQL})>10 THEN concat_ws(E'\n',file_name,${LOCAL_TEXT_SQL}) ELSE '' END`;
export const ATTACHMENT_TEXT_METADATA_SQL = `CASE WHEN length(provider_data->>'extracted_text')>10 THEN 'provider' ELSE 'local_parser' END AS text_method,
  content_sha256, (SELECT truncated FROM opportunity_document_text t WHERE t.attachment_id=opportunity_attachment.id
  AND t.attachment_content_sha256=opportunity_attachment.content_sha256 AND t.status='available' AND t.extraction_method='local_parser' LIMIT 1) AS text_truncated`;

export async function extractNativeFundingPdf(bytes: Uint8Array) {
  if (bytes.length > 25 * 1024 * 1024) throw new Error('native_pdf_size_limit');
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const parts: string[] = []; let characters = 0, blankPages = 0, pagesRead = 0, truncated = false;
  const started = Date.now();
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 500); pageNumber++) {
      if (Date.now()-started > 90_000 || characters >= 2_000_000) { truncated = true; break; }
      const page = await pdf.getPage(pageNumber), content = await page.getTextContent();
      const rawText = (content.items as Array<{ str?: string; hasEOL?: boolean }>).map(item => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join('');
      // Some PDF font mappings emit NUL, which PostgreSQL text cannot store.
      // Preserve its position with a replacement glyph and mark partial text.
      truncated ||= rawText.includes('\u0000');
      const text = rawText.replace(/\u0000/g, '\uFFFD');
      if (!text.trim()) blankPages++;
      const part = text.slice(0, 2_000_000 - characters); parts.push(part); characters += part.length + 1; pagesRead++;
      truncated ||= part.length < text.length;
    }
    return { text: parts.join('\n'), truncated: truncated || blankPages > 0 || pagesRead < pdf.numPages, pagesRead, blankPages };
  } finally { await pdf.loadingTask.destroy(); }
}

export async function publishLocalFundingText(prisma: PrismaClient, row: RecordData, result: { text: string; truncated: boolean } | { failure: string }) {
  if ('text' in result) {
    // PDF font maps and character caps can produce lone UTF-16 surrogates.
    // Repair before Prisma serializes its JSON protocol; retain valid pairs
    // and flag the extraction as partial whenever a glyph was replaced.
    const text = Buffer.from(result.text.replace(/\u0000/g, '\uFFFD'), 'utf8').toString('utf8');
    result = { text, truncated: result.truncated || text !== result.text };
  }
  return prisma.$transaction(async tx => {
    const current = (await tx.$queryRawUnsafe<RecordData[]>('SELECT content_sha256,provider_data FROM opportunity_attachment WHERE id=$1::uuid FOR UPDATE', row.id))[0];
    if (!current || current.content_sha256 !== row.content_sha256 || String(object(current.provider_data).extracted_text ?? '').length>10) return false;
    const available = 'text' in result && result.text.trim().length > 10;
    const data = { attachmentId: row.id, attachmentContentSha256: row.content_sha256, extractionMethod: 'local_parser',
      status: 'failure' in result ? 'failed' : available ? 'available' : 'not_provided', text: available && 'text' in result ? result.text : null,
      charCount: available && 'text' in result ? result.text.length : null, truncated: 'text' in result ? result.truncated : false,
      failureReason: 'failure' in result ? result.failure : null, fetchedAt: new Date() };
    const previous = await tx.opportunityDocumentText.findFirst({ where: { attachmentId: row.id, extractionMethod: 'local_parser' } });
    if (previous) await tx.opportunityDocumentText.update({ where: { id: previous.id }, data });
    else await tx.opportunityDocumentText.create({ data });
    // Invalidate the embedding freshness marker, without pretending this is
    // provider extraction. The vector worker reads the separate hash-bound row.
    await tx.opportunityAttachment.update({ where: { id: row.id }, data: { providerObservedAt: new Date() } });
    return true;
  });
}

export async function readNativePdfCandidates(prisma: PrismaClient, bucket: string, limit: number) {
  return prisma.$queryRawUnsafe<RecordData[]>(`SELECT id::text,content_sha256,archive_key,observed_size_bytes FROM opportunity_attachment
    WHERE (federal_grant_id IS NOT NULL OR source_url LIKE 'https://sws.gsa.gov/sws-search/viewSolDocument.do?%'
      OR (source_url LIKE 'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/%'
        AND (provider_data->>'extraction_status' IN ('failed','completed')
          OR (provider_attachment_id IS NULL AND coalesce(provider_data->>'extraction_status','') NOT IN ('pending','extracting')))))
    AND status='archived' AND archive_bucket=$1 AND archive_key LIKE 'funding-source-documents/%'
    AND observed_mime_type='application/pdf' AND coalesce(length(provider_data->>'extracted_text'),0)<=10
    AND NOT EXISTS(SELECT 1 FROM opportunity_document_text t WHERE t.attachment_id=opportunity_attachment.id AND t.extraction_method='local_parser'
      AND t.attachment_content_sha256=opportunity_attachment.content_sha256 AND (t.status<>'failed' OR t.updated_at>now()-interval '1 day'))
    ORDER BY ${CURRENT_FUNDING_ATTACHMENT_SQL} DESC,
      archived_at,id LIMIT $2`, bucket, limit);
}

/** Identical archived bytes may appear on several notices. Only reuse native
 * text bound to that exact SHA-256; provider text has a different binding. */
export async function reusableNativeFundingText(prisma: PrismaClient, contentSha256: string) {
  return (await prisma.$queryRawUnsafe<Array<{ text: string; truncated: boolean }>>(`SELECT text,truncated
    FROM opportunity_document_text WHERE attachment_content_sha256=$1
    AND extraction_method='local_parser' AND status='available' AND length(text)>10
    ORDER BY truncated ASC,updated_at DESC LIMIT 1`, contentSha256))[0];
}

export async function extractArchivedFundingPdfs(prisma: PrismaClient, bucket: string, limit: number) {
  const rows = await readNativePdfCandidates(prisma, bucket, limit);
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  let available = 0, unavailable = 0, failed = 0, reused = 0;
  try {
    for (const row of rows) {
      let result: { text: string; truncated: boolean } | { failure: string };
      let reusedText = false;
      try {
        const existing = await reusableNativeFundingText(prisma, row.content_sha256);
        if (existing) { result = existing; reusedText = true; }
        else {
          if (Number(row.observed_size_bytes)>25*1024*1024) throw new Error('native_pdf_size_limit');
          const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: row.archive_key }));
          if (!response.Body || Number(response.ContentLength)>25*1024*1024) throw new Error('archive_body_unavailable_or_over_limit');
          const bytes = await response.Body.transformToByteArray();
          if (createHash('sha256').update(bytes).digest('hex') !== row.content_sha256) throw new Error('archive_hash_mismatch');
          result = await extractNativeFundingPdf(bytes);
        }
      } catch (error) {
        // Parser diagnostics can contain source bytes; retain only our fixed codes.
        const message = error instanceof Error ? error.message : '';
        result = { failure: ['native_pdf_size_limit','archive_body_unavailable_or_over_limit','archive_hash_mismatch'].includes(message) ? message : 'native_pdf_parse_or_read_failed' };
      }
      if (await publishLocalFundingText(prisma, row, result)) {
        if (reusedText) reused++;
        if ('failure' in result) failed++; else if (result.text.trim().length>10) available++; else unavailable++;
      }
    }
  } finally { s3.destroy(); }
  return { attempted: rows.length, available, unavailable, failed, reused };
}
