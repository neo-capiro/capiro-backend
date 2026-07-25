/**
 * Resolve real district names/status for a set of DistrictKeys (WS-E1/E2).
 *
 * ── The join that does not work ─────────────────────────────────────────────
 *
 * The obvious implementation is `legislative_district.districtNo = districtCode`.
 * It is wrong twice over:
 *
 *   - `districtNo` is a BARE number string ("1", "25"), while a DistrictKey
 *     carries a zero-padded facility code ("01", "25"). So every single-digit
 *     district silently resolves to a null name.
 *   - LegiStorm reports a jurisdiction's SOLE House seat as "1", not "0" or
 *     null. So for an at-large state, `WY-00` matches nothing, and a naive
 *     numeric coercion would match the wrong row.
 *
 * `matchFacilityDistrictCode` already encodes both rules — at-largeness derived
 * from `US_HOUSE_SEATS` rather than trusted from the vendor value, and the
 * single-row requirement for an at-large match. This module exists so WS-E1 and
 * WS-E2 reach for it instead of hand-rolling a third variant of the join.
 *
 * Shape: ONE query for every state involved, then match in memory. Never one
 * query per district — the whole District Nexus read path is built on
 * one-query-per-rail, and a per-district lookup over 441 districts is exactly
 * the fan-out the service docblock exists to prevent.
 */
import { matchFacilityDistrictCode } from '../common/district-code.util.js';
import type { DistrictKey } from './district-nexus.types.js';

/** The subset of a LegislativeDistrict row this resolution needs. */
export interface LegislativeDistrictRow {
  state: string | null;
  districtNo: string | null;
  name: string | null;
  status: string | null;
}

export interface ResolvedDistrictName {
  name: string | null;
  /** 'C' current | 'F' future. Defaults to current when the row is silent. */
  status: 'C' | 'F';
}

/** Split `TX-23` into its parts. Returns null for anything malformed. */
export function splitDistrictKey(key: DistrictKey): { state: string; districtCode: string } | null {
  const idx = key.indexOf('-');
  if (idx <= 0 || idx === key.length - 1) return null;
  return { state: key.slice(0, idx), districtCode: key.slice(idx + 1) };
}

/**
 * Build a DistrictKey -> name/status map from already-fetched house rows.
 *
 * Pure and I/O-free so it is testable without a database, matching the rest of
 * the District Nexus aggregation layer. The caller does the single
 * `legislativeDistrict.findMany({ where: { state: { in: states }, chamber: 'house' } })`.
 *
 * A key with no matching row is ABSENT from the result rather than mapped to a
 * null name, so callers can tell "no name on record" from "we never looked".
 */
export function resolveDistrictNames(
  keys: DistrictKey[],
  rows: LegislativeDistrictRow[],
): Map<DistrictKey, ResolvedDistrictName> {
  const byState = new Map<string, LegislativeDistrictRow[]>();
  for (const row of rows) {
    if (!row.state) continue;
    const state = row.state.trim().toUpperCase();
    const bucket = byState.get(state);
    if (bucket) bucket.push(row);
    else byState.set(state, [row]);
  }

  const out = new Map<DistrictKey, ResolvedDistrictName>();
  for (const key of keys) {
    const parts = splitDistrictKey(key);
    if (!parts) continue;
    const candidates = byState.get(parts.state.toUpperCase());
    if (!candidates?.length) continue;
    const match = matchFacilityDistrictCode(candidates, parts.districtCode);
    if (!match) continue;
    out.set(key, { name: match.name, status: match.status === 'F' ? 'F' : 'C' });
  }
  return out;
}

/** Distinct states referenced by a set of keys — the `IN` list for the one query. */
export function statesForKeys(keys: DistrictKey[]): string[] {
  const states = new Set<string>();
  for (const key of keys) {
    const parts = splitDistrictKey(key);
    if (parts) states.add(parts.state.toUpperCase());
  }
  return [...states];
}
