import { Prisma } from '@prisma/client';
import {
  facilityDistrictKey, peKeywordMatchesSql, type PeCandidateSignals, type PeQuery,
} from './client-pe-candidates.js';
import {
  combineRelevance, scoreCapabilityKeyword, scoreCapabilityPeDirect,
  scoreEcosystem, scoreFacilityDistrict, scorePriorAward,
} from './client-pe-relevance.scoring.js';

type Keyword = { peCode: string; term: string; sim: number };
type Award = { peCode: string; cnt: number; total: number };
type District = { peCode: string; state: string; district: string };
type Performer = { peCode: string; performer: string };

function groupByPe<T extends { peCode: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.peCode) ?? [];
    group.push(row);
    grouped.set(row.peCode, group);
  }
  return grouped;
}

function readAwards(query: PeQuery, codes: string[], signals: PeCandidateSignals, nameFloor: number) {
  return query<Award[]>(Prisma.sql`
    SELECT pe_code AS "peCode", COUNT(*)::int AS "cnt",
      COALESCE(SUM(amount), 0)::float8 AS "total"
    FROM federal_award WHERE pe_code = ANY(${codes}::text[]) AND (
      ${signals.uei ? Prisma.sql`recipient_uei = ${signals.uei}` : Prisma.sql`FALSE`}
      OR (contractor_name IS NOT NULL AND similarity(contractor_name, ${signals.name}) > ${nameFloor})
    ) GROUP BY pe_code
  `);
}

function readDistricts(query: PeQuery, codes: string[]) {
  return query<District[]>(Prisma.sql`
    SELECT DISTINCT pe_code AS "peCode", pop_state AS "state",
      pop_congressional_district AS "district"
    FROM federal_award WHERE pe_code = ANY(${codes}::text[])
      AND pop_state IS NOT NULL AND pop_congressional_district IS NOT NULL
  `);
}

function readPerformers(query: PeQuery, codes: string[], signals: PeCandidateSignals, nameFloor: number) {
  const names = [signals.name, ...signals.intelNames].map((name) => name.trim()).filter(Boolean);
  if (!names.length) return Promise.resolve<Performer[]>([]);
  return query<Performer[]>(Prisma.sql`
    WITH ecosystem AS (
      SELECT pe_code, performer AS name, NULL::text AS uei
      FROM program_element_performer
      WHERE pe_code = ANY(${codes}::text[]) AND is_named_company = true
      UNION ALL
      SELECT pe_code, contractor_name AS name, recipient_uei AS uei
      FROM federal_award WHERE pe_code = ANY(${codes}::text[]) AND contractor_name IS NOT NULL
    ), client_names AS (SELECT cn AS name FROM unnest(${names}::text[]) AS t(cn))
    SELECT DISTINCT e.pe_code AS "peCode", e.name AS "performer" FROM ecosystem e
    WHERE (${signals.uei ? Prisma.sql`e.uei = ${signals.uei}` : Prisma.sql`FALSE`})
      OR EXISTS (SELECT 1 FROM client_names c WHERE similarity(e.name, c.name) > ${nameFloor})
  `);
}

/** The existing facts/scorers, fetched once per path instead of once per PE.
 * The caller supplies the same tenant transaction's budget-bound query; no
 * public-client escape, new timeout, candidate truncation or score substitution.
 */
export async function scorePeCandidateBatch(
  query: PeQuery,
  signals: PeCandidateSignals,
  codes: string[],
  keywordFloor: number,
  nameFloor: number,
) {
  if (!codes.length) return [];
  const [keywords, awards, districts, performers] = await Promise.all([
    signals.keywordTerms.length
      ? query<Keyword[]>(peKeywordMatchesSql(signals.keywordTerms, keywordFloor, codes))
      : Promise.resolve<Keyword[]>([]),
    readAwards(query, codes, signals, nameFloor),
    signals.facilityDistricts.length ? readDistricts(query, codes) : Promise.resolve<District[]>([]),
    readPerformers(query, codes, signals, nameFloor),
  ]);
  const keywordGroups = groupByPe(keywords);
  const awardGroups = groupByPe(awards);
  const districtGroups = groupByPe(districts);
  const performerGroups = groupByPe(performers);
  const facilityKeys = signals.facilityDistricts.map((row) => facilityDistrictKey(row.state, row.district));
  return codes.map((peCode) => {
    const matches = keywordGroups.get(peCode) ?? [];
    const award = awardGroups.get(peCode)?.[0];
    const awardKeys = new Set((districtGroups.get(peCode) ?? []).map((row) => facilityDistrictKey(row.state, row.district)));
    const performerNames = [...new Set((performerGroups.get(peCode) ?? []).map((row) => row.performer).filter(Boolean))];
    return { peCode, ...combineRelevance([
      scoreCapabilityPeDirect({ matchedPeNumbers: signals.capabilityPeCodes.has(peCode) ? [peCode] : [] }),
      scoreCapabilityKeyword({ matchedKeywords: matches.map((row) => row.term), maxSimilarity: matches.reduce((max, row) => Math.max(max, row.sim), 0) }),
      scorePriorAward({ awardCount: award?.cnt ?? 0, totalAmountUsd: award?.total ?? 0 }),
      scoreFacilityDistrict({ matchedDistricts: [...new Set(facilityKeys.filter((key) => awardKeys.has(key)))].sort() }),
      scoreEcosystem({ performerNames }),
    ]) };
  });
}
