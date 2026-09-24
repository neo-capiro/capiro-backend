/**
 * Community Funding geography repair — pure planning logic, testable without
 * a database. Takes a canonical row's raw `requesterDistrict` token and
 * re-derives geography via the SAME `parseCommunityFundingStdd` normalizer
 * used by ingest (#1724), classifying each row for the repair script.
 */
import type { Chamber } from './community-funding.types.js';
import { parseCommunityFundingStdd } from './community-funding.geography.js';

/** One canonical row's geography as stored (may be null for pre-#1724 rows). */
export interface ExistingGeography {
  chamber: Chamber;
  requesterState: string | null;
  requesterDistrict: string | null;
}

export type RepairClassification =
  | 'eligible'
  | 'already_normalized'
  | 'invalid'
  | 'conflicting'
  | 'senate_statewide';

export interface ClassifiedRow {
  classification: RepairClassification;
  /** The STDD-parsed state if the raw token resolved, otherwise null. */
  resolvedState: string | null;
  /** The STDD-parsed (zero-padded) district if the raw token resolved, otherwise null. */
  resolvedDistrict: string | null;
  /** Human-readable reason for the classification. */
  reason: string;
}

/**
 * Classify a single canonical row for geography repair.
 *
 * Re-derives geography from the stored `requesterDistrict` token (the raw
 * STDD value as ingested from the source document) using the same
 * `parseCommunityFundingStdd` normalizer that #1724 added to the ingest path.
 *
 * Senate rows are always `senate_statewide` — a Senate CDS is never assigned a
 * district unless an independently source-backed numeric district exists
 * outside the STDD token, which this repair does not touch.
 */
export function classifyGeographyRepair(
  geography: ExistingGeography,
): ClassifiedRow {
  const { chamber, requesterState, requesterDistrict } = geography;

  // Senate rows stay statewide — never assign a district.
  if (chamber === 'senate') {
    return {
      classification: 'senate_statewide',
      resolvedState: null,
      resolvedDistrict: null,
      reason: 'Senate CDS requests are statewide; no district is assigned',
    };
  }

  // No raw district token at all — nothing to resolve.
  if (requesterDistrict == null || requesterDistrict.trim() === '') {
    return {
      classification: 'invalid',
      resolvedState: null,
      resolvedDistrict: null,
      reason: 'No source district token available (likely a PDF-parsed row)',
    };
  }

  // Parse the stored token through the STDD normalizer.
  const parsed = parseCommunityFundingStdd(requesterDistrict);

  if (parsed != null) {
    // The token resolved to a valid state+district pair.
    const { state: resolvedState, district: resolvedDistrict } = parsed;

    // If requesterState is null — fill it in from the STDD token.
    if (requesterState == null) {
      return {
        classification: 'eligible',
        resolvedState,
        resolvedDistrict,
        reason: `requester_state is null; STDD token '${requesterDistrict.trim().toUpperCase()}' resolves to ${resolvedState}-${resolvedDistrict}`,
      };
    }

    // Both state and district exist — check if they already match.
    const stateMatches = requesterState.toUpperCase() === resolvedState;
    const rawUpper = requesterDistrict.trim().toUpperCase();
    const districtMatches =
      rawUpper === resolvedDistrict ||
      // Allow unpadded forms: '8' should match resolved '08'
      rawUpper === String(Number(resolvedDistrict)) ||
      // Allow STDD form: stored as 'FL08' should match resolved district '08'
      rawUpper === `${resolvedState}${resolvedDistrict}`;

    if (stateMatches && districtMatches) {
      return {
        classification: 'already_normalized',
        resolvedState,
        resolvedDistrict,
        reason: `Geography already matches resolved STDD: ${resolvedState}-${resolvedDistrict}`,
      };
    }

    // Geography exists but doesn't match the normalizer's output.
    return {
      classification: 'conflicting',
      resolvedState,
      resolvedDistrict,
      reason: `Existing geography (${requesterState}, ${requesterDistrict}) conflicts with STDD-resolved ${resolvedState}-${resolvedDistrict}`,
    };
  }

  // Token did NOT parse as STDD (e.g. plain '08' without state prefix).
  // If requesterState is already set, the row has complete geography — already_normalized.
  if (requesterState != null) {
    return {
      classification: 'already_normalized',
      resolvedState: null,
      resolvedDistrict: null,
      reason: `District token '${requesterDistrict.trim().toUpperCase()}' is not STDD-formatted, but requester_state is already set (${requesterState})`,
    };
  }

  // No STDD parse and no state — unrepairable.
  return {
    classification: 'invalid',
    resolvedState: null,
    resolvedDistrict: null,
    reason: `District token '${requesterDistrict.trim().toUpperCase()}' is not STDD-formatted and requester_state is null; cannot derive geography`,
  };
}

/** Result of planning a full repair pass over a set of rows. */
export interface RepairPlan {
  rows: Array<{
    requestId: string;
    identityHash: string;
    chamber: Chamber;
    fiscalYear: number;
    sourceOccurrenceIds: string[];
    sourceDocumentIds: string[];
    originalRawToken: string | null;
    beforeState: string | null;
    beforeDistrict: string | null;
    afterState: string | null;
    afterDistrict: string | null;
    classification: RepairClassification;
    reason: string;
  }>;
  summary: {
    total: number;
    eligible: number;
    already_normalized: number;
    invalid: number;
    conflicting: number;
    senate_statewide: number;
  };
  beforeAfterByGroup: Array<{
    state: string;
    district: string;
    fiscalYear: number;
    beforeCount: number;
    afterCount: number;
  }>;
}

/**
 * Produce a classification from a database-fetched canonical row shape.
 * This is the entry point the script calls after querying the database.
 */
export function classifyDbRow(row: {
  id: string;
  identityHash: string;
  chamber: Chamber;
  fiscalYear: number;
  requesterState: string | null;
  requesterDistrict: string | null;
}): ClassifiedRow & { requestId: string; identityHash: string; fiscalYear: number } {
  const result = classifyGeographyRepair({
    chamber: row.chamber,
    requesterState: row.requesterState,
    requesterDistrict: row.requesterDistrict,
  });
  return {
    ...result,
    requestId: row.id,
    identityHash: row.identityHash,
    fiscalYear: row.fiscalYear,
  };
}

/**
 * Build counts grouped by (state, district, fiscal year) for eligible rows
 * in their before and after states.
 */
export function buildRepairPlan(
  rows: Array<{
    id: string;
    identityHash: string;
    chamber: Chamber;
    fiscalYear: number;
    requesterState: string | null;
    requesterDistrict: string | null;
    sourceOccurrenceIds: string[];
    sourceDocumentIds: string[];
  }>,
): RepairPlan {
  const classified = rows.map((row) => {
    const cls = classifyGeographyRepair({
      chamber: row.chamber,
      requesterState: row.requesterState,
      requesterDistrict: row.requesterDistrict,
    });
    return {
      requestId: row.id,
      identityHash: row.identityHash,
      chamber: row.chamber,
      fiscalYear: row.fiscalYear,
      sourceOccurrenceIds: row.sourceOccurrenceIds,
      sourceDocumentIds: row.sourceDocumentIds,
      originalRawToken: row.requesterDistrict,
      beforeState: row.requesterState,
      beforeDistrict: row.requesterDistrict,
      afterState: cls.resolvedState,
      afterDistrict: cls.resolvedDistrict,
      classification: cls.classification,
      reason: cls.reason,
    };
  });

  const summary = {
    total: classified.length,
    eligible: classified.filter((r) => r.classification === 'eligible').length,
    already_normalized: classified.filter((r) => r.classification === 'already_normalized').length,
    invalid: classified.filter((r) => r.classification === 'invalid').length,
    conflicting: classified.filter((r) => r.classification === 'conflicting').length,
    senate_statewide: classified.filter((r) => r.classification === 'senate_statewide').length,
  };

  const byGroup = new Map<string, { state: string; district: string; fiscalYear: number; beforeCount: number; afterCount: number }>();
  for (const row of classified) {
    if (row.classification !== 'eligible') continue;
    const key = `${row.afterState}|${row.afterDistrict}|${row.fiscalYear}`;
    const existing = byGroup.get(key);
    if (existing) {
      existing.beforeCount++;
      existing.afterCount++;
    } else {
      byGroup.set(key, {
        state: row.afterState!,
        district: row.afterDistrict!,
        fiscalYear: row.fiscalYear,
        beforeCount: 1,
        afterCount: 1,
      });
    }
  }

  return {
    rows: classified,
    summary,
    beforeAfterByGroup: [...byGroup.values()].sort((a, b) =>
      a.state.localeCompare(b.state) || a.district.localeCompare(b.district) || a.fiscalYear - b.fiscalYear,
    ),
  };
}