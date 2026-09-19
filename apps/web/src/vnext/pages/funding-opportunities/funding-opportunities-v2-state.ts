import {
  normalizeOpportunitySearchCriteria,
  OPPORTUNITY_LIFECYCLES_V2,
  OPPORTUNITY_SEARCH_MODES,
  type OpportunitySearchCriteriaV2,
  type OpportunityQueryMatchV2,
  type OpportunitySortDirectionV2,
  type OpportunitySortV2,
  type OpportunityTypeV2,
} from '@capiro/shared';

export const V2_QUERY_VERSION = '2';
export const PAGE_SIZES = [20, 50, 100] as const;
export const SOURCE_OPTIONS = [
  { value: 'grants_gov', label: 'Grants.gov' },
  { value: 'sam_gov', label: 'SAM.gov' },
  { value: 'agency_forecast', label: 'Agency forecast' },
  { value: 'dibbs', label: 'DLA DIBBS' },
  { value: 'sbir_sttr', label: 'SBIR / STTR' },
  { value: 'ca_portal', label: 'California Grants Portal' },
] as const;
export const TYPE_OPTIONS: readonly { value: OpportunityTypeV2; label: string }[] = [
  { value: 'grant', label: 'Grants' },
  { value: 'cooperative_agreement', label: 'Cooperative agreements' },
  { value: 'loan_assistance', label: 'Assistance / loans' },
  { value: 'contract', label: 'Contracts' },
  { value: 'solicitation', label: 'Solicitations' },
  { value: 'task_order_vehicle', label: 'Vehicles / task orders' },
  { value: 'presolicitation', label: 'Pre-solicitations' },
  { value: 'sources_sought', label: 'Sources sought' },
];
export const CONTRACT_TYPE_VALUES: readonly OpportunityTypeV2[] = [
  'contract',
  'solicitation',
  'task_order_vehicle',
  'presolicitation',
  'sources_sought',
];
export const LIFECYCLE_OPTIONS = [...OPPORTUNITY_LIFECYCLES_V2, 'post_award' as const].map(
  (value) => ({
    value,
    label:
      value === 'active'
        ? 'Active / open'
        : value === 'forecast'
          ? 'Forecasted'
          : value === 'post_award'
            ? 'Post-award information'
            : 'Closed / history',
  }),
);

export type V2FilterKey =
  | keyof Pick<
      OpportunitySearchCriteriaV2,
      | 'types'
      | 'lifecycle'
      | 'posted'
      | 'agencies'
      | 'sectors'
      | 'geography'
      | 'applicantTypes'
      | 'funding'
      | 'costShare'
      | 'methods'
      | 'disbursement'
      | 'grantPrerequisites'
      | 'setAsideCodes'
      | 'codes'
      | 'sources'
      | 'eligibility'
    >
  | 'deadlineWindow';
export interface V2FilterGroup {
  key: V2FilterKey;
  label: string;
  only?: 'Grants only' | 'Contracts only';
  note?: string;
  options: readonly { value: string; label: string }[];
}
const options = (...items: [string, string][]) => items.map(([value, label]) => ({ value, label }));
export const V2_FILTER_GROUPS: readonly V2FilterGroup[] = [
  {
    key: 'types',
    label: 'Opportunity type',
    note: 'Grant and contract types can be mixed in one search.',
    options: [
      { value: 'grant', label: 'Grants' },
      { value: 'cooperative_agreement', label: 'Cooperative agreements' },
      { value: 'loan_assistance', label: 'Loans and assistance' },
      { value: 'contract', label: 'Contracts' },
      { value: 'solicitation', label: 'Solicitations' },
      { value: 'task_order_vehicle', label: 'Task orders and vehicles' },
      { value: 'forecast', label: 'Forecasts' },
    ],
  },
  {
    key: 'lifecycle',
    label: 'Lifecycle and status',
    note: 'Values inside a group combine with OR.',
    options: options(
      ['active', 'Active / open'],
      ['forecast', 'Forecasted'],
      ['closed', 'Closed / history'],
      ['post_award', 'Post-award information'],
    ),
  },
  {
    key: 'deadlineWindow',
    label: 'Deadline window',
    note: 'Applies to application and response deadlines alike.',
    options: options(
      ['14d', 'Within 14 days'],
      ['30d', 'Within 30 days'],
      ['90d', 'Within 90 days'],
      ['180d', 'Within 180 days'],
      ['any', 'At any time'],
    ),
  },
  {
    key: 'posted',
    label: 'Posted / open date',
    note: 'Range',
    options: options(
      ['last_7_days', 'Last 7 days'],
      ['last_30_days', 'Last 30 days'],
      ['last_90_days', 'Last 90 days'],
      ['this_fiscal_year', 'This fiscal year'],
    ),
  },
  {
    key: 'agencies',
    label: 'Agency / department',
    note: 'Sub-agency and contracting office can be narrowed in Filters.',
    options: options(
      ['any', 'Any agency'],
      ['army', 'Department of the Army'],
      ['disa', 'DISA'],
      ['doe', 'Department of Energy'],
      ['nasa', 'NASA'],
      ['casgc', 'California Strategic Growth Council'],
      ['dla', 'Defense Logistics Agency'],
    ),
  },
  {
    key: 'sectors',
    label: 'Category / program area',
    options: options(
      ['defense electronics', 'Defense electronics'],
      ['autonomous systems', 'Autonomous systems'],
      ['energy resilience', 'Energy resilience'],
      ['climate resilience', 'Climate resilience'],
      ['health security', 'Health security'],
      ['logistics', 'Logistics and sealift'],
    ),
  },
  {
    key: 'geography',
    label: 'Geography',
    note: 'Applicant location, place of performance and service area.',
    options: options(
      ['national', 'National'],
      ['california', 'California'],
      ['michigan', 'Michigan'],
      ['washington', 'Washington'],
      ['virginia', 'Virginia'],
      ['oconus', 'OCONUS'],
    ),
  },
  {
    key: 'applicantTypes',
    label: 'Eligibility / applicant type',
    options: options(
      ['forprofit', 'For-profit'],
      ['smallbiz', 'Small business'],
      ['nonprofit', 'Nonprofit'],
      ['localgov', 'Local government'],
      ['tribal', 'Tribal'],
      ['academic', 'Academic'],
    ),
  },
  {
    key: 'funding',
    label: 'Funding or contract value',
    note: 'Total available, ceiling or award range.',
    options: options(
      ['u1', 'Under $1M'],
      ['1to10', '$1M – $10M'],
      ['10to50', '$10M – $50M'],
      ['o50', 'Over $50M'],
      ['unstated', 'Value not stated'],
    ),
  },
  {
    key: 'costShare',
    label: 'Match or cost share',
    options: options(
      ['none', 'Not required'],
      ['required', 'Required'],
      ['under_25', 'Under 25%'],
      ['over_25', '25% or more'],
    ),
  },
  {
    key: 'methods',
    label: 'Application / response method',
    options: options(
      ['grantsgov', 'Grants.gov workspace'],
      ['agency', 'Agency portal'],
      ['email', 'Email submission'],
      ['samgov', 'SAM.gov response'],
    ),
  },
  {
    key: 'disbursement',
    label: 'Disbursement method',
    only: 'Grants only',
    options: options(
      ['reimbursements', 'Reimbursements'],
      ['advances', 'Advances'],
      ['both', 'Advances and reimbursements'],
      ['other', 'Other'],
    ),
  },
  {
    key: 'grantPrerequisites',
    label: 'Grant prerequisites',
    only: 'Grants only',
    options: options(
      ['loi', 'Letter of intent required'],
      ['noloi', 'No letter of intent'],
      ['match', 'Requires matched funding'],
    ),
  },
  {
    key: 'setAsideCodes',
    label: 'Set-aside and competition',
    only: 'Contracts only',
    options: options(
      ['unrestricted', 'Unrestricted'],
      ['tsb', 'Total small business'],
      ['sdvosb', 'SDVOSB'],
      ['eightA', '8(a)'],
      ['hubzone', 'HUBZone'],
    ),
  },
  {
    key: 'codes',
    label: 'Classification codes',
    note: 'NAICS, PSC, assistance listing and program element.',
    options: options(
      ['541715', 'NAICS 541715'],
      ['334511', 'NAICS 334511'],
      ['AR15', 'PSC AR15'],
      ['81.155', 'Assistance 81.155'],
      ['0603462A', 'PE 0603462A'],
      ['broader', 'Include broader code families'],
    ),
  },
  { key: 'sources', label: 'Data source', options: SOURCE_OPTIONS },
];
export const SORT_OPTIONS: readonly { value: OpportunitySortV2; label: string }[] = [
  { value: 'deadline', label: 'Deadline — soonest first' },
  { value: 'relevance', label: 'Relevance' },
  { value: 'title', label: 'Title' },
  { value: 'posted', label: 'Posted date' },
  { value: 'value', label: 'Value' },
  { value: 'agency', label: 'Agency' },
  { value: 'updated', label: 'Last updated' },
];

export const DEFAULT_V2_CRITERIA: OpportunitySearchCriteriaV2 = {
  schemaVersion: 2,
  mode: 'matched',
  clientId: null,
  query: '',
  sources: [],
  types: [],
  lifecycle: ['active'],
  agencies: [],
  sectors: [],
  naicsCodes: [],
  pscCodes: [],
  setAsideCodes: [],
  eligibility: [],
  posted: [],
  geography: [],
  applicantTypes: [],
  funding: [],
  costShare: [],
  methods: [],
  disbursement: [],
  grantPrerequisites: [],
  codes: [],
  deadlineWindow: 'any',
  deadlineFrom: null,
  deadlineTo: null,
  sort: 'deadline',
  direction: 'asc',
  page: 1,
  pageSize: 20,
};

const PARAM_TO_KEY = {
  source: 'sources',
  type: 'types',
  agency: 'agencies',
  sector: 'sectors',
  naics: 'naicsCodes',
  psc: 'pscCodes',
  setAside: 'setAsideCodes',
  eligibility: 'eligibility',
  posted: 'posted',
  geography: 'geography',
  applicantType: 'applicantTypes',
  funding: 'funding',
  costShare: 'costShare',
  method: 'methods',
  disbursement: 'disbursement',
  grantPrerequisite: 'grantPrerequisites',
  code: 'codes',
} as const;
type ParamKey = keyof typeof PARAM_TO_KEY;

function list(raw: string | null): string[] {
  return raw
    ? raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
function csv(values: readonly string[]): string | null {
  return values.length ? values.join(',') : null;
}

export function criteriaFromSearchParams(params: URLSearchParams): OpportunitySearchCriteriaV2 {
  const clientId = (params.get('client') ?? params.get('clientId'))?.trim() || null;
  const requestedMode = params.get('mode');
  const mode = clientId && requestedMode ? requestedMode : clientId ? DEFAULT_V2_CRITERIA.mode : 'all';
  const queryMatch = params.get('queryMatch');
  const raw: Record<string, unknown> = {
    schemaVersion: 2,
    mode,
    clientId,
    query: params.get('query') ?? params.get('q') ?? '',
    ...(queryMatch === 'keywords' || queryMatch === 'phrase'
      ? { queryMatch: queryMatch as OpportunityQueryMatchV2 }
      : {}),
    lifecycle: params.has('lifecycle')
      ? list(params.get('lifecycle'))
      : DEFAULT_V2_CRITERIA.lifecycle,
    deadlineWindow: params.get('deadlineWindow') ?? DEFAULT_V2_CRITERIA.deadlineWindow,
    deadlineFrom: params.get('deadlineFrom'),
    deadlineTo: params.get('deadlineTo'),
    sort: params.get('sort') ?? DEFAULT_V2_CRITERIA.sort,
    direction: params.get('direction') ?? DEFAULT_V2_CRITERIA.direction,
    page: params.get('page') ?? DEFAULT_V2_CRITERIA.page,
    pageSize: params.get('pageSize') ?? DEFAULT_V2_CRITERIA.pageSize,
  };
  for (const [parameter, key] of Object.entries(PARAM_TO_KEY))
    raw[key] = list(params.get(parameter));
  return normalizeOpportunitySearchCriteria(raw).criteria;
}

export function criteriaToSearchParams(criteria: OpportunitySearchCriteriaV2): URLSearchParams {
  const params = new URLSearchParams();
  params.set('v', V2_QUERY_VERSION);
  params.set('mode', criteria.mode);
  if (criteria.clientId) params.set('client', criteria.clientId);
  if (criteria.query) params.set('query', criteria.query);
  if (criteria.queryMatch) params.set('queryMatch', criteria.queryMatch);
  for (const [parameter, key] of Object.entries(PARAM_TO_KEY)) {
    const value = csv(criteria[key as keyof OpportunitySearchCriteriaV2] as string[]);
    if (value) params.set(parameter, value);
  }
  params.set('lifecycle', criteria.lifecycle.join(','));
  params.set('deadlineWindow', criteria.deadlineWindow);
  if (criteria.deadlineFrom) params.set('deadlineFrom', criteria.deadlineFrom);
  if (criteria.deadlineTo) params.set('deadlineTo', criteria.deadlineTo);
  params.set('sort', criteria.sort);
  params.set('direction', criteria.direction);
  params.set('page', String(criteria.page));
  params.set('pageSize', String(criteria.pageSize));
  return params;
}

export function criteriaToApiParams(criteria: OpportunitySearchCriteriaV2): URLSearchParams {
  const params = criteriaToSearchParams(criteria);
  params.delete('v');
  params.delete('client');
  params.set('clientId', criteria.clientId ?? '');
  return params;
}
export function updateCriteria(
  current: OpportunitySearchCriteriaV2,
  patch: Partial<OpportunitySearchCriteriaV2>,
): OpportunitySearchCriteriaV2 {
  return normalizeOpportunitySearchCriteria({ ...current, ...patch, schemaVersion: 2 }).criteria;
}

export function sortDirectionLabel(direction: OpportunitySortDirectionV2): string {
  return direction === 'asc' ? 'Ascending' : 'Descending';
}
export { OPPORTUNITY_SEARCH_MODES };
