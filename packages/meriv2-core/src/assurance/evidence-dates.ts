import type { MeriCitation } from '@capiro/shared';

export type EvidenceDateBasis = 'source' | 'tool_asOf' | 'observedAt' | 'none';
export interface DerivedEvidenceDates {
  publishedAt: string | null;
  effectiveAt: string | null;
  retrievedAt: string | null;
  basis: Record<'publishedAt' | 'effectiveAt' | 'retrievedAt', EvidenceDateBasis>;
}

export interface DeriveEvidenceDatesInput {
  citation?: Pick<MeriCitation, 'type' | 'source' | 'documentEvidence'> | null;
  toolPayload?: unknown;
  documentEvidence?: MeriCitation['documentEvidence'] | null;
}

/**
 * Separates when source material was published, when its subject took effect,
 * and when Capiro observed it. This is intentionally allow-list based: unknown
 * fields remain null rather than being assigned guessed semantics.
 */
export function deriveEvidenceDates(input: DeriveEvidenceDatesInput): DerivedEvidenceDates {
  const payload = object(input.toolPayload);
  const source = object(payload?.source);
  const documentEvidence = input.documentEvidence ?? input.citation?.documentEvidence;
  const citationObserved = iso(input.citation?.source?.observedAt);
  const documentObserved = iso(documentEvidence?.observedAt);

  const awardEffective = firstIso(payload?.latestActionDate, payload?.baseAwardSignedDate);
  const ruleEffective = firstIso(payload?.effectiveDate, payload?.stageAt, payload?.statusAt);
  const effectiveAt = awardEffective ?? ruleEffective;

  const budgetObserved = firstIso(source?.observedAt, payload?.publishedAt);
  const publishedAt = budgetObserved ?? firstIso(payload?.publicationDate, payload?.postedDate, payload?.publishedDate);

  const toolAsOf = firstIso(
    payload?.capiroSyncedAt,
    payload?.lastSyncAt,
    object(payload?.sourceFreshness)?.lastSyncedAt,
    payload?.generatedAt,
    payload?.asOf,
  );
  const observedAt = citationObserved ?? documentObserved;
  const retrievedAt = observedAt ?? toolAsOf;

  return {
    publishedAt,
    effectiveAt,
    retrievedAt,
    basis: {
      publishedAt: publishedAt ? 'source' : 'none',
      effectiveAt: effectiveAt ? 'source' : 'none',
      retrievedAt: observedAt ? 'observedAt' : toolAsOf ? 'tool_asOf' : 'none',
    },
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstIso(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = iso(value);
    if (parsed) return parsed;
  }
  return null;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
