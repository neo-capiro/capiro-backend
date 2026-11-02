import { Prisma } from '@prisma/client';

/**
 * Whole-word / exact keyword matching for congress_bill lookups.
 *
 * Every tracked-bill, relevant-bill and tracker-candidate read on a cache miss
 * evaluates a client's keyword terms against every bill's title and policy area
 * and every bill subject. Typical clients carry 10-26 terms that match thousands
 * of the ~48k bills, so no index narrows the scan: on the preview clone (2
 * November 2026) PostgreSQL chose parallel sequential scans and ran one regex
 * per term per row (~27 regex passes over 147k subject rows and 48k bills),
 * about 2 s and three backends per statement, twice per read. Under real
 * client-page traffic that saturated the database and cancelled the reads at
 * the 5 s budget.
 *
 * The shape below gives the identical ordered result set (checked on all 21
 * term sets of the busiest tenant) for a fraction of the work:
 *   - All whole-word patterns become ONE alternation regex, so each row is
 *     matched in a single pass instead of once per term.
 *   - Subject names (~1k distinct) and policy areas (~33 distinct) are matched
 *     once per DISTINCT value, then joined back by plain equality. `OFFSET 0`
 *     keeps the planner from pushing the regex below the DISTINCT, which would
 *     put it back on every row.
 *   - Bill titles are unique per bill. A whole-word match is also a substring
 *     match, so `LIKE ANY('%term%')` (a plain substring test, ~25-70 ms over all
 *     titles) admits only candidate titles to the regex (~150-470 ms when run
 *     on every title). Both run on LOWER(title) with the same lowercased terms.
 * Measured on the preview clone: 1.0-2.1 s -> 0.2-0.65 s per statement in one
 * backend (alternation + distinct values), then 0.1-0.35 s with the title
 * prefilter. The equality (`= ANY`) clauses keep the exact-name match.
 */

/** Escape a term for use inside a POSIX regex, then wrap it in \m...\M word boundaries. */
function toWordBoundaryPattern(term: string): string {
  return `\\m${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`;
}

/** `%term%` for LIKE, with the LIKE metacharacters and the escape character taken literally. */
function toSubstringPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

/** One regex that matches when any of `wordPatterns` matches, or null when there are none. */
function anyWordPattern(wordPatterns: string[]): string | null {
  return wordPatterns.length ? wordPatterns.map((pattern) => `(?:${pattern})`).join('|') : null;
}

/** `LOWER(column) = ANY($terms) OR LOWER(column) ~ $anyWord`, or FALSE when there is nothing to match. */
function valueMatchSql(column: Prisma.Sql, lowerTerms: string[], pattern: string | null): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (lowerTerms.length) clauses.push(Prisma.sql`LOWER(${column}) = ANY(${lowerTerms}::text[])`);
  if (pattern) clauses.push(Prisma.sql`LOWER(${column}) ~ ${pattern}`);
  return clauses.length ? Prisma.sql`(${Prisma.join(clauses, ' OR ')})` : Prisma.sql`FALSE`;
}

/**
 * A parenthesized subquery producing DISTINCT `congress_bill.id`s whose title,
 * policy_area (on congress_bill) or subject name (on congress_bill_subject) matches
 * one of `terms` as a whole word or, for policy area and subject, by exact
 * case-insensitive name. The subject branch inner-joins congress_bill so orphaned subject
 * rows are excluded; the UNION de-duplicates.
 *
 * @param opts.congress            when set, restricts both branches to one Congress.
 * @param opts.includePolicyRegex  when false, omits the policy_area regex clause
 *                                 (the tracker candidate query never matched it).
 */
export function matchingBillIdsSql(
  terms: readonly string[],
  opts: { congress?: number; includePolicyRegex?: boolean } = {},
): Prisma.Sql {
  const includePolicyRegex = opts.includePolicyRegex ?? true;
  const congressFilter =
    opts.congress != null ? Prisma.sql`cb.congress = ${opts.congress} AND ` : Prisma.empty;
  const lowerTerms = terms.map((term) => term.toLowerCase());
  const pattern = anyWordPattern(lowerTerms.map(toWordBoundaryPattern));
  const policyMatch = valueMatchSql(Prisma.sql`area.policy_area`, lowerTerms, includePolicyRegex ? pattern : null);
  // Written as one AND inside the OR so the cheap substring test runs first;
  // the planner reorders only top-level quals.
  const titleMatch = pattern
    ? Prisma.sql`(LOWER(cb.title) LIKE ANY(${lowerTerms.map(toSubstringPattern)}::text[]) AND LOWER(cb.title) ~ ${pattern})`
    : Prisma.sql`FALSE`;
  const nameMatch = valueMatchSql(Prisma.sql`subject.name`, lowerTerms, pattern);

  return Prisma.sql`(
    SELECT cb.id
    FROM congress_bill cb
    WHERE ${congressFilter}(cb.policy_area IN (
      SELECT area.policy_area
      FROM (SELECT DISTINCT policy_area FROM congress_bill WHERE policy_area IS NOT NULL OFFSET 0) area
      WHERE ${policyMatch}
    ) OR ${titleMatch})
    UNION
    SELECT cb.id
    FROM congress_bill cb
    JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
    WHERE ${congressFilter}cbs.name IN (
      SELECT subject.name
      FROM (SELECT DISTINCT name FROM congress_bill_subject OFFSET 0) subject
      WHERE ${nameMatch}
    )
  )`;
}
