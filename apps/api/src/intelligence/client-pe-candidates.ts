import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import type { RelevancePath } from './client-pe-relevance.scoring.js';

export const MAX_CANDIDATE_PES = 400;
export const PE_RELEVANCE_BUDGET_MS = 15_000;

// ECMAScript String.trim whitespace/line terminators. PostgreSQL's default
// btrim removes only spaces; use the same set for raw award data as the scorer.
export const FACILITY_TRIM_CHARACTERS =
  '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

export function normalizeFacilityState(state: string): string {
  return state.trim().toUpperCase();
}

/** Bare/zero-padded codes share a key; the empty result denotes at-large. */
export function normalizeDistrictForComparison(district: string): string {
  return district.trim().replace(/^0+/, '');
}

export function facilityDistrictKey(state: string, district: string): string {
  return `${normalizeFacilityState(state)}-${normalizeDistrictForComparison(district) || '00'}`;
}

/** SQL twin of the scorer's normalization, paired with normalized facility
 * parameters. Null award fields remain non-matches through SQL equality.
 */
function facilityDistrictJoinSql(): Prisma.Sql {
  return Prisma.sql`
    upper(BTRIM(fa.pop_state, ${FACILITY_TRIM_CHARACTERS})) = d.state
    AND LTRIM(BTRIM(fa.pop_congressional_district, ${FACILITY_TRIM_CHARACTERS}), '0') = d.district
  `;
}

export interface CandidateCoverage {
  complete: boolean;
  evaluated: number;
  limit: number;
  discoveredAtLeast: number;
  truncatedPaths: RelevancePath[];
  omittedPaths: RelevancePath[];
  totalScope: 'complete' | 'evaluated_candidates';
}

export interface PeCandidateSignals {
  uei: string | null;
  name: string;
  keywordTerms: string[];
  capabilityPeCodes: Set<string>;
  facilityDistricts: Array<{ state: string; district: string }>;
  intelNames: string[];
}

type PeRows = Array<{ peCode: string }>;
export type PeQuery = <T>(sql: Prisma.Sql) => Promise<T>;
export type PeRead = <T>(work: () => Promise<T>) => Promise<T>;

/** Shared by enumeration and scoring; same fields and existing50-snippet bound.
 * Ordering was previously unspecified. Stable IDs now select the same snippets
 * for both readers. Projects remain untruncated, as in the existing scorer.
 */
export function peKeywordMatchesSql(terms: string[], floor: number, peCode?: string): Prisma.Sql {
  return Prisma.sql`
    WITH pe_keyword_corpus AS (
      SELECT pe.pe_code,
        concat_ws(E' \n ', NULLIF(btrim(pe.title), ''), NULLIF(btrim(pe.description), ''),
          projects.content, sources.content) AS corpus
      FROM program_element pe
      LEFT JOIN LATERAL (
        SELECT string_agg(NULLIF(concat_ws(E' \n ', NULLIF(btrim(p.title), ''),
          NULLIF(btrim(p.mission), '')), ''), E' \n ' ORDER BY p.id) AS content
        FROM program_element_project p WHERE p.pe_code = pe.pe_code
      ) projects ON true
      LEFT JOIN LATERAL (
        SELECT string_agg(NULLIF(btrim(s.snippet), ''), E' \n ' ORDER BY s.id) AS content
        FROM (SELECT id, snippet FROM program_element_source
          WHERE pe_code = pe.pe_code ORDER BY id LIMIT 50) s
      ) sources ON true
      ${peCode === undefined ? Prisma.empty : Prisma.sql`WHERE pe.pe_code = ${peCode}`}
    )
    SELECT pe.pe_code AS "peCode", t.term AS "term", similarity(pe.corpus, t.term)::float8 AS "sim"
    FROM pe_keyword_corpus pe CROSS JOIN unnest(${terms}::text[]) AS t(term)
    WHERE pe.corpus <> '' AND similarity(pe.corpus, t.term) >= ${floor}
    ORDER BY "sim" DESC, t.term COLLATE "C"
  `;
}

/** One request work budget, created before acquiring the tenant transaction.
 * Every signal/discovery/scoring/title read uses the same remaining deadline.
 * Serialize the scorer's Promise.all calls so each SQL statement gets its own
 * actual remaining timeout, not a timeout calculated before another query waits.
 * Rollback/transport cleanup is awaited; this is not a hard HTTP latency promise.
 */
export function createPeRelevanceBudget() {
  const deadline = performance.now() + PE_RELEVANCE_BUDGET_MS;
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms < 1) throw new Error('PE relevance query budget exceeded');
    return ms;
  };
  return {
    remaining,
    bind(tx: Prisma.TransactionClient) {
      let tail = Promise.resolve();
      let failed = false;
      let failure: unknown;
      const read: PeRead = <T>(work: () => Promise<T>) => {
        const result = tail.then(async () => {
          if (failed) throw failure;
          await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${remaining()}ms`}, true)`;
          remaining();
          const value = await work();
          remaining();
          return value;
        });
        tail = result.then(
          () => undefined,
          (error: unknown) => {
            failed = true;
            failure = error;
          },
        );
        return result;
      };
      return {
        read,
        query: <T>(sql: Prisma.Sql) => read(() => tx.$queryRaw<T>(sql)),
      };
    },
  };
}

export function boundPeCandidates(byPath: Record<RelevancePath, PeRows>) {
  const paths = Object.keys(byPath) as RelevancePath[];
  const codes = [
    ...new Set(
      paths.flatMap((path) =>
        byPath[path].map((row) => row.peCode?.trim().toUpperCase()).filter(Boolean),
      ),
    ),
  ].sort();
  const truncatedPaths = paths.filter((path) => byPath[path].length > MAX_CANDIDATE_PES);
  const complete = truncatedPaths.length === 0 && codes.length <= MAX_CANDIDATE_PES;
  const selected = codes.slice(0, MAX_CANDIDATE_PES);
  const candidateCoverage: CandidateCoverage = {
    complete,
    evaluated: selected.length,
    limit: MAX_CANDIDATE_PES,
    discoveredAtLeast: codes.length,
    truncatedPaths,
    omittedPaths: [],
    totalScope: complete ? 'complete' : 'evaluated_candidates',
  };
  return { codes: selected, candidateCoverage };
}

export async function enumeratePeCandidates(
  query: PeQuery,
  signals: PeCandidateSignals,
  keywordFloor: number,
  nameFloor: number,
) {
  const probeLimit = MAX_CANDIDATE_PES + 1;
  const byPath: Record<RelevancePath, PeRows> = {
    capability_pe_direct: [...signals.capabilityPeCodes].map((peCode) => ({ peCode })),
    capability_keyword: [],
    prior_award: [],
    facility_district: [],
    ecosystem: [],
  };
  byPath.prior_award = await query<PeRows>(Prisma.sql`
    SELECT DISTINCT upper(pe_code) COLLATE "C" AS "peCode" FROM federal_award
    WHERE pe_code IS NOT NULL AND (
      ${signals.uei ? Prisma.sql`recipient_uei = ${signals.uei}` : Prisma.sql`FALSE`}
      OR (contractor_name IS NOT NULL AND similarity(contractor_name, ${signals.name}) > ${nameFloor})
    ) ORDER BY "peCode" LIMIT ${probeLimit}
  `);
  if (signals.facilityDistricts.length) {
    const states = signals.facilityDistricts.map((d) => normalizeFacilityState(d.state));
    const districts = signals.facilityDistricts.map((d) =>
      normalizeDistrictForComparison(d.district),
    );
    byPath.facility_district = await query<PeRows>(Prisma.sql`
      SELECT DISTINCT upper(fa.pe_code) COLLATE "C" AS "peCode" FROM federal_award fa
      JOIN unnest(${states}::text[], ${districts}::text[]) AS d(state, district)
        ON ${facilityDistrictJoinSql()}
      WHERE fa.pe_code IS NOT NULL ORDER BY "peCode" LIMIT ${probeLimit}
    `);
  }
  if (signals.keywordTerms.length) {
    byPath.capability_keyword = await query<PeRows>(Prisma.sql`
      WITH keyword_candidate_matches AS (${peKeywordMatchesSql(signals.keywordTerms, keywordFloor)})
      SELECT DISTINCT upper("peCode") COLLATE "C" AS "peCode" FROM keyword_candidate_matches
      ORDER BY "peCode" LIMIT ${probeLimit}
    `);
  }
  const names = [signals.name, ...signals.intelNames].map((name) => name.trim()).filter(Boolean);
  if (names.length) {
    byPath.ecosystem = await query<PeRows>(Prisma.sql`
      WITH ecosystem_candidates AS (
        SELECT pe_code, performer AS name, NULL::text AS uei FROM program_element_performer
        WHERE is_named_company = true
        UNION ALL
        SELECT pe_code, contractor_name AS name, recipient_uei AS uei FROM federal_award
        WHERE contractor_name IS NOT NULL
      )
      SELECT DISTINCT upper(e.pe_code) COLLATE "C" AS "peCode" FROM ecosystem_candidates e
      WHERE e.pe_code IS NOT NULL AND (
        ${signals.uei ? Prisma.sql`e.uei = ${signals.uei}` : Prisma.sql`FALSE`}
        OR EXISTS (SELECT 1 FROM unnest(${names}::text[]) AS c(name)
          WHERE similarity(e.name, c.name) > ${nameFloor})
      ) ORDER BY "peCode" LIMIT ${probeLimit}
    `);
  }
  return boundPeCandidates(byPath);
}
