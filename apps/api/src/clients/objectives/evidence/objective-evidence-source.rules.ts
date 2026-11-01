import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AttachmentCitation } from '../../../engagement/attachments/attachment-citation.js';
import type { RetainedNewsObservation } from '../../../intelligence/news/news-evidence-read.js';
import type {
  ObjectiveEvidenceReference,
  ObjectiveEvidenceSelector,
  ObjectiveEvidenceSnapshot,
} from './objective-evidence-source.types.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const token = /^[a-zA-Z0-9_-]{1,200}$/;
export function parseEvidenceReference(
  value: unknown,
  selected = false,
): ObjectiveEvidenceReference | ObjectiveEvidenceSelector {
  const row = value as Record<string, unknown>;
  const allowed =
    row?.kind === 'document' ? ['kind', 'attachmentId'] : ['kind', 'articleId', 'observationId'];
  if (selected) allowed.push('expectedDigest');
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    Object.keys(row).length !== allowed.length ||
    Object.keys(row).some((key) => !allowed.includes(key)) ||
    (selected && (typeof row.expectedDigest !== 'string' || !digest.test(row.expectedDigest))) ||
    (row.kind === 'document'
      ? typeof row.attachmentId !== 'string' || !uuid.test(row.attachmentId)
      : row.kind !== 'news' ||
        typeof row.articleId !== 'string' ||
        !token.test(row.articleId) ||
        typeof row.observationId !== 'string' ||
        !digest.test(row.observationId))
  )
    throw new BadRequestException('Invalid Objective evidence selection.');
  return value as ObjectiveEvidenceReference | ObjectiveEvidenceSelector;
}
export function evidenceReference(selector: ObjectiveEvidenceSelector): ObjectiveEvidenceReference {
  return selector.kind === 'document'
    ? { kind: 'document', attachmentId: selector.attachmentId }
    : { kind: 'news', articleId: selector.articleId, observationId: selector.observationId };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function safeSourceUrl(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}
export function documentEvidenceSnapshot(row: AttachmentCitation): ObjectiveEvidenceSnapshot {
  const reference = { kind: 'document' as const, attachmentId: row.attachmentId };
  // Canonical owner metadata only. No signed URL, observation clock or current-head marker.
  const provenanceDigest = hash({
    schema: 1,
    clientId: row.clientId,
    contentType: row.contentType,
    byteSize: row.byteSize,
    source: row.source,
    sourceEntityType: row.sourceEntityType,
    sourceEntityId: row.sourceEntityId,
    sourceVersion: row.sourceVersion,
    sourceContentHash: row.sourceContentHash,
    sourceGeneration: row.sourceGeneration,
    metadataRevision: row.metadataRevision,
  });
  return seal({
    selector: { ...reference, expectedDigest: '' },
    version: row.contentHash,
    digest: '',
    provenanceDigest,
    title: row.title,
    sourceSystem: 'client_document',
    sourceUrl: null,
    summary: null,
    rights: 'private_document',
    complete: false,
    observedAt: row.observedAt,
  });
}
export function newsEvidenceSnapshot(row: RetainedNewsObservation): ObjectiveEvidenceSnapshot {
  const reference = {
    kind: 'news' as const,
    articleId: row.articleId,
    observationId: row.observationId,
  };
  return seal({
    selector: { ...reference, expectedDigest: '' },
    version: row.revision,
    digest: '',
    provenanceDigest: hash({
      schema: 1,
      publisher: row.publisher,
      sourceUrl: row.sourceUrl,
      retainedBodyComplete: row.complete,
    }),
    title: row.title,
    sourceSystem: 'retained_news',
    sourceUrl: safeSourceUrl(row.sourceUrl),
    summary: row.summary,
    rights: row.rights,
    // This preview includes title/summary, never the retained full body.
    complete: false,
    observedAt: row.observedAt,
  });
}
/** Hash displayed data as well as the owner witness; a stored digest is not
 * evidence that independently supplied snapshot fields still agree with it. */
export function evidenceSnapshotDigest(snapshot: ObjectiveEvidenceSnapshot) {
  return hash({
    schema: 1,
    reference: evidenceReference(snapshot.selector),
    version: snapshot.version,
    provenanceDigest: snapshot.provenanceDigest,
    title: snapshot.title,
    sourceSystem: snapshot.sourceSystem,
    sourceUrl: snapshot.sourceUrl,
    summary: snapshot.summary,
    rights: snapshot.rights,
    complete: snapshot.complete,
    observedAt: snapshot.observedAt,
  });
}
function seal(snapshot: ObjectiveEvidenceSnapshot): ObjectiveEvidenceSnapshot {
  const value = evidenceSnapshotDigest(snapshot);
  return { ...snapshot, digest: value, selector: { ...snapshot.selector, expectedDigest: value } };
}
