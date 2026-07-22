/**
 * Pure cross-directory normalization for the Targets tab. Kept free of React /
 * Clerk / axios imports so it is unit-testable in isolation and so the two very
 * different directory row shapes (congressional DirectoryEntry vs state
 * StateLegislatorRow) are collapsed to ONE shape before any render — the core of
 * "make the two-directory search robust so it doesn't crash".
 */
import type { DirectoryEntry } from '../directory/directoryData.js';
import type { DirectoryPersonRef } from '../directory/directory-api.js';
import type { StateLegislatorRow } from '../directory/StateLegislatorDirectory.js';
import type { TargetDirectory } from './targets-api.js';

/** One row shape for both directories, resolved before any render. */
export interface NormalizedPerson {
  id: string;
  sourceDirectory: TargetDirectory;
  name: string;
  /** Raw party as stored ('R' or 'Democratic'). */
  party: string | null;
  /** Collapsed to R/D/I for coloring + badge (handles both formats). */
  partyShort: 'R' | 'D' | 'I' | null;
  /** 2-char state code for filtering (district stripped). */
  stateCode: string | null;
  /** Display state (may include district, e.g. "TX-12"). */
  stateLabel: string | null;
  /** 'House' | 'Senate' — unified across upper/lower. */
  chamberLabel: 'House' | 'Senate' | null;
  committee: string | null;
  staffMatch: { fullName: string; title: string | null } | null;
}

/** Collapse either 'R'/'D'/'I' or 'Republican'/'Democratic'/'Independent' to a letter. */
export function partyShort(p: string | null | undefined): 'R' | 'D' | 'I' | null {
  const c = (p ?? '').trim().toUpperCase();
  if (!c) return null;
  if (c.startsWith('R')) return 'R';
  if (c.startsWith('D')) return 'D';
  return 'I';
}

/** Unify chamber: state 'upper'/'lower' and congress 'House'/'Senate' -> House|Senate. */
export function chamberCategory(chamber: string | null | undefined): 'House' | 'Senate' | null {
  const c = (chamber ?? '').trim().toLowerCase();
  if (!c) return null;
  if (c === 'senate' || c === 'upper') return 'Senate';
  if (c === 'house' || c === 'lower' || c === 'assembly') return 'House';
  return null;
}

/** Profile route for a target/result by its originating directory. */
export function profileHref(sourceDirectory: TargetDirectory, id: string): string {
  if (sourceDirectory === 'state') return `/directory/state-legislators/${encodeURIComponent(id)}`;
  if (sourceDirectory === 'staff') return `/directory/staff/${encodeURIComponent(id)}`;
  return `/directory/members/${encodeURIComponent(id)}`;
}

/** Last name from "Sen. Cornyn, John" / "Cornyn, John". */
export function lastNameOf(name: string): string {
  const head = name.includes(', ') ? name.split(', ')[0]! : name;
  return head.split(' ').pop() ?? head;
}

export function normalizeCongress(e: DirectoryEntry): NormalizedPerson {
  const stateCode = e.state ?? null;
  const stateLabel = e.chamber === 'House' && e.district ? e.district : e.state ?? null;
  const staff = e.matchedStaff?.[0];
  return {
    id: e.id,
    sourceDirectory: 'congress',
    name: e.fullName ?? e.id,
    party: e.party ?? null,
    partyShort: partyShort(e.party),
    stateCode,
    stateLabel,
    chamberLabel: chamberCategory(e.chamber),
    committee: e.committees?.[0] ?? null,
    staffMatch: staff ? { fullName: staff.fullName, title: staff.title ?? null } : null,
  };
}

export function normalizeStaff(ref: DirectoryPersonRef): NormalizedPerson {
  const stateCode = ref.state ?? null;
  return {
    id: ref.id, // "staff-{id}" — accepted by /directory/staff/:id
    sourceDirectory: 'staff',
    name: ref.fullName ?? ref.id,
    party: ref.party ?? null,
    partyShort: partyShort(ref.party),
    stateCode,
    stateLabel: stateCode ? (ref.district ? `${stateCode}-${ref.district}` : stateCode) : null,
    chamberLabel: null, // staffers aren't chamber-scoped
    committee: ref.title || null, // the office/committee role is the useful "where"
    staffMatch: null,
  };
}

export function normalizeState(r: StateLegislatorRow): NormalizedPerson {
  const stateCode = r.state ?? null;
  const stateLabel = stateCode ? (r.district ? `${stateCode}-${r.district}` : stateCode) : null;
  return {
    id: r.id,
    sourceDirectory: 'state',
    name: r.name ?? r.id,
    party: r.party ?? null,
    partyShort: partyShort(r.party),
    stateCode,
    stateLabel,
    chamberLabel: chamberCategory(r.chamber),
    committee: null,
    staffMatch: null,
  };
}
