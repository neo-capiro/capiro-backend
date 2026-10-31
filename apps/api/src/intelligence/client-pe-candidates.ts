import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RelevancePath } from './client-pe-relevance.scoring.js';

export const MAX_CANDIDATE_PES = 400;
export const PE_CANDIDATE_SQL_BUDGET_MS = 15_000;

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
type Query = <T>(sql: Prisma.Sql) => Promise<T>;

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

/** Finite server-side deadline for the complete candidate enumeration, not a
 * Promise.race that abandons active SQL. Connection wait consumes the same budget.
 */
export async function withPeCandidateDeadline<T>(
  prisma: Pick<PrismaService, '$transaction'>,
  work: (query: Query) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + PE_CANDIDATE_SQL_BUDGET_MS;
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms < 1) throw new Error('PE candidate query budget exceeded');
    return ms;
  };
  return prisma.$transaction(
    async (tx) => {
      const query: Query = async <R>(sql: Prisma.Sql) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${remaining()}ms`}, true)`;
        remaining();
        return tx.$queryRaw<R>(sql);
      };
      return work(query);
    },
    { maxWait: 1_000, timeout: PE_CANDIDATE_SQL_BUDGET_MS + 1_000 },
  );
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
  query: Query,
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
    const states = signals.facilityDistricts.map((d) => d.state.toUpperCase());
    const districts = signals.facilityDistricts.map((d) => d.district);
    byPath.facility_district = await query<PeRows>(Prisma.sql`
      SELECT DISTINCT upper(fa.pe_code) COLLATE "C" AS "peCode" FROM federal_award fa
      JOIN unnest(${states}::text[], ${districts}::text[]) AS d(state, district)
        ON upper(fa.pop_state) = d.state
        AND LTRIM(fa.pop_congressional_district, '0') = LTRIM(d.district, '0')
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
