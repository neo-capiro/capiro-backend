/**
 * Program-alias normalization + the generic-accounting-label stoplist.
 *
 * Hoisted from `apps/api/src/program-element/matching/alias-stoplist.ts` and
 * `PeProgramMatcherService.normalizeAlias`. Both are pure, and defense-api's
 * alias CRUD must agree with the pg_trgm index apps/api's matcher populates — a
 * divergent normalizer silently creates aliases that never match anything, so
 * this is a correctness boundary, not a convenience.
 */

/** Generic ONLY when they are the entire normalized label. */
const GENERIC_EXACT: ReadonlySet<string> = new Set<string>([
  'MISCELLANEOUS',
  'MISC',
  'OTHER',
  'VARIOUS',
  'CLASSIFIED',
  'CLASSIFIED PROGRAMS',
  'COMMON',
  'ENTERPRISE',
  'GENERAL',
  'SUPPORT',
  'OVERHEAD',
  'UNDISTRIBUTED',
  'TBD',
  'PENDING',
  'ADJUSTMENTS',
  'TRANSFER',
  'TRANSFERS',
  'ITEMS UNDISTRIBUTED',
  'SBIR',
  'STTR',
  'SBIR STTR',
]);

/**
 * Generic as the whole label OR as a leading token group (require a trailing
 * space so SBIRS / COMMON-X are not caught). Plurals listed explicitly.
 */
const GENERIC_PREFIXES: readonly string[] = [
  'CONGRESSIONAL ADD',
  'CONGRESSIONAL ADDS',
  'CONGRESSIONAL INTEREST',
  'CONGRESSIONAL DIRECTED',
  'CONGRESSIONALLY DIRECTED',
  'PROGRAM WIDE',
  'PROGRAMWIDE',
  'PROGRAM MANAGEMENT',
  'PROGRAM ADMINISTRATION',
  'MANAGEMENT SUPPORT',
  'MISSION SUPPORT',
  'GENERAL SUPPORT',
  'STUDIES AND ANALYSIS',
  'STUDIES ANALYSIS',
  'SMALL BUSINESS INNOVATION',
  'SMALL BUSINESS INNOVATIVE',
  'CROSS PROGRAM',
  'CROSS SERVICE',
];

/**
 * True when a normalized alias / title is a generic accounting category that must
 * not be used as match evidence. Empty/whitespace counts as generic (unusable).
 */
export function isGenericAlias(normalized: string | null | undefined): boolean {
  const s = (normalized ?? '').trim();
  if (!s) return true;
  if (GENERIC_EXACT.has(s)) return true;
  return GENERIC_PREFIXES.some((p) => s === p || s.startsWith(p + ' '));
}

/**
 * Unicode dash variants apps/api's normalizer folds to ASCII '-' before
 * stripping punctuation. Spelled as an explicit escape range so the source file
 * carries no non-ASCII bytes (the original inlines the literal characters).
 */
const UNICODE_DASHES = /[‐-―−]/g;

/**
 * Upper-cased, punctuation-stripped alias form. Must stay behaviourally
 * identical to `PeProgramMatcherService.normalizeAlias` — including the
 * unicode-dash unification, which defense-api's prior implementation dropped.
 */
export function normalizeAlias(s: string | null): string {
  return (s ?? '')
    .toUpperCase()
    .replace(UNICODE_DASHES, '-')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Allowed aliasType values (mirrors the schema doc-comment on program_alias.aliasType). */
export const ALIAS_TYPES = [
  'canonical',
  'acronym',
  'pe_title',
  'project_title',
  'p1_line_name',
  'mdap_name',
  'office_usage',
  'congressional',
  'sam_usage',
  'award_usage',
] as const;

export type AliasType = (typeof ALIAS_TYPES)[number];

export function isAllowedAliasType(aliasType: string): boolean {
  return (ALIAS_TYPES as readonly string[]).includes(aliasType);
}
