import { Prisma } from '@prisma/client';

/**
 * Index-backed whole-word / substring keyword matching for congress_bill lookups.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bill-relevance queries used to match with a single cross-table predicate:
 *
 *   FROM congress_bill cb LEFT JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
 *   WHERE LOWER(cbs.name)  = ANY($lower) OR LOWER(cbs.name)  ~ ANY($patterns)
 *      OR LOWER(cb.policy_area) = ANY($lower) OR LOWER(cb.policy_area) ~ ANY($patterns)
 *      OR LOWER(cb.title) ~ ANY($patterns)
 *
 * That shape can never use an index, for two independent reasons:
 *   1. `col ~ ANY(array)` is a ScalarArrayOpExpr, which a pg_trgm GIN index cannot
 *      serve — only per-pattern `col ~ $p` clauses become BitmapOr index scans.
 *   2. The OR spans two tables (cbs.name OR cb.title/policy_area), so the planner
 *      must materialize the full join and filter row-by-row regardless of indexes.
 *
 * The result was two sequential scans + a 160k-row join filter (~2s per call),
 * run once per client in the portfolio roll-up fan-out — the dominant writer-CPU
 * consumer during business hours.
 *
 * THE FIX
 * -------
 * Split the cross-table OR into a UNION of per-table branches, and emit each regex
 * as an explicit per-pattern OR (not `~ ANY`). Each branch then uses a functional
 * `gin_trgm_ops` index on LOWER(col) (migration 20260724010000): the equality
 * (`= ANY`), regex (`~`), and substring (`ILIKE`) operators are all trigram-served.
 * Measured on the live dev/prod DB: ~1965ms -> ~5-30ms, IDENTICAL result set
 * (validated: old vs new returned the same 14,763 bill ids, 0 difference), and the
 * indexes are used even under a forced generic plan (i.e. with bind parameters).
 *
 * DELIBERATELY NOT MIGRATED (federal_register_document, ~9.3k rows / 11MB — small
 * and cache-resident, so a seq scan is cheap and it is not a measured CPU driver):
 *   - IntelligenceService.findActiveRegulations  (LOWER(topics)/LOWER(title) ~ ANY)
 *   - IntelligenceService.getBillRegulationLinks (title/abstract ILIKE ANY, no prefilter)
 * If federal_register_document grows materially, give it functional gin_trgm_ops
 * indexes on lower(title)/lower(abstract) and rewrite both via this helper.
 */

/** Escape a term for use inside a POSIX regex, then wrap it in \m...\M word boundaries. */
export function toWordBoundaryPattern(term: string): string {
  return `\\m${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`;
}

/** Lowercase the terms and build their whole-word regex patterns in one pass. */
export function buildKeywordMatchTerms(terms: string[]): {
  lowerTerms: string[];
  wordPatterns: string[];
} {
  const lowerTerms = terms.map((t) => t.toLowerCase());
  const wordPatterns = lowerTerms.map(toWordBoundaryPattern);
  return { lowerTerms, wordPatterns };
}

/**
 * Build an index-friendly boolean fragment matching `columnSql` against terms:
 *
 *   ( columnSql = ANY($equality) OR columnSql ~ $p1 OR ... OR columnSql ILIKE $l1 OR ... )
 *
 * Regex/ILIKE clauses are emitted per-pattern (never `~ ANY` / `ILIKE ANY`) so the
 * planner can turn them into a BitmapOr over the trigram GIN index. Returns `FALSE`
 * when there is nothing to match — which yields the empty result set, exactly as the
 * original `= ANY('{}')` / `~ ANY('{}')` predicates did for empty inputs.
 */
export function columnKeywordMatchSql(
  columnSql: Prisma.Sql,
  opts: { equalityTerms?: string[]; regexPatterns?: string[]; ilikePatterns?: string[] },
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  const equalityTerms = opts.equalityTerms ?? [];
  if (equalityTerms.length) {
    clauses.push(Prisma.sql`${columnSql} = ANY(${equalityTerms}::text[])`);
  }
  for (const pattern of opts.regexPatterns ?? []) {
    clauses.push(Prisma.sql`${columnSql} ~ ${pattern}`);
  }
  for (const pattern of opts.ilikePatterns ?? []) {
    clauses.push(Prisma.sql`${columnSql} ILIKE ${pattern}`);
  }
  if (!clauses.length) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(clauses, ' OR ')})`;
}

/**
 * A parenthesized subquery producing DISTINCT `congress_bill.id`s whose title,
 * policy_area (on congress_bill) or subject name (on congress_bill_subject) matches
 * the given terms. UNION of per-table branches so each branch is index-backed; the
 * UNION de-duplicates. Provably equivalent to the original single cross-table OR
 * (the subject branch inner-joins congress_bill so orphaned subject rows are
 * excluded, matching the original LEFT JOIN anchored on congress_bill).
 *
 * @param opts.congress            when set, restricts both branches to one Congress.
 * @param opts.includePolicyRegex  when false, omits the policy_area regex clause
 *                                 (the tracker candidate query never matched it).
 */
export function matchingBillIdsSql(
  lowerTerms: string[],
  wordPatterns: string[],
  opts: { congress?: number; includePolicyRegex?: boolean } = {},
): Prisma.Sql {
  const includePolicyRegex = opts.includePolicyRegex ?? true;
  const congressFilter =
    opts.congress != null ? Prisma.sql`cb.congress = ${opts.congress} AND ` : Prisma.empty;

  const policyMatch = columnKeywordMatchSql(Prisma.sql`LOWER(cb.policy_area)`, {
    equalityTerms: lowerTerms,
    regexPatterns: includePolicyRegex ? wordPatterns : [],
  });
  const titleMatch = columnKeywordMatchSql(Prisma.sql`LOWER(cb.title)`, {
    regexPatterns: wordPatterns,
  });
  const nameMatch = columnKeywordMatchSql(Prisma.sql`LOWER(cbs.name)`, {
    equalityTerms: lowerTerms,
    regexPatterns: wordPatterns,
  });

  return Prisma.sql`(
    SELECT cb.id
    FROM congress_bill cb
    WHERE ${congressFilter}(${policyMatch} OR ${titleMatch})
    UNION
    SELECT cb.id
    FROM congress_bill cb
    JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
    WHERE ${congressFilter}${nameMatch}
  )`;
}
