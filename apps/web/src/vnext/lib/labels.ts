import { SECTOR_LABELS, normalizeSector } from '@capiro/shared';
import { formatMoney, formatNumber } from '../../pages/intelligence/district-nexus/district-nexus-format.js';

/**
 * Shared humanizers for the vNext Portfolio module.
 *
 * Production `sectorTag` values are a mixed vocabulary (see the open-findings
 * doc, 2026-07-27 §"sector"): sometimes a controlled `SectorTag` enum value
 * (`DEFENSE`), sometimes an enum-shaped import artifact outside the union
 * (`GOVERNMENT_AFFAIRS`), sometimes already-humanized free text ("Government
 * Affairs Technology"). Every render site that shows a sector must go through
 * `sectorLabel` so no raw `SNAKE_CASE` token ever reaches a user.
 *
 * Money and count formatting re-export the District Nexus helpers — the app's
 * one null-safe compact-money convention ($84.2M, never "$0.0M" for "no
 * figure") — so vNext surfaces stop hand-rolling `'$' + toLocaleString()`.
 */

export { formatMoney, formatNumber };

/** True for enum-shaped tokens: ALL_CAPS with underscores/digits only. */
function looksLikeEnumToken(value: string): boolean {
  return /^[A-Z0-9_]+$/.test(value) && value.length > 1;
}

/** `GOVERNMENT_AFFAIRS` → `Government Affairs`; `in_committee` → `In committee`. */
export function humanizeEnumToken(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1).replace(/\b(us|usa|fec|pac|lda|pe|ai|it|dc)\b/g, (m) => m.toUpperCase());
}

/**
 * Human label for a stored sector value, tolerant of the mixed vocabulary.
 * Returns `null` for null/blank input so callers keep their own empty state.
 */
export function sectorLabel(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const direct = (SECTOR_LABELS as Record<string, string>)[value];
  if (direct) return direct;
  const normalized = normalizeSector(value);
  if (normalized) return SECTOR_LABELS[normalized];
  if (looksLikeEnumToken(value)) {
    // Title-case each word for enum artifacts: GOVERNMENT_AFFAIRS → Government Affairs.
    return value
      .split(/[_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ');
  }
  return value;
}

/**
 * `Aug 12` for the current year, `Aug 12, 2024` otherwise — a timeline that
 * spans years must say so. Invalid/absent dates return `null` so the caller
 * decides the empty state.
 */
export function formatDateShort(iso: string | Date | null | undefined): string | null {
  if (!iso) return null;
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const withYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** LDA filing period ids as filed with the Senate → short human labels. */
const LDA_PERIODS: Record<string, string> = {
  first_quarter: 'Q1',
  second_quarter: 'Q2',
  third_quarter: 'Q3',
  fourth_quarter: 'Q4',
  mid_year: 'Mid-year',
  year_end: 'Year-end',
};

export function ldaPeriodLabel(period: string | null | undefined): string | null {
  const value = period?.trim();
  if (!value) return null;
  return LDA_PERIODS[value.toLowerCase()] ?? humanizeEnumToken(value);
}

/** Registry registrant/client names arrive ALL CAPS; title-case them for display. */
export function titleCaseName(name: string): string {
  if (!/^[^a-z]*$/.test(name)) return name; // already mixed case — leave it alone
  return name
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Llc|Llp|Inc|Pa|Pc|Usa|Us|Fka|Dba|Ii|Iii|Iv)\b/g, (m) => m.toUpperCase())
    .replace(/\bOf\b/g, 'of')
    .replace(/\bAnd\b/g, 'and')
    .replace(/\bThe\b/g, 'the')
    .replace(/^the\b/, 'The');
}

/** Party initial → spelled-out label, matching the canonical directory surfaces. */
export function partyLabel(party: string | null | undefined): string | null {
  const value = party?.trim().toUpperCase();
  if (!value) return null;
  if (value.startsWith('D')) return 'Democrat';
  if (value.startsWith('R')) return 'Republican';
  if (value.startsWith('I')) return 'Independent';
  return party ?? null;
}
