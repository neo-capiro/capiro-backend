import type { KnowledgeJsonObject } from '../knowledge.types.js';

export const CANONICAL_PUBLIC_REFERENCE_SOURCES = [
  'federal_contractors',
  'congress_members',
  'congress_committees',
  'acquisition_personnel',
  'program_elements',
  'lda_clients',
  'sec_companies',
] as const;

export type CanonicalPublicReferenceSource =
  (typeof CANONICAL_PUBLIC_REFERENCE_SOURCES)[number];

export interface CanonicalPublicReferenceIdentifier {
  type: string;
  value: string;
}

export interface CanonicalPublicReferenceRecord {
  /** Stable, source-native key used for keyset pagination. */
  cursorKey: string;
  source: CanonicalPublicReferenceSource;
  sourceId: string;
  entityType: string;
  canonicalName: string;
  identifiers: CanonicalPublicReferenceIdentifier[];
  aliases: string[];
  metadata: KnowledgeJsonObject;
  observedAt: Date;
}

export interface CanonicalPublicReferenceBackfillInput {
  source: CanonicalPublicReferenceSource;
  cursor?: string | null;
  limit?: number;
  /** False by default. Dry-run must not create identity or resolution rows. */
  execute?: boolean;
}

export interface CanonicalPublicReferenceBackfillFailure {
  sourceId: string;
  message: string;
}

export interface CanonicalPublicReferenceBackfillResult {
  source: CanonicalPublicReferenceSource;
  execute: boolean;
  requestedCursor: string | null;
  nextCursor: string | null;
  exhausted: boolean;
  scanned: number;
  eligible: number;
  processed: number;
  skipped: number;
  failures: CanonicalPublicReferenceBackfillFailure[];
  entityIds: string[];
}
