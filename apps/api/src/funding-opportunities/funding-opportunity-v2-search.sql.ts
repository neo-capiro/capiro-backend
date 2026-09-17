import { Prisma } from '@prisma/client';
import {
  applicantTypeKey,
  getClientOrganizationTypes,
  GRANTS_GOV_APPLICANT_TYPES,
  GRANTS_GOV_OTHER_APPLICANTS,
  GRANTS_GOV_UNRESTRICTED_APPLICANTS,
  isGrantsGovSourceEligibilityRule,
} from '@capiro/shared';
import type { OpportunitySearchCriteriaV2, OpportunitySourceV2, OpportunityTypeV2 } from '@capiro/shared';
import type {
  CatalogOpportunityRecord,
  OpportunityCatalogHealth,
  OpportunityCatalogSearchResult,
  OpportunityClientProfile,
} from './funding-opportunity-v2-search.service.js';
import { iso, mapSqlSearchRow } from './funding-opportunity-v2-search.sql-mapping.js';

const GRANT_TYPES: OpportunityTypeV2[] = ['grant', 'cooperative_agreement', 'loan_assistance'];
const CONTRACT_TYPES: OpportunityTypeV2[] = ['contract', 'solicitation', 'task_order_vehicle', 'presolicitation', 'sources_sought', 'forecast'];
const SET_ASIDE_APPLICABLE_TYPES: OpportunityTypeV2[] = CONTRACT_TYPES;
const SOURCE_VERBS: Record<OpportunitySourceV2, string> = {
  grants_gov: 'sync-grants',
  sam_gov: 'sync-sam-opportunities-all-federal',
  agency_forecast: 'sync-tango-forecasts',
  dibbs: 'sync-tango-dibbs',
  sbir_sttr: 'sync-tango-sbir',
  ca_portal: 'sync-california-grants',
};

export type SqlRow = {
  id: string;
  source_record_id: string;
  source: OpportunitySourceV2;
  title: string;
  agency: string | null;
  source_url: string | null;
  type: OpportunityTypeV2;
  lifecycle: 'active' | 'forecast' | 'closed' | 'post_award';
  posted_date: Date | null;
  deadline: Date | null;
  close_date: Date | null;
  is_pursuable: boolean;
  summary: string | null;
  naics_codes: string[];
  psc_codes: string[];
  set_aside: string | null;
  applicant_types: string[];
  geography: string[];
  value: number | null;
  value_basis: 'source_backed' | 'not_stated_by_source';
  sectors: string[];
  funding: string[];
  cost_share: string[];
  methods: string[];
  disbursement: string[];
  grant_prerequisites: string[];
  codes: string[];
  synced_at: Date | null;
  updated_at: Date | null;
  sort_title_key: string | null;
  sort_agency_key: string | null;
  source_facts: unknown;
  relevance_score: number | null;
  naics_match: boolean;
  psc_match: boolean;
  agency_match: boolean;
  capability_match: string | null;
  topical_match: string | null;
  eligibility_state: string | null;
  eligibility_reason: string | null;
  total_count: bigint | number;
  grants_count: bigint | number;
  contracts_count: bigint | number;
  active_count: bigint | number;
  closed_count: bigint | number;
  actual_unscored_count: bigint | number;
  naics_match_on: string | null;
  psc_match_on: string | null;
};

function list(values: string[]): Prisma.Sql {
  return values.length ? Prisma.sql`ARRAY[${Prisma.join(values)}]::text[]` : Prisma.sql`ARRAY[]::text[]`;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function anyValue(column: string, values: string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM unnest(${Prisma.raw(column)}) AS v(value) WHERE lower(v.value) = ANY (SELECT lower(x) FROM unnest(${list(values)}) AS x))`;
}

/** Return one actual source value from the client/source intersection. */
function matchedValue(column: string, values: string[]): Prisma.Sql {
  return Prisma.sql`(SELECT v.value FROM unnest(${Prisma.raw(column)}) AS v(value)
    WHERE lower(v.value) = ANY (SELECT lower(x) FROM unnest(${list(values)}) AS x)
    ORDER BY v.value LIMIT 1)`;
}

function textAny(column: string, values: string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM unnest(${Prisma.raw(column)}) AS v(value)
    WHERE EXISTS (SELECT 1 FROM unnest(${list(values.map(escapeLike))}) AS x
      WHERE lower(v.value) LIKE ('%' || lower(x) || '%') ESCAPE chr(92)))`;
}

const AGENCY_FILTER_ALIASES: Record<string, readonly [string, string]> = {
  army: ['department of the army', 'army'],
  disa: ['defense information systems agency', 'disa'],
  doe: ['department of energy', 'doe'],
  nasa: ['national aeronautics and space administration', 'nasa'],
  casgc: ['california strategic growth council', 'casgc'],
  dla: ['defense logistics agency', 'dla'],
};

function agencyFilter(values: string[], allowAny: boolean): Prisma.Sql {
  // `any` is a discovery sentinel emitted by the UI. It removes a result
  // restriction, but is not a client agency identity for matched evidence.
  if (values.some((value) => value.trim().toLowerCase() === 'any')) {
    if (allowAny) return Prisma.sql`TRUE`;
    values = values.filter((value) => value.trim().toLowerCase() !== 'any');
  }
  const checks = values.map((value) => {
    const key = value.trim().toLowerCase();
    const aliases = Object.values(AGENCY_FILTER_ALIASES).find(([fullName, acronym]) => key === fullName || key === acronym);
    if (!aliases) return textAny('ARRAY[agency]', [value]);
    const [fullName, acronym] = aliases;
    return Prisma.sql`EXISTS (SELECT 1 FROM unnest(ARRAY[agency]) AS v(value)
      WHERE lower(v.value) LIKE ('%' || lower(${fullName}) || '%') ESCAPE chr(92)
        OR lower(v.value) ~ ('(^|[^a-z0-9])' || lower(${acronym}) || '([^a-z0-9]|$)'))`;
  });
  return checks.length ? Prisma.sql`(${Prisma.join(checks, ' OR ')})` : Prisma.sql`FALSE`;
}

const ORGANIZATION_APPLICANT_TYPES = GRANTS_GOV_APPLICANT_TYPES.filter(
  (value) => !isGrantsGovSourceEligibilityRule(value),
);

// These are UI filter groups, not client organization types. Every target is
// drawn from the shared Grants.gov labels so a short alias cannot silently
// become a second taxonomy or widen client eligibility.
const APPLICANT_FILTER_ALIASES: Record<string, readonly string[]> = {
  forprofit: [GRANTS_GOV_APPLICANT_TYPES[12]],
  smallbiz: [GRANTS_GOV_APPLICANT_TYPES[13]],
  nonprofit: [GRANTS_GOV_APPLICANT_TYPES[1], GRANTS_GOV_APPLICANT_TYPES[9]],
  localgov: [GRANTS_GOV_APPLICANT_TYPES[7], GRANTS_GOV_APPLICANT_TYPES[8], GRANTS_GOV_APPLICANT_TYPES[10], GRANTS_GOV_APPLICANT_TYPES[11]],
  tribal: [GRANTS_GOV_APPLICANT_TYPES[2], GRANTS_GOV_APPLICANT_TYPES[6]],
  academic: [GRANTS_GOV_APPLICANT_TYPES[4], GRANTS_GOV_APPLICANT_TYPES[5]],
};

const CALIFORNIA_APPLICANT_FILTER_ALIASES: Record<string, readonly string[]> = {
  forprofit: ['Business'], smallbiz: ['Business'], business: ['Business'],
  nonprofit: ['Nonprofit'], localgov: ['Public Agency'], publicagency: ['Public Agency'],
  tribal: ['Tribal Government'], individual: ['Individual'], other: ['Other Legal Entity'],
};

function normalizedApplicantKey(value: string): string {
  return applicantTypeKey(value);
}

function expandedApplicantFilterValues(values: string[]): string[] {
  const expanded = values.flatMap((value) => APPLICANT_FILTER_ALIASES[normalizedApplicantKey(value)] ?? [value]);
  return [...new Map(expanded.map((value) => [normalizedApplicantKey(value), value])).values()];
}

function normalizedAny(column: string, values: string[]): Prisma.Sql {
  const keys = values.map(normalizedApplicantKey);
  return Prisma.sql`EXISTS (SELECT 1 FROM unnest(${Prisma.raw(column)}) AS v(value)
    WHERE lower(regexp_replace(trim(v.value), '\\s+', ' ', 'g')) = ANY (SELECT x FROM unnest(${list(keys)}) AS x))`;
}

function applicantAny(values: string[]): Prisma.Sql {
  return normalizedAny('applicant_types', expandedApplicantFilterValues(values));
}

function californiaApplicantAny(values: string[]): Prisma.Sql {
  const expanded = values.flatMap((value) => {
    const key = normalizedApplicantKey(value).replace(/[ _-]/g, '');
    return CALIFORNIA_APPLICANT_FILTER_ALIASES[key] ?? [value];
  });
  return textAny('applicant_types', expanded);
}

function unknownApplicantType(): Prisma.Sql {
  const allSourceTypes = [...ORGANIZATION_APPLICANT_TYPES, GRANTS_GOV_OTHER_APPLICANTS, GRANTS_GOV_UNRESTRICTED_APPLICANTS];
  return Prisma.sql`EXISTS (SELECT 1 FROM unnest(applicant_types) AS v(value)
    WHERE lower(regexp_replace(trim(v.value), '\\s+', ' ', 'g')) <> ALL(${list(allSourceTypes.map(normalizedApplicantKey))}))`;
}

function californiaApplicantValues(profile: OpportunityClientProfile): string[] {
  const values = new Set<string>();
  const clientTypes = new Set(getClientOrganizationTypes(profile.applicantTypes).map(applicantTypeKey));
  const has = (...types: readonly string[]) => types.some((type) => clientTypes.has(applicantTypeKey(type)));
  if (has(GRANTS_GOV_APPLICANT_TYPES[12], GRANTS_GOV_APPLICANT_TYPES[13])) values.add('Business');
  if (has(GRANTS_GOV_APPLICANT_TYPES[1], GRANTS_GOV_APPLICANT_TYPES[9])) values.add('Nonprofit');
  if (has(GRANTS_GOV_APPLICANT_TYPES[3], GRANTS_GOV_APPLICANT_TYPES[7], GRANTS_GOV_APPLICANT_TYPES[8], GRANTS_GOV_APPLICANT_TYPES[10], GRANTS_GOV_APPLICANT_TYPES[11], GRANTS_GOV_APPLICANT_TYPES[14])) values.add('Public Agency');
  if (has(GRANTS_GOV_APPLICANT_TYPES[2], GRANTS_GOV_APPLICANT_TYPES[6])) values.add('Tribal Government');
  if (has(GRANTS_GOV_APPLICANT_TYPES[16])) values.add('Individual');
  return [...values];
}

function eligibilityState(profile: OpportunityClientProfile, source: OpportunitySourceV2): Prisma.Sql {
  const clientTypes = getClientOrganizationTypes(profile.applicantTypes);
  const noClientType = clientTypes.length === 0;
  const californiaTypes = californiaApplicantValues(profile);
  const unrestricted = normalizedAny('applicant_types', [GRANTS_GOV_UNRESTRICTED_APPLICANTS]);
  const matched = clientTypes.length ? normalizedAny('applicant_types', clientTypes) : Prisma.sql`FALSE`;
  const californiaMatched = californiaTypes.length ? normalizedAny('applicant_types', californiaTypes) : Prisma.sql`FALSE`;
  const californiaUnknown = Prisma.sql`EXISTS (SELECT 1 FROM unnest(applicant_types) AS v(value) WHERE lower(trim(v.value)) NOT IN ('business', 'nonprofit', 'public agency', 'tribal government', 'individual', 'other legal entity') )`;
  const californiaAdditionalRestriction = Prisma.sql`nullif((source_facts::jsonb)->>'applicantTypeNotes', '') IS NOT NULL`;
  if (source === 'ca_portal') return Prisma.sql`CASE
    WHEN cardinality(applicant_types) = 0 OR ${noClientType ? Prisma.sql`TRUE` : Prisma.sql`FALSE`} THEN 'needs_review'
    WHEN ${californiaUnknown} OR ${normalizedAny('applicant_types', ['Other Legal Entity'])} THEN 'needs_review'
    WHEN ${californiaMatched} AND ${californiaAdditionalRestriction} THEN 'needs_review'
    WHEN ${californiaMatched} THEN 'eligible'
    ELSE 'ineligible' END`;
  return Prisma.sql`CASE
    WHEN cardinality(applicant_types) = 0 OR ${noClientType ? Prisma.sql`TRUE` : Prisma.sql`FALSE`} THEN 'needs_review'
    WHEN ${unrestricted} THEN 'eligible'
    WHEN ${matched} THEN 'eligible'
    WHEN ${normalizedAny('applicant_types', [GRANTS_GOV_OTHER_APPLICANTS])} OR ${unknownApplicantType()} THEN 'needs_review'
    ELSE 'ineligible' END`;
}

function eligibilityReason(profile: OpportunityClientProfile, source: OpportunitySourceV2): Prisma.Sql {
  const clientTypes = getClientOrganizationTypes(profile.applicantTypes);
  const noClientType = clientTypes.length === 0;
  const californiaTypes = californiaApplicantValues(profile);
  const unrestricted = normalizedAny('applicant_types', [GRANTS_GOV_UNRESTRICTED_APPLICANTS]);
  const matched = clientTypes.length ? normalizedAny('applicant_types', clientTypes) : Prisma.sql`FALSE`;
  const californiaMatched = californiaTypes.length ? normalizedAny('applicant_types', californiaTypes) : Prisma.sql`FALSE`;
  const californiaUnknown = Prisma.sql`EXISTS (SELECT 1 FROM unnest(applicant_types) AS v(value) WHERE lower(trim(v.value)) NOT IN ('business', 'nonprofit', 'public agency', 'tribal government', 'individual', 'other legal entity') )`;
  const californiaAdditionalRestriction = Prisma.sql`nullif((source_facts::jsonb)->>'applicantTypeNotes', '') IS NOT NULL`;
  if (source === 'ca_portal') return Prisma.sql`CASE
    WHEN cardinality(applicant_types) = 0 OR ${noClientType ? Prisma.sql`TRUE` : Prisma.sql`FALSE`} THEN 'The California source or client profile does not state enough applicant facts.'
    WHEN ${californiaUnknown} OR ${normalizedAny('applicant_types', ['Other Legal Entity'])} THEN 'The California source includes an additional or unrecognized applicant category; review its eligibility text.'
    WHEN ${californiaMatched} AND ${californiaAdditionalRestriction} THEN 'The client shares the source applicant category, but the source includes additional eligibility restrictions.'
    WHEN ${californiaMatched} THEN 'The client profile shares an applicant category stated by the California source.'
    ELSE 'The California source applicant categories do not include a client profile category.' END`;
  return Prisma.sql`CASE
    WHEN cardinality(applicant_types) = 0 OR ${noClientType ? Prisma.sql`TRUE` : Prisma.sql`FALSE`} THEN 'The source or client profile does not state a recognized applicant type.'
    WHEN ${unrestricted} THEN 'The notice accepts all recognized organization types; review its additional eligibility requirements.'
    WHEN ${matched} THEN 'The client profile shares an exact canonical organization type stated by the source.'
    WHEN ${normalizedAny('applicant_types', [GRANTS_GOV_OTHER_APPLICANTS])} OR ${unknownApplicantType()} THEN 'The source includes “Other” or an unrecognized applicant category; review its additional eligibility text.'
    ELSE 'The source applicant types do not include a client profile type.' END`;
}

function exactAny(column: string, values: string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM unnest(${Prisma.raw(column)}) AS v(value) WHERE lower(v.value) = ANY (SELECT lower(x) FROM unnest(${list(values)}) AS x))`;
}

function normalizedSetAsideKey(value: string): string {
  const key = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['tsb', 'totalsmallbusiness', 'smallbusiness', 'totalsmallbusinesssetaside', 'sba', 'sbasetaside'].includes(key)) return 'tsb';
  if (['sdvosb', 'sdvosbc', 'servicedisabledveteranownedsmallbusiness', 'service-disabledveteranownedsmallbusiness'].includes(key)) return 'sdvosb';
  if (['eighta', '8a', '8asetaside'].includes(key)) return '8a';
  if (['hubzone', 'hubzonesetaside'].includes(key)) return 'hubzone';
  if (['unrestricted', 'unrestrictedcompetition', 'fullandopen'].includes(key)) return 'unrestricted';
  return key;
}

function normalizedSetAsideSql(column: string): Prisma.Sql {
  // Lowercase before stripping punctuation. regexp_replace's character class
  // is case-sensitive, so stripping `SBA` before lowercasing misses the alias.
  const compact = `regexp_replace(lower(trim(${column})), '[^a-z0-9]', '', 'g')`;
  return Prisma.sql`CASE
    WHEN ${Prisma.raw(compact)} IN ('sba', 'tsb', 'totalsmallbusiness', 'smallbusiness', 'totalsmallbusinesssetaside') THEN 'tsb'
    WHEN ${Prisma.raw(compact)} IN ('sdvosb', 'sdvosbc', 'servicedisabledveteranownedsmallbusiness') THEN 'sdvosb'
    WHEN ${Prisma.raw(compact)} IN ('8a', 'eighta', '8asetaside') THEN '8a'
    WHEN ${Prisma.raw(compact)} IN ('hubzone', 'hubzonesetaside', 'hzc') THEN 'hubzone'
    WHEN ${Prisma.raw(compact)} IN ('unrestricted', 'unrestrictedcompetition', 'fullandopen') THEN 'unrestricted'
    ELSE ${Prisma.raw(compact)} END`;
}

function setAsideFilterValues(values: string[]): string[] {
  return [...new Set(values.map(normalizedSetAsideKey).filter(Boolean))];
}

function codeFilter(values: string[]): Prisma.Sql {
  const broader = values.some((value) => value.toLowerCase() === 'broader');
  const codes = values.filter((value) => value.toLowerCase() !== 'broader');
  if (!codes.length) return Prisma.sql`TRUE`;
  const codeValues = list(codes.map((value) => value.toLowerCase()));
  const comparison = broader
    ? Prisma.sql`(lower(v.value) = ANY(${codeValues}) OR EXISTS (SELECT 1 FROM unnest(${codeValues}) AS wanted WHERE lower(v.value) LIKE lower(wanted) || '%') )`
    : Prisma.sql`lower(v.value) = ANY(${codeValues})`;
  return Prisma.sql`EXISTS (SELECT 1 FROM unnest(codes || naics_codes || psc_codes) AS v(value) WHERE ${comparison})`;
}

function californiaSectorValues(values: string[]): string[] {
  const mapped = new Set<string>();
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (key === 'climate resilience') mapped.add('environment_water');
    if (key === 'energy resilience') mapped.add('energy');
    if (key === 'health security') mapped.add('health');
    if (key === 'logistics and sealift' || key === 'logistics') mapped.add('transportation');
    if (key === 'autonomous systems' || key === 'defense electronics') mapped.add('defense');
  }
  return [...mapped];
}

function sectorFilter(source: OpportunitySourceV2, values: string[]): Prisma.Sql {
  if (source !== 'ca_portal') return textAny('sectors', values);
  const mapped = californiaSectorValues(values);
  if (!mapped.length) return Prisma.sql`FALSE`;
  return textAny('sectors', mapped);
}

function geographyFilter(values: string[]): Prisma.Sql {
  const aliases: Record<string, string[]> = {
    national: ['national', 'nationwide'], ca: ['ca', 'california'], california: ['ca', 'california'], mi: ['mi', 'michigan'], michigan: ['mi', 'michigan'],
    wa: ['wa', 'washington'], washington: ['wa', 'washington'], va: ['va', 'virginia'], virginia: ['va', 'virginia'], oconus: ['oconus'],
  };
  const expanded = values.flatMap((value) => aliases[value.trim().toLowerCase()] ?? [value]);
  return textAny('geography', expanded);
}

/** Canonical normalized source projection shared by search and bounded readers. */
export function sourceBase(source: OpportunitySourceV2): Prisma.Sql {
  switch (source) {
    case 'grants_gov':
      return Prisma.sql`SELECT 'grants_gov'::text source, g.id source_record_id, 'grants_gov:' || g.id id,
        g.title, g.agency, g.url source_url,
        CASE WHEN lower(coalesce(g.funding_instrument, '')) LIKE '%cooperative%' THEN 'cooperative_agreement'
          WHEN lower(coalesce(g.funding_instrument, '')) LIKE '%grant%' THEN 'grant' ELSE 'other' END type,
        CASE WHEN lower(coalesce(g.doc_type, '')) = 'forecast' OR lower(coalesce(g.status, '')) IN ('forecast','forecasted') THEN 'forecast'
          WHEN lower(coalesce(g.status, '')) IN ('closed','archived','expired') OR (g.close_date IS NOT NULL AND g.close_date < CURRENT_DATE) THEN 'closed'
          WHEN lower(coalesce(g.status, '')) IN ('posted','open','active') THEN 'active' ELSE 'closed' END lifecycle,
        g.open_date posted_date, g.close_date deadline, g.close_date close_date,
        ((lower(coalesce(g.doc_type, '')) <> 'forecast' AND lower(coalesce(g.status, '')) IN ('posted','open','active'))
          AND lower(coalesce(g.funding_instrument, '')) IN ('grant','cooperative agreement','cooperative_agreement')
          AND (g.close_date IS NULL OR g.close_date >= CURRENT_DATE)) is_pursuable,
        g.description summary, ARRAY[]::text[] naics_codes, ARRAY[]::text[] psc_codes, NULL::text set_aside,
        coalesce(g.eligibility, ARRAY[]::text[]) applicant_types, ARRAY[]::text[] geography,
        coalesce(g.estimated_funding, g.award_ceiling)::double precision value,
        CASE WHEN coalesce(g.estimated_funding, g.award_ceiling) IS NULL THEN 'not_stated_by_source' ELSE 'source_backed' END value_basis,
        COALESCE(ARRAY(SELECT DISTINCT activity_category.value->>'description' FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(g.raw #> '{synopsis,fundingActivityCategories}') = 'array'
            THEN g.raw #> '{synopsis,fundingActivityCategories}'
            WHEN jsonb_typeof(g.raw #> '{forecast,fundingActivityCategories}') = 'array'
            THEN g.raw #> '{forecast,fundingActivityCategories}' ELSE '[]'::jsonb END
        ) AS activity_category(value) WHERE nullif(activity_category.value->>'description', '') IS NOT NULL), ARRAY[]::text[]) sectors,
        CASE WHEN g.funding_instrument IS NULL THEN ARRAY[]::text[] ELSE ARRAY[g.funding_instrument] END funding,
        CASE WHEN g.cost_sharing IS NULL THEN ARRAY[]::text[] WHEN g.cost_sharing THEN ARRAY['required'] ELSE ARRAY['not_required'] END cost_share,
        ARRAY[]::text[] methods,
        ARRAY[]::text[] disbursement, ARRAY[]::text[] grant_prerequisites,
        coalesce(g.cfda_numbers, ARRAY[]::text[]) codes, g.synced_at synced_at, g.last_updated_at updated_at,
        jsonb_build_object('awardFloor', g.award_floor, 'awardCeiling', g.award_ceiling, 'estimatedFunding', g.estimated_funding,
          'expectedAwards', g.expected_awards, 'cfdaNumbers', g.cfda_numbers, 'eligibilityText', g.eligibility_text,
          'costSharing', g.cost_sharing, 'responseDateDesc', g.response_date_desc, 'category', g.category,
          'opportunityNumber', g.opportunity_number, 'postingDate', g.raw #>> '{synopsis,postingDate}',
          'postingDateStr', g.raw #>> '{synopsis,postingDateStr}', 'responseDate', g.raw #>> '{synopsis,responseDate}',
          'responseDateStr', g.raw #>> '{synopsis,responseDateStr}', 'lastUpdatedDate', g.raw #>> '{synopsis,lastUpdatedDate}',
          'agencyContactName', g.raw #>> '{synopsis,agencyContactName}', 'agencyContactEmail', g.raw #>> '{synopsis,agencyContactEmail}',
          'agencyContactPhone', g.raw #>> '{synopsis,agencyContactPhone}', 'fundingDescLinkUrl', g.raw #>> '{synopsis,fundingDescLinkUrl}',
          'applicantEligibilityDesc', g.raw #>> '{synopsis,applicantEligibilityDesc}',
          'sourceUpdated', g.last_updated_at, 'provenance', 'federal_grant') source_facts
        FROM federal_grant g`;
    case 'sam_gov':
      return Prisma.sql`SELECT 'sam_gov'::text source, s.id::text source_record_id, 'sam_gov:' || s.id::text id,
        s.title, s.agency, s.source_url,
        CASE lower(coalesce(s.notice_type, '')) WHEN 'presolicitation' THEN 'presolicitation' WHEN 'sources sought' THEN 'sources_sought'
          WHEN 'award notice' THEN 'award' WHEN 'solicitation' THEN 'solicitation' WHEN 'combined synopsis/solicitation' THEN 'solicitation' ELSE 'other' END type,
        CASE WHEN lower(coalesce(s.notice_type, '')) = 'award notice' THEN 'post_award'
          WHEN s.response_deadline IS NOT NULL AND s.response_deadline < CURRENT_TIMESTAMP THEN 'closed'
          WHEN s.archive_date IS NOT NULL AND s.archive_date < CURRENT_TIMESTAMP THEN 'closed'
          WHEN s.active IS TRUE AND lower(coalesce(s.notice_type, '')) IN ('solicitation','presolicitation','sources sought','combined synopsis/solicitation') THEN 'active'
          ELSE 'closed' END lifecycle,
        s.posted_date posted_date, s.response_deadline deadline, s.archive_date close_date,
        (coalesce(s.active, false) AND lower(coalesce(s.notice_type, '')) IN ('solicitation','presolicitation','sources sought','combined synopsis/solicitation')
          AND (s.response_deadline IS NULL OR s.response_deadline >= CURRENT_TIMESTAMP)
          AND (s.archive_date IS NULL OR s.archive_date >= CURRENT_TIMESTAMP) AND lower(coalesce(s.notice_type, '')) <> 'award notice') is_pursuable,
        s.description summary,
        CASE WHEN s.naics_code IS NULL THEN ARRAY[]::text[] ELSE ARRAY[s.naics_code] END naics_codes,
        CASE WHEN s.psc_code IS NULL THEN ARRAY[]::text[] ELSE ARRAY[s.psc_code] END psc_codes,
        coalesce(s.set_aside_code, s.set_aside) set_aside, ARRAY[]::text[] applicant_types,
        CASE WHEN jsonb_typeof(s.place_of_performance_jsonb->'state') = 'string' THEN ARRAY[s.place_of_performance_jsonb->>'state']
          WHEN jsonb_typeof(s.place_of_performance_jsonb->'state') = 'object' THEN ARRAY[s.place_of_performance_jsonb->'state'->>'code'] ELSE ARRAY[]::text[] END geography,
        NULL::double precision value, 'not_stated_by_source' value_basis, ARRAY[]::text[] sectors, ARRAY[]::text[] funding,
        ARRAY[]::text[] cost_share, ARRAY[]::text[] methods,
        ARRAY[]::text[] disbursement, ARRAY[]::text[] grant_prerequisites,
        ARRAY_REMOVE(ARRAY[s.naics_code, s.psc_code, s.set_aside_code, s.solicitation_number], NULL) codes,
        s.last_synced_at synced_at, CASE
          WHEN s.raw_jsonb->>'lastModifiedDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]+(Z|[+-][0-9]{2}:?[0-9]{2})$'
            AND pg_input_is_valid(s.raw_jsonb->>'lastModifiedDate', 'timestamptz')
          THEN (s.raw_jsonb->>'lastModifiedDate')::timestamptz ELSE NULL END updated_at,
        jsonb_build_object('noticeType', s.notice_type, 'baseType', s.base_type, 'solicitationNumber', s.solicitation_number,
          'noticeId', s.notice_id, 'postedDate', s.raw_jsonb->>'postedDate', 'responseDeadLine', s.raw_jsonb->>'responseDeadLine',
          'responseDeadline', s.response_deadline,
          'archiveDate', s.archive_date, 'sourceUpdated', s.raw_jsonb->>'lastModifiedDate',
          'setAside', s.set_aside, 'setAsideCode', s.set_aside_code, 'naicsCode', s.naics_code, 'pscCode', s.psc_code,
          'pocName', s.poc_name, 'pocEmail', s.poc_email, 'placeOfPerformance', s.place_of_performance_jsonb, 'description', s.description, 'provenance', 'sam_opportunity') source_facts
        FROM sam_opportunity s`;
    case 'agency_forecast':
      return Prisma.sql`SELECT 'agency_forecast'::text source, f.tango_forecast_id source_record_id, 'agency_forecast:' || f.tango_forecast_id id,
        f.title, coalesce(f.agency, f.organization_agency_name) agency, f.source_url,
        'forecast' type, 'forecast' lifecycle, NULL::date posted_date, NULL::date deadline, NULL::date close_date,
        false is_pursuable, f.description summary,
        CASE WHEN f.naics_code IS NULL THEN ARRAY[]::text[] ELSE ARRAY[f.naics_code] END naics_codes,
        CASE WHEN f.psc_code IS NULL THEN ARRAY[]::text[] ELSE ARRAY[f.psc_code] END psc_codes, f.set_aside,
        ARRAY[]::text[] applicant_types, CASE WHEN f.place_of_performance IS NULL THEN ARRAY[]::text[] ELSE ARRAY[f.place_of_performance] END geography,
        NULL::double precision value, 'not_stated_by_source' value_basis, ARRAY[]::text[] sectors, ARRAY[]::text[] funding,
        ARRAY[]::text[] cost_share, ARRAY[]::text[] methods, ARRAY[]::text[] disbursement, ARRAY[]::text[] grant_prerequisites,
        ARRAY_REMOVE(ARRAY[f.naics_code, f.psc_code, f.contract_vehicle], NULL) codes,
        f.last_synced_at synced_at, f.provider_modified_at updated_at,
        jsonb_build_object('anticipatedAwardDate', f.anticipated_award_date, 'externalId', f.external_id, 'estimatedPeriod', f.estimated_period,
          'sourceUpdated', f.provider_modified_at, 'sourceUrl', f.source_url, 'ingestedAt', f.last_synced_at, 'firstSyncedAt', f.first_synced_at,
          'fiscalYear', f.fiscal_year, 'contractVehicle', f.contract_vehicle, 'status', f.status,
          'organizationAgencyName', f.organization_agency_name, 'officeName', f.office_name,
          'primaryContactName', f.primary_contact_name, 'provenance', 'tango_procurement_forecast') source_facts
        FROM tango_procurement_forecast f`;
    case 'dibbs':
      return Prisma.sql`SELECT 'dibbs'::text source, d.tango_dibbs_id source_record_id, 'dibbs:' || d.tango_dibbs_id id,
        coalesce(d.nomenclature, d.solicitation) title, 'Defense Logistics Agency'::text agency, d.document_url source_url,
        'solicitation' type,
        CASE WHEN d.closes_date IS NOT NULL AND d.closes_date < CURRENT_DATE THEN 'closed' WHEN d.is_open IS TRUE THEN 'active' ELSE 'closed' END lifecycle,
        d.issued_date posted_date, d.closes_date deadline, d.closes_date close_date,
        (d.is_open IS TRUE AND (d.closes_date IS NULL OR d.closes_date >= CURRENT_DATE)) is_pursuable,
        d.nomenclature summary, ARRAY[]::text[] naics_codes, ARRAY[]::text[] psc_codes, d.set_aside,
        ARRAY[]::text[] applicant_types, ARRAY[]::text[] geography, NULL::double precision value, 'not_stated_by_source' value_basis,
        ARRAY[]::text[] sectors, ARRAY[]::text[] funding, ARRAY[]::text[] cost_share, ARRAY[]::text[] methods,
        ARRAY[]::text[] disbursement, ARRAY[]::text[] grant_prerequisites, ARRAY_REMOVE(ARRAY[d.nsn, d.part_number, d.status_code], NULL) codes,
        d.last_synced_at synced_at, NULL::timestamptz updated_at,
        jsonb_build_object('documentType', d.document_type, 'solicitation', d.solicitation, 'nsn', d.nsn, 'partNumber', d.part_number,
          'quantity', d.quantity, 'unitOfIssue', d.unit_of_issue, 'setAside', d.set_aside, 'statusCode', d.status_code,
          'buyerCode', d.buyer_code, 'techDocsUrl', d.tech_docs_url, 'providerOpen', d.is_open, 'provenance', 'tango_dibbs_solicitation') source_facts
        FROM tango_dibbs_solicitation d`;
    case 'sbir_sttr':
      return Prisma.sql`SELECT 'sbir_sttr'::text source, t.tango_sbir_id source_record_id, 'sbir_sttr:' || t.tango_sbir_id id,
        coalesce(t.title, t.topic_number, t.tango_sbir_id) title, t.agency, coalesce(t.topic_url, t.official_solicitation_url) source_url,
        'solicitation' type, CASE WHEN t.close_date IS NOT NULL AND t.close_date < CURRENT_DATE OR lower(coalesce(t.solicitation_status, '')) IN ('closed','expired','complete') THEN 'closed' ELSE 'active' END lifecycle,
        coalesce(t.release_date, t.open_date) posted_date, t.close_date deadline, t.close_date close_date,
        (t.close_date IS NULL OR t.close_date >= CURRENT_DATE) AND lower(coalesce(t.solicitation_status, '')) NOT IN ('closed','expired','complete') is_pursuable,
        NULL::text summary, ARRAY[]::text[] naics_codes, ARRAY[]::text[] psc_codes, NULL::text set_aside, ARRAY[]::text[] applicant_types,
        ARRAY[]::text[] geography, NULL::double precision value, 'not_stated_by_source' value_basis, ARRAY[]::text[] sectors,
        ARRAY_REMOVE(ARRAY[t.solicitation_number], NULL) funding, ARRAY[]::text[] cost_share, ARRAY[]::text[] methods,
        ARRAY[]::text[] disbursement, ARRAY[]::text[] grant_prerequisites, ARRAY_REMOVE(ARRAY[t.topic_number, t.solicitation_number], NULL) codes,
        t.last_synced_at synced_at, NULL::timestamptz updated_at,
        jsonb_build_object('topicNumber', t.topic_number, 'solicitationNumber', t.solicitation_number, 'activity', t.activity,
          'status', t.solicitation_status, 'year', t.year, 'provenance', 'tango_sbir_topic') source_facts
        FROM tango_sbir_topic t
        UNION ALL
        SELECT 'sbir_sttr', s.tango_sbir_id, 'sbir_sttr:' || s.tango_sbir_id, coalesce(s.title, s.tango_sbir_id), NULL::text,
          s.sol_download_url, 'solicitation', CASE WHEN s.end_date IS NOT NULL AND s.end_date < CURRENT_DATE OR lower(coalesce(s.solicitation_status, '')) IN ('closed','expired','complete') THEN 'closed' ELSE 'active' END,
          s.start_date, s.end_date, s.end_date, (s.end_date IS NULL OR s.end_date >= CURRENT_DATE) AND lower(coalesce(s.solicitation_status, '')) NOT IN ('closed','expired','complete'),
          NULL::text, ARRAY[]::text[], ARRAY[]::text[], NULL::text, ARRAY[]::text[], ARRAY[]::text[], NULL::double precision,
          'not_stated_by_source', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
          ARRAY_REMOVE(ARRAY[s.solicitation_number, s.program], NULL), s.last_synced_at, NULL::timestamptz,
          jsonb_build_object('solicitationNumber', s.solicitation_number, 'program', s.program, 'cycleName', s.cycle_name, 'outOfCycle', s.out_of_cycle,
            'status', s.solicitation_status, 'year', s.year, 'provenance', 'tango_sbir_solicitation')
        FROM tango_sbir_solicitation s`;
    case 'ca_portal':
      return Prisma.sql`SELECT 'ca_portal'::text source, c.portal_id source_record_id, 'ca_portal:' || c.portal_id id,
        coalesce(nullif(c.title, ''), 'California Grants Portal opportunity ' || c.portal_id) title,
        c.agency_dept agency, coalesce(nullif(c.grant_url, ''), nullif(c.agency_url, '')) source_url,
        CASE WHEN lower(coalesce(c.type, '')) LIKE '%loan%' AND lower(coalesce(c.type, '')) NOT LIKE '%grant%' THEN 'loan_assistance'
          WHEN lower(coalesce(c.type, '')) LIKE '%grant%' THEN 'grant' ELSE 'other' END type,
        CASE WHEN lower(coalesce(c.status, '')) LIKE '%forecast%' THEN 'forecast'
          WHEN lower(coalesce(c.status, '')) LIKE '%post%award%' THEN 'post_award'
          WHEN lower(coalesce(c.status, '')) IN ('closed','expired','complete','completed') OR (c.application_deadline_calendar_date IS NOT NULL AND c.application_deadline_calendar_date < CURRENT_DATE) THEN 'closed'
          WHEN lower(coalesce(c.status, '')) IN ('active','open','posted') THEN 'active' ELSE 'closed' END lifecycle,
        c.open_date_calendar_date posted_date, c.application_deadline_calendar_date deadline, c.application_deadline_calendar_date close_date,
        (lower(coalesce(c.status, '')) IN ('active','open','posted') AND (c.application_deadline_calendar_date IS NULL OR c.application_deadline_calendar_date >= CURRENT_DATE)) is_pursuable,
        coalesce(nullif(c.description, ''), nullif(c.purpose, '')) summary,
        ARRAY[]::text[] naics_codes, ARRAY[]::text[] psc_codes, NULL::text set_aside,
        coalesce(c.applicant_types, ARRAY[]::text[]) applicant_types,
        CASE WHEN nullif(c.geography, '') IS NULL THEN ARRAY[]::text[] ELSE ARRAY[c.geography] END geography,
        coalesce(c.estimated_available_funds_amount::double precision, c.estimated_amount_max::double precision) value,
        CASE WHEN c.estimated_available_funds_amount IS NULL AND c.estimated_amount_max IS NULL THEN 'not_stated_by_source' ELSE 'source_backed' END value_basis,
        ARRAY(SELECT DISTINCT mapped FROM (SELECT CASE WHEN lower(category) LIKE '%environment%' OR lower(category) LIKE '%water%' THEN 'ENVIRONMENT_WATER' WHEN lower(category) LIKE '%energy%' THEN 'ENERGY' WHEN lower(category) LIKE '%education%' THEN 'EDUCATION' WHEN lower(category) LIKE '%health%' OR lower(category) LIKE '%human services%' THEN 'HEALTH' WHEN lower(category) LIKE '%transport%' THEN 'TRANSPORTATION' WHEN lower(category) LIKE '%agricultur%' OR lower(category) LIKE '%food%' THEN 'AGRICULTURE' WHEN lower(category) LIKE '%veteran%' OR lower(category) LIKE '%military%' THEN 'DEFENSE' WHEN lower(category) LIKE '%science%' OR lower(category) LIKE '%technology%' OR lower(category) LIKE '%research%' THEN 'COMMERCE_TECH' ELSE NULL END mapped FROM unnest(coalesce(c.categories, ARRAY[]::text[])) AS category) mapped_values WHERE mapped IS NOT NULL) sectors,
        CASE WHEN nullif(c.funding_source, '') IS NULL THEN ARRAY[]::text[] ELSE ARRAY[c.funding_source] END funding,
        CASE
          WHEN lower(coalesce(c.matching_funds_raw, '')) LIKE '%not required%' THEN ARRAY['none', 'not_required']
          WHEN c.matching_funds_percent IS NOT NULL OR (lower(coalesce(c.matching_funds_raw, '')) LIKE '%required%' AND lower(coalesce(c.matching_funds_raw, '')) NOT LIKE '%not required%')
            THEN ARRAY_REMOVE(ARRAY['required', CASE WHEN c.matching_funds_percent < 25 THEN 'under_25' WHEN c.matching_funds_percent >= 25 THEN 'over_25' ELSE NULL END], NULL)
          ELSE ARRAY[]::text[] END cost_share,
        ARRAY(SELECT method FROM unnest(ARRAY[
          CASE WHEN c.electronic_submission_urls <> ARRAY[]::text[] THEN 'agency' ELSE NULL END,
          CASE WHEN c.electronic_submission_emails <> ARRAY[]::text[] THEN 'email' ELSE NULL END
        ]) AS method WHERE method IS NOT NULL) methods,
        CASE
          WHEN lower(coalesce(c.funding_method, '')) LIKE '%reimburse%' AND lower(coalesce(c.funding_method, '')) LIKE '%advance%' THEN ARRAY['reimbursements', 'advances', 'both']
          WHEN lower(coalesce(c.funding_method, '')) LIKE '%reimburse%' THEN ARRAY['reimbursements']
          WHEN lower(coalesce(c.funding_method, '')) LIKE '%advance%' THEN ARRAY['advances']
          WHEN lower(coalesce(c.funding_method, '')) LIKE '%other%' THEN ARRAY['other']
          ELSE ARRAY[]::text[] END disbursement,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN lower(coalesce(c.loi, '')) IN ('yes','required') THEN 'loi' WHEN lower(coalesce(c.loi, '')) IN ('no','not required') THEN 'noloi' ELSE NULL END,
          CASE WHEN c.matching_funds_percent IS NOT NULL OR (lower(coalesce(c.matching_funds_raw, '')) LIKE '%required%' AND lower(coalesce(c.matching_funds_raw, '')) NOT LIKE '%not required%') THEN 'match' ELSE NULL END
        ], NULL) grant_prerequisites,
        ARRAY_REMOVE(ARRAY[c.portal_id, c.grant_id], NULL) codes, c.ingested_at synced_at, c.last_updated_calendar_date updated_at,
        jsonb_build_object('provenance','california_grants_portal','portalId',c.portal_id,'grantId',c.grant_id,'statusRaw',c.status,'typeRaw',c.type,'lastUpdatedRaw',c.last_updated_raw,'lastUpdatedCalendarDate',c.last_updated_calendar_date,'categoriesRaw',c.categories_raw,'categories',c.categories,'purpose',c.purpose,'description',c.description,'applicantTypeRaw',c.applicant_type_raw,'applicantTypeNotes',c.applicant_type_notes,'geographyRaw',c.geography,'fundingSource',c.funding_source,'matchingFundsRaw',c.matching_funds_raw,'matchingFundsPercent',c.matching_funds_percent,'estimatedAvailableFundsRaw',c.estimated_available_funds_raw,'estimatedAvailableFundsAmount',c.estimated_available_funds_amount,'estimatedAwardsRaw',c.estimated_awards_raw,'estimatedAwardsCount',c.estimated_awards_count,'estimatedAmountsRaw',c.estimated_amounts_raw,'estimatedAmountMin',c.estimated_amount_min,'estimatedAmountMax',c.estimated_amount_max,'fundingMethod',c.funding_method,'openDateRaw',c.open_date_raw,'applicationDeadlineRaw',c.application_deadline_raw,'awardPeriod',c.award_period,'expectedAwardDate',c.expected_award_date,'electronicSubmissionRaw',c.electronic_submission_raw,'electronicSubmissionUrls',c.electronic_submission_urls,'electronicSubmissionEmails',c.electronic_submission_emails,'grantUrl',c.grant_url,'agencyUrl',c.agency_url,'contactInfo',c.contact_info,'awardStats',c.award_stats,'ingestedAt',c.ingested_at,'sourceRecordType','ca_grant_opportunity','sourceRecordKey',c.portal_id) source_facts
        FROM california_grant_opportunity c`;
  }
}

function commonWhere(source: OpportunitySourceV2, criteria: OpportunitySearchCriteriaV2, profile: OpportunityClientProfile | null, exactSourceRecordId?: string | readonly string[]): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (typeof exactSourceRecordId === 'string' && exactSourceRecordId) conditions.push(Prisma.sql`source_record_id = ${exactSourceRecordId}`);
  if (Array.isArray(exactSourceRecordId) && exactSourceRecordId.length) conditions.push(Prisma.sql`source_record_id IN (${Prisma.join(exactSourceRecordId)})`);
  if (criteria.query) conditions.push(Prisma.sql`lower(concat_ws(' ', id, source_record_id, title, agency, summary, array_to_string(geography, ' '), array_to_string(codes, ' '), array_to_string(applicant_types, ' '), array_to_string(naics_codes, ' '), array_to_string(psc_codes, ' '), array_to_string(sectors, ' '), array_to_string(funding, ' '), array_to_string(methods, ' '))) LIKE ${`%${escapeLike(criteria.query.toLowerCase())}%`} ESCAPE chr(92)`);
  if (criteria.types.length) {
    const types = criteria.types.flatMap((type) => type === 'contract' ? CONTRACT_TYPES : [type]);
    conditions.push(Prisma.sql`((source <> 'ca_portal' AND type = ANY(${list([...new Set(types)])})) OR (source = 'ca_portal' AND (type = ANY(${list([...new Set(types)])}) OR ('loan_assistance' = ANY(${list(criteria.types)}) AND lower(coalesce((source_facts::jsonb)->>'typeRaw','')) LIKE '%loan%'))))`);
  }
  if (criteria.lifecycle.length) conditions.push(Prisma.sql`lifecycle = ANY(${list(criteria.lifecycle)})`);
  if (criteria.agencies.length) conditions.push(agencyFilter(criteria.agencies, true));
  if (criteria.sectors.length) conditions.push(sectorFilter(source, criteria.sectors));
  if (criteria.naicsCodes.length) conditions.push(anyValue('naics_codes', criteria.naicsCodes));
  if (criteria.pscCodes.length) conditions.push(anyValue('psc_codes', criteria.pscCodes));
  if (criteria.setAsideCodes.length) conditions.push(Prisma.sql`(type <> ALL(${list(SET_ASIDE_APPLICABLE_TYPES)}) OR (set_aside IS NOT NULL AND ${normalizedSetAsideSql('set_aside')} = ANY(${list(setAsideFilterValues(criteria.setAsideCodes))})))`);
  if (criteria.geography.length) conditions.push(geographyFilter(criteria.geography));
  if (criteria.applicantTypes.length) conditions.push(Prisma.sql`((source = 'ca_portal' AND ${californiaApplicantAny(criteria.applicantTypes)}) OR (source <> 'ca_portal' AND (type <> ALL(${list(GRANT_TYPES)}) OR ${applicantAny(criteria.applicantTypes)})))`);
  if (criteria.funding.length) {
    const checks = criteria.funding.map((value) => value === 'u1' ? Prisma.sql`value IS NOT NULL AND value < 1000000` : value === '1to10' ? Prisma.sql`value >= 1000000 AND value <= 10000000` : value === '10to50' ? Prisma.sql`value > 10000000 AND value <= 50000000` : value === 'o50' ? Prisma.sql`value > 50000000` : value === 'unstated' ? Prisma.sql`value IS NULL` : Prisma.sql`FALSE`);
    conditions.push(Prisma.sql`(${Prisma.join(checks, ' OR ')})`);
  }
  if (criteria.costShare.length) {
    const values = criteria.costShare.map((value) => value === 'none' ? 'not_required' : value === 'req' ? 'required' : value);
    conditions.push(Prisma.sql`(type <> ALL(${list(GRANT_TYPES)}) OR ${exactAny('cost_share', values)})`);
  }
  if (criteria.methods.length) conditions.push(exactAny('methods', criteria.methods));
  if (criteria.disbursement.length) {
    const values = criteria.disbursement.map((value) => value === 'reimbursement' ? 'reimbursements' : value);
    conditions.push(Prisma.sql`(type <> ALL(${list(GRANT_TYPES)}) OR ${exactAny('disbursement', values)})`);
  }
  if (criteria.grantPrerequisites.length) {
    const values = criteria.grantPrerequisites.map((value) => value === 'loi_required' ? 'loi' : value === 'loi_not_required' ? 'noloi' : value);
    conditions.push(Prisma.sql`(type <> ALL(${list(GRANT_TYPES)}) OR ${exactAny('grant_prerequisites', values)})`);
  }
  if (criteria.codes.length) conditions.push(codeFilter(criteria.codes));
  if (criteria.posted.length && !criteria.posted.includes('any')) {
    const days = Math.max(...criteria.posted.map((value) => Number(value.replace('last_', '').replace('_days', ''))).filter(Number.isFinite));
    const postedConditions: Prisma.Sql[] = [];
    if (Number.isFinite(days)) postedConditions.push(Prisma.sql`posted_date IS NOT NULL AND posted_date >= CURRENT_TIMESTAMP - (${days} || ' days')::interval`);
    if (criteria.posted.includes('this_fiscal_year')) postedConditions.push(Prisma.sql`posted_date IS NOT NULL AND posted_date >= make_date(CASE WHEN extract(month FROM CURRENT_DATE) >= 10 THEN extract(year FROM CURRENT_DATE)::int ELSE extract(year FROM CURRENT_DATE)::int - 1 END, 10, 1)`);
    if (postedConditions.length) conditions.push(Prisma.sql`(${Prisma.join(postedConditions, ' OR ')})`);
  }
  if (criteria.deadlineFrom) conditions.push(Prisma.sql`deadline IS NOT NULL AND deadline >= ${new Date(criteria.deadlineFrom)}`);
  if (criteria.deadlineTo) conditions.push(Prisma.sql`deadline IS NOT NULL AND deadline <= ${new Date(criteria.deadlineTo)}`);
  if (criteria.deadlineWindow !== 'any') {
    const days = Number(criteria.deadlineWindow.replace('d', ''));
    conditions.push(Prisma.sql`deadline IS NOT NULL AND deadline >= CASE WHEN source IN ('grants_gov', 'dibbs', 'sbir_sttr', 'ca_portal') THEN CURRENT_DATE ELSE CURRENT_TIMESTAMP END AND deadline <= CASE WHEN source IN ('grants_gov', 'dibbs', 'sbir_sttr', 'ca_portal') THEN CURRENT_DATE + (${days} || ' days')::interval ELSE CURRENT_TIMESTAMP + (${days} || ' days')::interval END`);
  }
  if (criteria.eligibility.length && profile) {
    // `eligibility_state` is computed once in matchFlags/scored and reused
    // here, so filtering and the returned explanation cannot disagree.
    conditions.push(Prisma.sql`eligibility_state = ANY(${list(criteria.eligibility)})`);
  }
  return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}

function orderBy(criteria: OpportunitySearchCriteriaV2): Prisma.Sql {
  const expressions: Record<string, string> = { deadline: 'deadline', relevance: 'relevance_score', title: "convert_to(sort_title_key, 'UTF8')", posted: 'posted_date', value: 'value', agency: "convert_to(sort_agency_key, 'UTF8')", updated: 'updated_at' };
  const expression = expressions[criteria.sort] ?? expressions.deadline;
  const direction = criteria.direction === 'desc' ? 'DESC' : 'ASC';
  return Prisma.raw(`${expression} ${direction} NULLS LAST, convert_to(id, 'UTF8') ASC`);
}

export async function searchSourceSql(
  prisma: { withSystem<T>(fn: (tx: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> }) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> },
  source: OpportunitySourceV2,
  criteria: OpportunitySearchCriteriaV2,
  profile: OpportunityClientProfile | null,
  exactSourceRecordId?: string | readonly string[],
  explicitLimit?: number,
): Promise<OpportunityCatalogSearchResult> {
  const exactCapacity = Array.isArray(exactSourceRecordId)
    ? exactSourceRecordId.length * (source === 'sbir_sttr' ? 2 : 1)
    : Number.MAX_SAFE_INTEGER;
  const limit = Math.min(explicitLimit ?? (Array.isArray(exactSourceRecordId) ? exactCapacity : criteria.page * criteria.pageSize), exactCapacity);
  const matchFlags = profile ? Prisma.sql`
    CASE WHEN ${criteria.mode === 'matched' && profile.naicsCodes.length ? anyValue('naics_codes', profile.naicsCodes) : Prisma.sql`FALSE`} THEN true ELSE false END naics_match,
    CASE WHEN ${criteria.mode === 'matched' && profile.naicsCodes.length ? matchedValue('naics_codes', profile.naicsCodes) : Prisma.sql`NULL::text`} IS NOT NULL THEN ${criteria.mode === 'matched' && profile.naicsCodes.length ? matchedValue('naics_codes', profile.naicsCodes) : Prisma.sql`NULL::text`} ELSE NULL END naics_match_on,
    CASE WHEN ${criteria.mode === 'matched' && profile.pscCodes.length ? anyValue('psc_codes', profile.pscCodes) : Prisma.sql`FALSE`} THEN true ELSE false END psc_match,
    CASE WHEN ${criteria.mode === 'matched' && profile.pscCodes.length ? matchedValue('psc_codes', profile.pscCodes) : Prisma.sql`NULL::text`} IS NOT NULL THEN ${criteria.mode === 'matched' && profile.pscCodes.length ? matchedValue('psc_codes', profile.pscCodes) : Prisma.sql`NULL::text`} ELSE NULL END psc_match_on,
    CASE WHEN ${criteria.mode === 'matched' && profile.agencies.length ? agencyFilter(profile.agencies, false) : Prisma.sql`FALSE`} THEN true ELSE false END agency_match,
    CASE WHEN ${criteria.mode === 'matched' && (profile.capabilityPhrases ?? []).length ? Prisma.sql`EXISTS (SELECT 1 FROM unnest(${list((profile.capabilityPhrases ?? []).map(escapeLike))}) AS x WHERE lower(concat_ws(' ', title, summary, array_to_string(sectors, ' '))) LIKE '%' || lower(x) || '%' ESCAPE chr(92))` : Prisma.sql`FALSE`}
      THEN (SELECT x FROM unnest(${list((profile.capabilityPhrases ?? []).map(escapeLike))}) AS x WHERE lower(concat_ws(' ', title, summary, array_to_string(sectors, ' '))) LIKE '%' || lower(x) || '%' ESCAPE chr(92) ORDER BY length(x) DESC LIMIT 1)
      ELSE NULL END capability_match,
    CASE WHEN ${criteria.mode === 'matched' && profile.sectors.length ? Prisma.sql`EXISTS (SELECT 1 FROM unnest(${list(profile.sectors.map(escapeLike))}) AS x WHERE lower(concat_ws(' ', title, summary, array_to_string(sectors, ' '))) LIKE '%' || lower(x) || '%' ESCAPE chr(92))` : Prisma.sql`FALSE`}
      THEN (SELECT x FROM unnest(${list(profile.sectors.map(escapeLike))}) AS x WHERE lower(concat_ws(' ', title, summary, array_to_string(sectors, ' '))) LIKE '%' || lower(x) || '%' ESCAPE chr(92) ORDER BY length(x) DESC LIMIT 1)
      ELSE NULL END topical_match,
    ${eligibilityState(profile, source)} eligibility_state,
    ${eligibilityReason(profile, source)} eligibility_reason`
    : Prisma.sql`false naics_match, NULL::text naics_match_on, false psc_match, NULL::text psc_match_on, false agency_match, NULL::text capability_match, NULL::text topical_match, NULL::text eligibility_state, NULL::text eligibility_reason`;
  const query = Prisma.sql`
    WITH normalized AS (${sourceBase(source)}), flagged AS (
      SELECT normalized.*, ${matchFlags}
      FROM normalized
    ), scored AS (
      SELECT flagged.*, CASE WHEN flagged.naics_match OR flagged.psc_match THEN 85 WHEN flagged.agency_match THEN 45 WHEN flagged.capability_match IS NOT NULL THEN 30 WHEN flagged.topical_match IS NOT NULL THEN 10 ELSE NULL END::double precision relevance_score
      FROM flagged
    ), filtered AS (SELECT * FROM scored ${commonWhere(source, criteria, profile, exactSourceRecordId)}), stats AS (
      SELECT count(*) total_count, count(*) FILTER (WHERE type = ANY(${list(GRANT_TYPES)})) grants_count,
        count(*) FILTER (WHERE type = ANY(${list(CONTRACT_TYPES)})) contracts_count,
        count(*) FILTER (WHERE lifecycle = 'active') active_count, count(*) FILTER (WHERE lifecycle = 'closed') closed_count,
        count(*) FILTER (WHERE relevance_score IS NULL) actual_unscored_count
      FROM filtered
    )
    SELECT keyed.*, stats.* FROM (SELECT filtered.*, lower(filtered.title) AS sort_title_key, lower(coalesce(filtered.agency, '')) AS sort_agency_key FROM filtered) keyed CROSS JOIN stats ORDER BY ${orderBy(criteria)} LIMIT ${limit}`;
  const rows = await prisma.withSystem((tx) => tx.$queryRaw<SqlRow[]>(query), { timeoutMs: 20_000 });
  const first = rows[0];
  return {
    records: rows.map((row) => mapSqlSearchRow(row, criteria)),
    count: first ? Number(first.total_count) : 0,
    grantsCount: first ? Number(first.grants_count) : 0,
    contractsCount: first ? Number(first.contracts_count) : 0,
    activeCount: first ? Number(first.active_count) : 0,
    closedCount: first ? Number(first.closed_count) : 0,
    actualUnscoredCount: first ? Number(first.actual_unscored_count) : 0,
  };
}

export async function readSourceSql(
  prisma: { withSystem<T>(fn: (tx: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> }) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> },
  source: OpportunitySourceV2,
  criteria: OpportunitySearchCriteriaV2,
  profile: OpportunityClientProfile | null,
  exactSourceRecordId: string,
): Promise<OpportunityCatalogSearchResult> {
  return searchSourceSql(prisma, source, criteria, profile, exactSourceRecordId);
}

/**
 * Bounded exact-identity reader for board/detail consumers. It preserves the
 * canonical source projection and runs one query for one source, rather than
 * calling the single-record reader once per card. Returned rows retain the
 * provider's opaque sourceRecordId and sourceFacts provenance.
 */
export async function readExactSourceSql(
  prisma: { withSystem<T>(fn: (tx: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> }) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> },
  source: OpportunitySourceV2,
  criteria: OpportunitySearchCriteriaV2,
  profile: OpportunityClientProfile | null,
  sourceRecordIds: readonly string[],
  limit = sourceRecordIds.length * (source === 'sbir_sttr' ? 2 : 1),
): Promise<OpportunityCatalogSearchResult> {
  const ids = [...new Set(sourceRecordIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { records: [], count: 0, grantsCount: 0, contractsCount: 0, activeCount: 0, closedCount: 0, actualUnscoredCount: 0 };
  // A provider key is not a complete identity for SBIR/STTR: the topic and
  // solicitation rails may legitimately share it. The caller's limit is a
  // card/identity limit, so reserve two candidate rows per requested key and
  // let the consumer match the stored sourceRecordType exactly. Never let a
  // one-row SQL cap turn an ambiguous identity into an arbitrary first match.
  const candidateCapacity = source === 'sbir_sttr' ? ids.length * 2 : ids.length;
  const boundedLimit = Math.min(Math.max(1, source === 'sbir_sttr' ? limit * 2 : limit), candidateCapacity);
  return searchSourceSql(prisma, source, { ...criteria, page: 1, pageSize: boundedLimit }, profile, ids, boundedLimit);
}

export async function healthSql(
  prisma: { withSystem<T>(fn: (tx: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> }) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> },
  source: OpportunitySourceV2,
): Promise<OpportunityCatalogHealth> {
  const verb = SOURCE_VERBS[source];
  const rows = await prisma.withSystem((tx) => tx.$queryRaw<Array<{ record_count: bigint; active_count: bigint; status: string | null; error_count: number; latest_attempt_at: Date | null; last_success_at: Date | null }>>(Prisma.sql`
    WITH catalog AS (${sourceBase(source)}), latest AS (SELECT status, error_count FROM sync_run WHERE source = ${verb} ORDER BY started_at DESC LIMIT 1), successful AS
      (SELECT max(finished_at) last_success_at FROM sync_run WHERE source = ${verb} AND status = 'success' AND error_count = 0)
    SELECT (SELECT count(*) FROM catalog) record_count, (SELECT count(*) FROM catalog WHERE lifecycle = 'active') active_count,
      (SELECT status FROM latest) status, (SELECT error_count FROM latest) error_count,
      (SELECT coalesce(finished_at, started_at) FROM sync_run WHERE source = ${verb} ORDER BY started_at DESC LIMIT 1) latest_attempt_at,
      successful.last_success_at FROM successful`), { timeoutMs: 10_000 });
  const row = rows[0];
  if (!row) return { state: 'never_synced', recordCount: 0, activeRecordCount: 0, lastSyncedAt: null };
  const state = !row.status
    ? 'never_synced'
    : !row.last_success_at && row.status !== 'success'
      ? (Number(row.record_count) > 0 ? 'initial_partial' : 'degraded')
      : row.status !== 'success' || row.error_count > 0
        ? 'error_cached'
        : Date.now() - row.last_success_at!.getTime() > 48 * 3_600_000 ? 'stale' : 'current';
  return { state, recordCount: Number(row.record_count), activeRecordCount: Number(row.active_count), lastSyncedAt: iso(row.last_success_at), latestAttemptAt: iso(row.latest_attempt_at), lastSuccessAt: iso(row.last_success_at) };
}
