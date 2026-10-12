import { createHash } from 'node:crypto';

export const FR_API = 'https://www.federalregister.gov/api/v1/documents';
export const EVIDENCE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export type EffectiveDateStatus =
  | 'supported'
  | 'missing_date'
  | 'invalid_date'
  | 'unsupported_document_type'
  | 'missing_official_pdf'
  | 'correction_requires_review'
  | 'incomplete_correction_metadata';
export interface RuleDateSource {
  document_number: string;
  type: string;
  publication_date: unknown;
  effective_on: unknown;
  pdf_url: unknown;
  correction_of?: unknown;
  corrections?: unknown;
}
interface PriorEvidence {
  date: string | null;
  status: EffectiveDateStatus;
  evidenceHash: string;
  revision: number;
  observedAt: string;
}
export interface EffectiveDateEvidence extends PriorEvidence {
  schemaVersion: 1;
  dateKind: 'effective';
  documentNumber: string;
  publicationDate: string;
  rawEffectiveOn: string | null;
  sourceUrl: string;
  officialPdfUrl: string | null;
  correctionOf: string | null;
  corrections: string[];
  authority: 'federal_register_publisher_metadata';
  sourceField: 'effective_on';
  changedAt: string;
  previous: PriorEvidence | null;
}

export function dateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

export function canonicalDocumentNumber(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{3,6}$/.test(value);
}

function officialPdf(
  value: unknown,
  documentNumber: string,
  publicationDate: string,
): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.govinfo.gov' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/content\/pkg\/FR-\d{4}-\d{2}-\d{2}\/pdf\/\d{4}-\d{3,6}\.pdf$/.test(url.pathname) ||
      !url.pathname.endsWith(`/${documentNumber}.pdf`) ||
      url.pathname.split('/')[3] !== `FR-${publicationDate}` ||
      !dateOnly(publicationDate)
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

function correctionUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.federalregister.gov' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/api\/v1\/documents\/\d{4}-\d{3,6}\.json$/.test(url.pathname)
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function buildEffectiveDateEvidence(
  doc: RuleDateSource,
  observedAt: Date,
  previousValue: unknown = null,
): EffectiveDateEvidence {
  if (!canonicalDocumentNumber(doc.document_number) || !Number.isFinite(observedAt.getTime())) {
    throw new Error('Invalid Federal Register evidence identity/observation');
  }
  const publicationDate = dateOnly(doc.publication_date);
  if (!publicationDate) throw new Error('Invalid Federal Register publication identity');
  const date = dateOnly(doc.effective_on);
  const pdf = officialPdf(doc.pdf_url, doc.document_number, publicationDate);
  const correctionOf = doc.correction_of == null ? null : correctionUrl(doc.correction_of);
  const corrections = Array.isArray(doc.corrections)
    ? doc.corrections.map(correctionUrl).filter((v): v is string => v !== null)
    : [];
  const correctionMetadataComplete =
    Object.hasOwn(doc, 'correction_of') &&
    Object.hasOwn(doc, 'corrections') &&
    Array.isArray(doc.corrections) &&
    doc.corrections.length <= 100 &&
    corrections.length === doc.corrections.length &&
    (doc.correction_of === null || correctionOf !== null);
  let status: EffectiveDateStatus = 'supported';
  if (doc.type !== 'RULE' && doc.type !== 'Rule') status = 'unsupported_document_type';
  else if (doc.effective_on === null) status = 'missing_date';
  else if (!date) status = 'invalid_date';
  else if (!pdf) status = 'missing_official_pdf';
  else if (!correctionMetadataComplete) status = 'incomplete_correction_metadata';
  else if (correctionOf || corrections.length) status = 'correction_requires_review';
  const content = {
    schemaVersion: 1 as const,
    dateKind: 'effective' as const,
    documentNumber: doc.document_number,
    publicationDate,
    date,
    rawEffectiveOn: typeof doc.effective_on === 'string' ? doc.effective_on.slice(0, 100) : null,
    sourceUrl: `${FR_API}/${doc.document_number}.json`,
    officialPdfUrl: pdf,
    correctionOf,
    corrections: [...new Set(corrections)].sort().slice(0, 100),
    authority: 'federal_register_publisher_metadata' as const,
    sourceField: 'effective_on' as const,
    status,
  };
  const evidenceHash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  const previous = readEffectiveDateEvidence(previousValue, doc.document_number);
  const unchanged = previous?.evidenceHash === evidenceHash;
  return {
    ...content,
    evidenceHash,
    observedAt: observedAt.toISOString(),
    revision: unchanged ? previous.revision : (previous?.revision ?? 0) + 1,
    changedAt: unchanged ? previous.changedAt : observedAt.toISOString(),
    previous: unchanged
      ? previous.previous
      : previous
        ? {
            date: previous.date,
            status: previous.status,
            evidenceHash: previous.evidenceHash,
            revision: previous.revision,
            observedAt: previous.observedAt,
          }
        : null,
  };
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/** Never turn malformed/legacy JSON or a foreign receipt into calendar authority. */
export function readEffectiveDateEvidence(
  value: unknown,
  documentNumber: string,
): EffectiveDateEvidence | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as EffectiveDateEvidence;
  if (
    v.schemaVersion !== 1 ||
    v.dateKind !== 'effective' ||
    v.documentNumber !== documentNumber ||
    v.authority !== 'federal_register_publisher_metadata' ||
    v.sourceField !== 'effective_on' ||
    v.sourceUrl !== `${FR_API}/${documentNumber}.json` ||
    typeof v.publicationDate !== 'string' ||
    dateOnly(v.publicationDate) !== v.publicationDate ||
    ![
      'supported',
      'missing_date',
      'invalid_date',
      'unsupported_document_type',
      'missing_official_pdf',
      'correction_requires_review',
      'incomplete_correction_metadata',
    ].includes(v.status) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1 ||
    typeof v.evidenceHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.evidenceHash) ||
    !canonicalTimestamp(v.observedAt) ||
    !canonicalTimestamp(v.changedAt) ||
    v.changedAt > v.observedAt ||
    (v.date !== null && dateOnly(v.date) !== v.date) ||
    (v.rawEffectiveOn !== null && typeof v.rawEffectiveOn !== 'string') ||
    !Array.isArray(v.corrections) ||
    v.corrections.length > 100 ||
    v.corrections.some((url) => correctionUrl(url) !== url) ||
    (v.correctionOf !== null && correctionUrl(v.correctionOf) !== v.correctionOf)
  )
    return null;
  if (
    v.status === 'supported' &&
    (!v.date ||
      dateOnly(v.rawEffectiveOn) !== v.date ||
      officialPdf(v.officialPdfUrl, documentNumber, v.publicationDate) !== v.officialPdfUrl ||
      !v.officialPdfUrl ||
      v.correctionOf ||
      v.corrections.length)
  )
    return null;
  // Hash verifies the exact source projection, independently of claimed status.
  const content = {
    schemaVersion: v.schemaVersion,
    dateKind: v.dateKind,
    documentNumber: v.documentNumber,
    publicationDate: v.publicationDate,
    date: v.date,
    rawEffectiveOn: v.rawEffectiveOn,
    sourceUrl: v.sourceUrl,
    officialPdfUrl: v.officialPdfUrl,
    correctionOf: v.correctionOf,
    corrections: v.corrections,
    authority: v.authority,
    sourceField: v.sourceField,
    status: v.status,
  };
  if (createHash('sha256').update(JSON.stringify(content)).digest('hex') !== v.evidenceHash)
    return null;
  let previous: PriorEvidence | null = null;
  if (v.previous !== null) {
    const prior = v.previous;
    if (
      typeof prior !== 'object' ||
      !prior ||
      Array.isArray(prior) ||
      (prior.date !== null && dateOnly(prior.date) !== prior.date) ||
      ![
        'supported',
        'missing_date',
        'invalid_date',
        'unsupported_document_type',
        'missing_official_pdf',
        'correction_requires_review',
        'incomplete_correction_metadata',
      ].includes(prior.status) ||
      !Number.isSafeInteger(prior.revision) ||
      prior.revision < 1 ||
      prior.revision >= v.revision ||
      !canonicalTimestamp(prior.observedAt) ||
      prior.observedAt > v.changedAt ||
      typeof prior.evidenceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(prior.evidenceHash)
    )
      return null;
    previous = {
      date: prior.date,
      status: prior.status,
      revision: prior.revision,
      observedAt: prior.observedAt,
      evidenceHash: prior.evidenceHash,
    };
  }
  return {
    ...content,
    evidenceHash: v.evidenceHash,
    revision: v.revision,
    observedAt: v.observedAt,
    changedAt: v.changedAt,
    previous,
  };
}
