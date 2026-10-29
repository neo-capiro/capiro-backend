import type { DefenseFederalEvidenceSideDto } from '@capiro/shared';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function bounded(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}
function hash(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : null;
}
function date(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** Each side must prove its own event revision; never borrow the opposite side. */
export function federalEvidenceSide(
  snapshotValue: unknown,
  revisionValue: unknown,
  expectedRevision: unknown,
  sourceKey: unknown,
): DefenseFederalEvidenceSideDto {
  const snapshot = record(snapshotValue);
  const revision = record(revisionValue);
  const absent: DefenseFederalEvidenceSideDto = {
    availability: 'unavailable',
    reason: 'This event has no qualified, independently pinned evidence for this side.',
    revisionId: bounded(expectedRevision, 36),
    contentHash: null,
    extractionHash: null,
    sourceUrl: null,
    locator: null,
    textSpan: null,
    evidence: null,
    languageHash: null,
    qualificationState: bounded(snapshot.qualificationState, 32),
    publishedAt: null,
    sourceModifiedAt: null,
  };
  const contentHash = hash(revision.contentHash);
  const extractionHash = hash(revision.extractionHash);
  const languageHash = hash(snapshot.languageHash);
  const locator = bounded(snapshot.locator, 2000);
  const evidence = bounded(snapshot.evidence, 20000);
  const sourceUrl = bounded(revision.sourceUrl, 4096);
  let safeUrl = false;
  try {
    safeUrl = Boolean(sourceUrl && ['https:', 'http:'].includes(new URL(sourceUrl).protocol));
  } catch {}
  if (
    !expectedRevision ||
    revision.id !== expectedRevision ||
    revision.sourceKey !== sourceKey ||
    snapshot.qualificationState !== 'qualified' ||
    !contentHash ||
    !extractionHash ||
    !languageHash ||
    !locator ||
    !evidence ||
    !safeUrl
  )
    return absent;
  const match = /^characters:(\d+)-(\d+)$/.exec(locator);
  const start = match ? Number(match[1]) : NaN;
  const end = match ? Number(match[2]) : NaN;
  const textSpan =
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start
      ? { start, end }
      : null;
  return {
    availability: 'available',
    reason: null,
    revisionId: revision.id as string,
    contentHash,
    extractionHash,
    sourceUrl,
    locator,
    textSpan,
    evidence,
    languageHash,
    qualificationState: 'qualified',
    publishedAt: date(revision.publishedAt),
    sourceModifiedAt: date(revision.sourceModifiedAt),
  };
}
