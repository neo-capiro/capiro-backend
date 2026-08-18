import type { DirectoryContactNote, DirectoryEntry, Party } from './directoryData.js';

/**
 * Pure member-profile formatters and endpoint payload contracts, shared by the
 * canonical Directory (DirectoryPage / DirectoryMemberProfileModal, Ant Design)
 * and Directory vNext (MemberProfileModalVNext, design-system primitives).
 *
 * UI-FREE ON PURPOSE. This module must never import a component library, a
 * component module, or CSS: it is imported at runtime from `src/vnext`, whose
 * legacy-leak checker walks runtime import chains for anything that reaches
 * `antd`/`@ant-design` or non-vNext CSS. Keeping the logic here — rather than
 * duplicating it on each side — is what stops the two renderings of the same
 * profile from drifting apart on what the data means.
 */

/** Exported: shared with `DirectoryMemberProfileModal`, which renders member cards too. */
export function partyLabel(party: Party): string {
  if (party === 'D') return 'Democrat';
  if (party === 'R') return 'Republican';
  return 'Independent';
}

export function partyShortCode(party: Party): string | null {
  if (party === 'D' || party === 'R' || party === 'I') return party;
  return null;
}

export function stateDistrict(entry: DirectoryEntry): string {
  const state = entry.state || '';
  const district = entry.district || '';
  if (!state) return district;
  if (district && !district.includes(state)) return `${state}-${district}`;
  return district || state;
}

export function genderLabel(gender: DirectoryEntry['gender']): string {
  if (gender === 'F') return 'Female';
  if (gender === 'M') return 'Male';
  return 'Unknown';
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function yearFromDate(date: string): string {
  if (!date) return 'Unknown';
  return date.slice(0, 4);
}

/** Senate classes only go to III, so the general algorithm would be overkill. */
export function romanNumeral(value: number | null): string {
  return value === 1 ? 'I' : value === 2 ? 'II' : value === 3 ? 'III' : '';
}

export function formatNoteDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(date));
}

export function noteAuthor(note: DirectoryContactNote): string {
  const fullName = [note.createdBy?.firstName, note.createdBy?.lastName].filter(Boolean).join(' ');
  return fullName || note.createdBy?.email || 'Former user';
}

export function formatNewsDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/* ── Member-profile endpoint contracts ─────────────────────────────────────
   Response shapes of the four per-member endpoints the profile modal reads:
   `/api/directory/contacts/:id/{news,notes,representation-summary,fec-summary}`
   (notes reuses `DirectoryContactNote` from `directoryData.ts`). */

export interface MemberNewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string;
}

export interface MemberNewsPayload {
  contactId: string;
  memberName: string;
  newsPressUrl: string | null;
  rssFeedUrl: string | null;
  rssSource: string | null;
  items: MemberNewsItem[];
  lastSyncedAt: string | null;
  feedError: 'no_feed' | null;
}

export interface MemberRepresentationSummary {
  clients: Array<{
    clientId: string;
    clientName: string;
    facilities: Array<{ id: string; name: string }>;
  }>;
}

export interface MemberFecSummary {
  contactId: string;
  memberName: string | null;
  matchQuality: 'name_approximate';
  clients: Array<{
    clientId: string;
    clientName: string;
    mappedEmployer: string;
    totalAmount: number;
    contributionCount: number;
    latestContributionDate: string | null;
  }>;
  summary: { totalAmount: number; contributionCount: number; clientCount: number };
  disclaimer: string;
}

/**
 * Compliance fallback shown when the FEC summary payload carries no disclaimer
 * of its own. Both modals must show the same words, so the string lives here.
 */
export const FEC_FALLBACK_DISCLAIMER =
  'Source: public FEC filings, for informational purposes only — not legal or campaign-finance advice. ' +
  'Matches are approximate (by candidate name) and reflect individual filers, legally distinct from ' +
  'corporate/PAC giving. Not a recommendation to make any contribution. Verify at FEC.gov.';
