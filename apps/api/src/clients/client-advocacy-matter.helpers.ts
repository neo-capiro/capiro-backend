import { createHash } from 'node:crypto';

/**
 * Pure helpers for Advocacy Matter clustering. Kept separate from the
 * service (which does the DB work) so the clustering rule itself is
 * unit-testable without a database.
 *
 * An Advocacy Matter is "what this client is advocating for" — a durable
 * institutional-history grouping over advocacy asks, meetings, emails,
 * submissions, filings, bills, Program Elements, and outcomes. Every
 * `client_advocacy_record` belongs to at most one Matter (`matter_id`).
 *
 * Clustering priority, most to least specific:
 *   1. An explicit Program Element code on the record → one Matter per PE.
 *   2. An explicit bill id on the record → one Matter per bill.
 *   3. An LDA general issue code → one Matter per (issue code) for LDA
 *      lobbying records, since a single LDA issue code IS the client's
 *      lobbying subject for that filing.
 *   4. Fallback: title-token overlap against the client's existing OPEN
 *      matters (deterministic — same title always normalizes to the same
 *      clue, so idempotent re-runs of Fill with Meri don't fragment one ask
 *      into duplicate Matters).
 */

export type MatterType =
  | 'funding_request'
  | 'legislative'
  | 'regulatory'
  | 'program_element'
  | 'community_project'
  | 'procurement'
  | 'other';

export interface MatterClue {
  /** Deterministic clustering key, e.g. "pe:0605053A". Matches the DB
   *  external_key exactly when this clue was already resolved to a Matter. */
  key: string;
  matterType: MatterType;
  title: string;
  primaryPeCode: string | null;
  primaryBillId: string | null;
}

export interface AdvocacyRecordForClustering {
  recordType: string;
  title: string;
  metadata: Record<string, unknown>;
}

const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'their',
  'about', 'after', 'again', 'been', 'have', 'were', 'will', 'fiscal',
  'year', 'request', 'submission', 'client',
]);

/** Same tokenizer shape as the outcome-scoring helper in the completion
 *  service, duplicated here (not imported) to keep this module dependency
 *  free and independently testable. */
export function titleTokens(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_TOKENS.has(token));
  return new Set(tokens);
}

export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Minimum Jaccard token overlap to fold a new record into an existing
 *  title-clustered Matter rather than opening a new one. Deliberately high
 *  (0.5) — a false merge (two unrelated asks sharing a Matter) is a worse
 *  product failure than a false split (the same ask opening two Matters),
 *  because the latter degrades gracefully when a person manually merges. */
export const TITLE_OVERLAP_THRESHOLD = 0.5;

function extractPeCode(metadata: Record<string, unknown>): string | null {
  const direct = metadata.programElement ?? metadata.peCode;
  if (typeof direct === 'string' && direct.trim()) return direct.trim().toUpperCase();
  return null;
}

function extractBillId(metadata: Record<string, unknown>): string | null {
  const direct = metadata.billId ?? metadata.congressBillId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return null;
}

function extractIssueCode(metadata: Record<string, unknown>): string | null {
  const direct = metadata.issueCode;
  if (typeof direct === 'string' && direct.trim()) return direct.trim().toUpperCase();
  const codes = metadata.issueCodes;
  if (Array.isArray(codes)) {
    const first = codes.find((c): c is string => typeof c === 'string' && c.trim().length > 0);
    if (first) return first.trim().toUpperCase();
  }
  return null;
}

/** Matter type inferred from the advocacy record's own recordType, used
 *  only for the fallback/issue-code clues — PE and bill clues carry their
 *  own unambiguous type. */
function matterTypeForRecord(recordType: string): MatterType {
  if (recordType === 'federal_lobbying') return 'legislative';
  if (recordType === 'client_submission') return 'funding_request';
  if (recordType === 'advocacy_meeting' || recordType === 'advocacy_correspondence') return 'other';
  return 'other';
}

/**
 * Computes the deterministic clustering clue for one advocacy record. Does
 * NOT touch the database — resolving the clue to an existing-or-new Matter
 * row (including the title-overlap fallback, which needs the client's
 * current open Matters) is the service's job.
 */
export function computeMatterClue(record: AdvocacyRecordForClustering): MatterClue {
  const peCode = extractPeCode(record.metadata);
  if (peCode) {
    return {
      key: `pe:${peCode}`,
      matterType: 'program_element',
      title: `${peCode} Program Element`,
      primaryPeCode: peCode,
      primaryBillId: null,
    };
  }
  const billId = extractBillId(record.metadata);
  if (billId) {
    return {
      key: `bill:${billId}`,
      matterType: 'legislative',
      title: record.title || `Bill ${billId}`,
      primaryPeCode: null,
      primaryBillId: billId,
    };
  }
  const issueCode = extractIssueCode(record.metadata);
  if (issueCode && record.recordType === 'federal_lobbying') {
    return {
      key: `issue:${issueCode}`,
      matterType: matterTypeForRecord(record.recordType),
      title: `${issueCode} lobbying activity`,
      primaryPeCode: null,
      primaryBillId: null,
    };
  }
  // Fallback: a deterministic hash of the normalized title. The service
  // layer checks this clue's key first (exact repeat asks collapse for
  // free), then falls back to token-overlap fuzzy matching against open
  // Matters before creating a new one.
  const normalized = [...titleTokens(record.title)].sort().join(' ');
  const digest = createHash('sha256').update(normalized || record.title).digest('hex').slice(0, 24);
  return {
    key: `auto:${digest}`,
    matterType: matterTypeForRecord(record.recordType),
    title: record.title || 'Advocacy matter',
    primaryPeCode: null,
    primaryBillId: null,
  };
}
