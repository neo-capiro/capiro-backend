/**
 * UI-free logic shared by the canonical (antd) directory profile pages and
 * their vNext re-skins. Extracted from the antd-heavy profile files
 * (extraction pattern, Phase 2 vNext port): the legacy files import/re-export
 * from here so their public API is unchanged, and `src/vnext/**` imports this
 * module directly — never the antd files themselves (enforced by
 * `vnext/no-legacy-ui.contract.test.ts`).
 */
import type { StaffDetail } from './directory-api.js';

/** True when a value is a non-empty, non-whitespace string. */
export function hasText(v: string | null | undefined): v is string {
  return !!(v && String(v).trim());
}

export const NOT_PROVIDED = 'Not provided by source';

export function orNotProvided(value: string | null | undefined): string {
  return value && String(value).trim() ? String(value) : NOT_PROVIDED;
}

/** Office/staff addresses share one shape across member & staff details. */
export type OfficeAddress = StaffDetail['officeAddresses'][number];

/** upper => Senate, lower => House/Assembly; anything else shown verbatim. */
export function chamberLabel(chamber: string | null | undefined): string | null {
  if (!chamber) return null;
  const c = chamber.toLowerCase();
  if (c === 'upper') return 'Senate (upper)';
  if (c === 'lower') return 'House (lower)';
  return chamber;
}

/** WY's at-large convention; mirrors the API's own '00' path-segment code. */
export function districtLabel(district: { state: string; districtNo: string }): string {
  return district.districtNo === '00'
    ? `${district.state} At-Large`
    : `${district.state}-${district.districtNo}`;
}

/** Format a member's party/state/district into a compact "(D-CA-12)" style suffix. */
export function memberContext(m: {
  party: string | null;
  state: string | null;
  district: string | null;
}): string {
  const inner = [m.party, m.state, m.district].filter(Boolean).join('-');
  return inner ? `(${inner})` : '';
}

/** Whole-dollar USD, or null when the amount is unknown. */
export function usd(v: number | null): string | null {
  return v == null ? null : `$${Math.round(v).toLocaleString('en-US')}`;
}

/**
 * Whether there is in-app history to pop for a context-aware "back" link.
 * React Router v6 stamps a monotonic `idx` on history.state; idx === 0 means
 * this is the first entry in the app's history stack (a cold deep-link), so
 * there's nothing to go back to.
 */
export function historyCanGoBack(): boolean {
  const state = window.history.state as { idx?: number } | null;
  const idx = state && typeof state.idx === 'number' ? state.idx : 0;
  return idx > 0;
}

/**
 * Defensive normalization for a staff profile: never assume the arrays/objects
 * are present, so a shape drift can't blank the whole profile with a
 * client-side crash. Callers read the returned value and so transparently get
 * the guarded values.
 */
export function normalizeStaffDetail(rawStaff: StaffDetail): StaffDetail {
  return {
    ...rawStaff,
    bioDetails: rawStaff.bioDetails ?? ({} as StaffDetail['bioDetails']),
    emails: rawStaff.emails ?? [],
    socialContacts: rawStaff.socialContacts ?? [],
    officeAddresses: rawStaff.officeAddresses ?? [],
    positions: rawStaff.positions ?? [],
    memberAssociations: rawStaff.memberAssociations ?? [],
    committeeAssociations: rawStaff.committeeAssociations ?? [],
    issues: rawStaff.issues ?? [],
    roles: rawStaff.roles ?? [],
  };
}
