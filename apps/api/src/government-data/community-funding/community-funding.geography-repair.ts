/**
 * Community Funding geography repair — pure planning logic, testable without
 * a database. Takes a canonical row's stored geography and re-derives the
 * correct `requester_state` via `normalizeCommunityFundingGeography` (the
 * SAME normalizer used by ingest #1724), classfying each row.
 *
 * CRITICAL: The repair ONLY writes `requester_state` (when null and
 * resolvable). `requester_district` is NEVER rewritten — it must remain
 * byte-identical to what `parseHouseXlsxRows` persisted (the raw uppercased
 * SIDD token, e.g. 'F08', NOT '08').
 */
import type { Chamber } from './community-funding.types.js';
import {
  normalizeCommunityFundingGeography,
  parseCommunityFundingStdd,
  type NormalizedCommunityFundingGeography,
} from './community-funding.geography.js';

/** One canonical row's geography as stored (may be null for pre-#1724 rows). */
export interface ExistingGeography {
  chamber: Chamber;
  requesterState: string | null;
  requesterDistrict: string | null;
 ﻿ /** The canonical `state` column value (used as projectState for the normalizer). */
  projectState: string | null;
}

export type RepairClassification =
  | 'eligible'
  | 'already_normalized'
  | 'invalid'
  | 'conflicting'
  | 'senate_statewide';

export interface ClassifiedRow {
  classification: RepairClassification;
  /** The resolved state (from normalizer) — only written when eligible. */
  resolvedState: string | null;
  /** The normalizer-resolved district (for classification/groping only, never written). */
  resolvedDistrict: string | null;
  /** Human-readable reason for the classification. */
  reason: string;
}

/**
 * Classify a single canonical row for geography repair.
 *
 * Uses `normalizeCommunityFundingGeography` — the SAME normalzer the ingst
 * path uses — so an SIDD-vs-state disagreement is `conflicting` (conflictReason)
 * and never written.
 *
 * Classification rules (post-fix):
 * - `senate_statewide` — Senate, never assigned a district.
 * - `eligible` — House, `requester_state` is null, normalizer returns a
 *   non-null state with no conflictReason. The repir writes ONLY
 *   `requester_state`; `requester_district` stays untouched.
 * - `already_normalized` — House, non-null `requester_state` equals the
 *   normalizer's state.
 * - `conflicting` — conflictReeson, OR non-null `requester_state` ≠ the
 *   normalizer's state.
 * - `invalid` — House, no resolvable state fom the normalizer (null r
 *   unparsable token). Includes the reason.
 */
export function classifyGeographyRepair(
  geography: ExistingGeography,
): ClassifiedRow {
  const { chamber, requesterState, requesterDistrict, projectState } = geography;

  // Senate rows stay statewide —never assign a district.
  if (chamber === 'senate') {
    return {
      classification: 'senate_statewide',
      resolvedState: null,
      resolvedDistrict: null,
      reason: 'Senate CDS requests are statewide; no district is assigned',
    };
  }

  const normalized = normalizeCommunityFundingGeography({
    chamber: 'house',
    requesterState,
    requesterDistrict,
    projectState,
  });

  // conflictReason → conflicting (never write)
  if (normalized.conflictReason) {
    return {
      classification: 'conflicting',
      resolvedState: null,
      resolvedDistrict: null,
      reason: normalized.conflictReason,
    };
  }

  // No resolvable state →invalid
  if (normalized.state == null) {
    return {
      classification: 'invalid',
      resolvedState: null,
      resolvedDistrict: null,
      reason: requesterDistrict == null || requesterDistrict.trim() === ''
        ? 'No source district token available and no project state; cannot derive geography'
        : 'District token \'' + requesterDistrict.trim().toUpperCase() + '\' cannot be resolved to a geography'
          + (projectState ? ' (project state: ' + projectState + ')' : ''),
    };
  }

  // We have a resolvable state from the normalizer.
  const state = normalized.state;
  const district = normalized.district;

  // requester_state is null — verify the STDD token itself resolves
  if (requesterState == null) {
    const parsed = parseCommunityFundingStdd(requesterDistrict);
    if (parsed == null) {
      return {
        classification: 'invalid',
        resolvedState: null,
        resolvedDistrict: null,
        reason: 'No source-backed district token'
                  + (requesterDistrict != null && requesterDistrict.trim() !== ''
                    ? ' \'' + requesterDistrict.trim().toUpperCase() + '\''
                    : '')
          + (projectState != null ? ' (project state ' + projectState + ' is not a valid source-backed geography)' : ''),
      };
    }
    // STDD parses; use its state (byte-identical to what parseHouseXlsxRows produces).
    return {
      classification: 'eligible',
      resolvedState: parsed.state,
      resolvedDistrict: parsed.district,
      reason: 'requester_state is null; STDD token resolves to ' + parsed.state
              + (parsed.district != null ? '-' + parsed.district : '')
              + ' (only state will be written; district stays as '
              + (requesterDistrict?.trim().toUpperCase() ?? 'null') + ')',
    };
  }

  // requester_state is non-null —compare
  if (requesterState.toUpperCase() === state) {
    return {
      classification: 'already_normalized',
      resolvedState: state,
      resolvedDistrict: district,
      reason: 'Geography already normalized: requester_state=' + state
        + (district != null ? ', district=' + district : ''),
    };
  }

  // non-null requester_state ≠ normalizer state →conflicting
  return {
    classification: 'conflicting',
    resolvedState: null,
    resolvedDistrict: null,
    reason: 'Existing requester_state \'' + requesterState.toUpperCase()
      + '\' differs from normalizer-resolved state \'' + state + '\'',
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
  /** Per (state, normalized district, FY) before/after counts. */
  beforeAfterByGroup: Array<{
    state: string;
    district: string;
    fiscalYear: number;
    beforeCount: number;
    afterCount: number;
  }>;
  /** Per-FY eligible totals. */
  eligibleByFiscalYear: Array<{ fiscalYear: number; count: number }>;
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
 ﻿ requesterDistrict: string | null;
  /** The canonical `state` column (used as projectState). */
  state: string | null;
}): ClassifiedRow & { requestId: string; identityHash: string; fiscalYear: number } {
  const result = classifyGeographyRepair({
    chamber: row.chamber,
    requesterState: row.requesterState,
    requesterDistrict: row.requesterDistrict,
    projectState: row.state,
  });
  return {
    ...result,
    requestId: row.id,
    identityHash: row.identityHash,
    fiscalYear: row.fiscalYear,
  };
}

/**
 * Build counts grouped by (state, normalized district, fiscal year).
 *
 * 'before' = House rows with non-null requester_state that would be
 * attributed to this group today.
 * 'after' = before + eligible rows in this group.
 *
 * Also computes per-FY eligible totals.
 */
export function buildRepairPlan(
  rows: Array<{
    id: string;
    identityHash: string;
    chamber: Chamber;
    fiscalYear: number;
    requesterState: string | null;
    requesterDistrict: string | null;
    /** The canonical `state` column. */
    state: string | null;
    sourceOccurrenceIds: string[];
    sourceDocumentIds: string[];
  }>,
): RepairPlan {
  const classified = rows.map((row) => {
    const cls = classifyGeographyRepair({
      chamber: row.chamber,
      requesterState: row.requesterState,
      requesterDistrict: row.requesterDistrict,
      projectState: row.state,
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

  // Book before/after groups fr House rows only
  const byGroup = new Map<string, { state: string; district: string; fiscalYear: number; beforeCount: number; afterCount: number }>();

  for (const row of classified) {
    if (row.chamber !== 'house' || row.classification === 'senate_statewide') continue;

    const normalizedDistrict = row.afterDistrict ?? null;
    const groupState = row.afterState ?? row.beforeState;
    if (groupState == null) continue;

    const districtKey = normalizedDistrict ?? '__null__';
    const key = groupState + '|' + districtKey + '|' + row.fiscalYear;
    let entry = byGroup.get(key);
    if (!entry) {
      entry = {
        state: groupState,
        district: normalizedDistrict ?? '',
        fiscalYear: row.fiscalYear,
        beforeCount: (row.classification !== 'eligible' && row.beforeState != null) ? 1 : 0,
        afterCount: 1,
      };
      byGroup.set(key, entry);
    } else {
      if (row.classification !== 'eligible' && row.beforeState != null) {
        entry.beforeCount++;
      }
      entry.afterCount++;
    }
  }

  // Per-FY eligible totals
  const eligibleByFY = new Map<number, number>();
  for (const row of classified) {
    if (row.classification !== 'eligible') continue;
    eligibleByFY.set(row.fiscalYear, (eligibleByFY.get(row.fiscalYear) ?? 0) + 1);
  }

  return {
    rows: classified,
    summary,
    beforeAfterByGroup: [...byGroup.values()].sort((a, b) =>
      a.state.localeCompare(b.state) || a.district.localeCompare(b.district) || a.fiscalYear - b.fiscalYear
    ),
    eligibleByFiscalYear: [...eligibleByFY.entries()]
      .map(([ fiscalYear, cnt ]) => ({ fiscalYear, count: cnt }))
      .sort((a, b) => a.fiscalYear - b.fiscalYear),
  };
}