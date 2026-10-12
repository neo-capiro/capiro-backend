import type { PrismaClient } from '@prisma/client';
import {
  buildEffectiveDateEvidence,
  dateOnly,
  type RuleDateSource,
} from './effective-date-evidence.js';

/** Existing sync owner applies metadata and date evidence together, ordered by request start. */
export async function persistFederalRegisterObservation(
  prisma: PrismaClient,
  source: RuleDateSource,
  observedAt: Date,
  metadata: Parameters<PrismaClient['federalRegisterDocument']['create']>[0]['data'],
): Promise<'updated' | 'stale'> {
  if (
    metadata.documentNumber !== source.document_number ||
    typeof source.type !== 'string' ||
    metadata.type !== source.type.toUpperCase().replace(/\s+/g, '_') ||
    !(metadata.publicationDate instanceof Date) ||
    metadata.publicationDate.toISOString() !==
      `${dateOnly(source.publication_date)}T00:00:00.000Z` ||
    (metadata.pdfUrl ?? null) !== (typeof source.pdf_url === 'string' ? source.pdf_url : null)
  ) {
    throw new Error('Federal Register metadata/evidence identity mismatch');
  }
  return prisma.$transaction(async (tx) => {
    // Also serializes first observation before a row exists. Global reference identity only.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fr-document:${source.document_number}`}, 0))`;
    const rows = await tx.$queryRaw<Array<{ evidence: unknown; observedAt: Date | null }>>`
      SELECT effective_date_evidence AS evidence, effective_date_observed_at AS "observedAt"
      FROM federal_register_document WHERE document_number = ${source.document_number} FOR UPDATE`;
    const prior = rows[0];
    if (prior?.observedAt && prior.observedAt.getTime() >= observedAt.getTime()) return 'stale';
    const evidence = buildEffectiveDateEvidence(source, observedAt, prior?.evidence);
    const effectiveDate = evidence.date ? new Date(`${evidence.date}T00:00:00.000Z`) : null;
    await tx.federalRegisterDocument.upsert({
      where: { documentNumber: source.document_number },
      create: { ...metadata, effectiveDate, syncedAt: observedAt },
      update: { ...metadata, effectiveDate, syncedAt: observedAt },
    });
    await tx.$executeRaw`UPDATE federal_register_document
      SET effective_date_evidence = ${JSON.stringify(evidence)}::jsonb,
          effective_date_observed_at = ${observedAt}
      WHERE document_number = ${source.document_number}`;
    return 'updated';
  });
}
