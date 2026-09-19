/**
 * Deterministic presentation data copied from the supplied Funding Opportunities
 * reference fragments. This module is testing-only data; it is not a production
 * API fallback and none of these records should be treated as live production data.
 *
 * The raw presentation shapes intentionally remain separate from the current API
 * models. In particular, ca_portal is retained here while the backend enum is in
 * progress, and the reference's display strings are not silently normalized.
 */

export type ReferenceTone =
  | 'plain'
  | 'gray'
  | 'muted'
  | 'brand'
  | 'success'
  | 'warn'
  | 'error'
  | 'purple'
  | 'cyan'
  | 'indigo'
  | 'moderate'
  | 'weak';

export interface ReferenceTag { label: string; tone: ReferenceTone; }
export interface ReferenceFact { label: string; value: string; tone: ReferenceTone; }
export interface ReferenceEvidence { label: string; tone: ReferenceTone; value: string; }
export interface ReferenceWhen { label: string; value: string; days: string; note: string; tone: ReferenceTone; }

export type ReferenceOpportunityKind = 'contract' | 'grant' | 'forecast';
export type ReferenceSourceKey =
  | 'sam_gov'
  | 'grants_gov'
  | 'ca_portal'
  | 'agency_forecast'
  | 'dibbs'
  | 'sbir_sttr';

export interface ReferenceOpportunityRow {
  id: string;
  kind: ReferenceOpportunityKind;
  source: ReferenceSourceKey;
  rule: string;
  href: string;
  tags: readonly ReferenceTag[];
  title: string;
  meta: string;
  summary: string;
  facts: readonly ReferenceFact[];
  band: readonly [string, ReferenceTone];
  reason: string;
  matchedOn: string;
  evCount: number;
  relevance: number;
  evidence: readonly ReferenceEvidence[];
  when: ReferenceWhen;
  canPursue: boolean;
  note: string;
  saved: boolean;
}

const tag = (label: string, tone: ReferenceTone): ReferenceTag => ({ label, tone });
const fact = (label: string, value: string, tone: ReferenceTone): ReferenceFact => ({ label, value, tone });
const evidence = (label: string, tone: ReferenceTone, value: string): ReferenceEvidence => ({ label, tone, value });

/** The six exact result-card records from original-reference/sections/sample-rows.js. */
export const referenceOpportunityRows = [
  {
    id: 'r1', kind: 'contract', source: 'sam_gov', rule: '#294E68', href: 'https://sam.gov/opp/W911QY-26-R-0148',
    tags: [tag('SAM.gov', 'cyan'), tag('Contract · solicitation', 'gray'), tag('Open', 'success'), tag('Recommended', 'brand')],
    title: 'Autonomous Ground Systems Integration and Sustainment Services',
    meta: 'Department of the Army · Army Contracting Command – Detroit Arsenal · W911QY-26-R-0148',
    summary: 'Integration, fielding and sustainment of autonomous ground vehicle kits across two brigade sets, with a government-owned autonomy stack and open interface requirements.',
    facts: [
      fact('Posted', 'Jul 22, 2026', 'plain'), fact('Eligibility', 'Unrestricted', 'plain'),
      fact('Place of performance', 'Warren, MI', 'plain'), fact('Ceiling', '$48,000,000', 'plain'),
      fact('Award range', '$6M – $12M', 'plain'), fact('Cost share', 'Not applicable', 'muted'),
      fact('Vehicle', 'Not identified in notice', 'muted'), fact('Last updated', 'Aug 19, 2026', 'plain'),
    ],
    band: ['Strong fit', 'success'], reason: 'Exact NAICS match and two prior awards from this contracting office.',
    matchedOn: '541715 exact · ACC-DTA × 2 awards', evCount: 4, relevance: 78,
    evidence: [
      evidence('NAICS exact', 'success', '541715 — Research and development in the physical sciences'),
      evidence('Agency history', 'success', 'ACC-DTA · 2 awards since FY24'),
      evidence('Capability keywords', 'moderate', '“autonomy kit integration”, “vehicle sustainment”'),
      evidence('Place of performance', 'moderate', 'Warren, MI — 1 client facility within 40 mi'),
    ],
    when: { label: 'Response deadline', value: 'Sep 24', days: '8d', note: '2026 · 17:00 ET', tone: 'warn' },
    canPursue: true, note: '', saved: false,
  },
  {
    id: 'r2', kind: 'grant', source: 'grants_gov', rule: '', href: 'https://grants.gov/search-results-detail/DE-FOA-0003418',
    tags: [tag('Grants.gov', 'purple'), tag('Grant', 'gray'), tag('Open', 'success'), tag('Potential fit', 'moderate')],
    title: 'Grid Resilience and Innovation Partnerships — Utility Cyber Hardening',
    meta: 'Department of Energy · Grid Deployment Office · DE-FOA-0003418',
    summary: 'Formula and competitive awards for utility-side cyber hardening, sensing and grid situational awareness, including partnership structures with technology providers.',
    facts: [
      fact('Posted', 'Aug 04, 2026', 'plain'), fact('Eligible applicant', 'For-profit, nonprofit, tribal', 'plain'),
      fact('Category', 'Energy resilience', 'plain'), fact('Geography', 'National', 'plain'),
      fact('Total available', '$250,000,000', 'plain'), fact('Award range', '$2M – $25M', 'plain'),
      fact('Cost share', '50% required', 'warn'), fact('Disbursement', 'Reimbursements', 'plain'),
      fact('Letter of intent', 'Required by Sep 28', 'warn'), fact('Last updated', 'Sep 12, 2026', 'plain'),
    ],
    band: ['Potential fit', 'moderate'], reason: 'Sector alignment plus capability keywords — no code or award history.',
    matchedOn: 'sector: energy resilience · keywords × 3', evCount: 3, relevance: 64,
    evidence: [
      evidence('Sector alignment', 'moderate', 'Energy resilience — client sector 2 of 3'),
      evidence('Capability keywords', 'weak', '“grid sensing”, “situational awareness”'),
      evidence('Weak signal', 'weak', 'Topical overlap only — not evidence of fit on its own'),
    ],
    when: { label: 'Application deadline', value: 'Oct 30', days: '44d', note: '2026 · 23:59 ET', tone: 'plain' },
    canPursue: true, note: 'Weak topical overlap cannot raise this above potential fit on its own.', saved: false,
  },
  {
    id: 'r3', kind: 'grant', source: 'ca_portal', rule: '', href: 'https://www.grants.ca.gov/grants/community-resilience-centers-round-3/',
    tags: [tag('California Grants Portal', 'indigo'), tag('Grant', 'gray'), tag('Open', 'success'), tag('Saved', 'brand'), tag('Eligibility gap', 'error')],
    title: 'Community Resilience Centers Program — Round 3',
    meta: 'California Strategic Growth Council · Climate Resilience Division · SGC-CRC-26-R3 · Portal ID 12874',
    summary: 'Construction and retrofit of community resilience centers providing shelter during climate events. Technology and equipment costs are allowable only through an eligible lead applicant.',
    facts: [
      fact('Posted', 'Sep 02, 2026', 'plain'), fact('Eligible applicant', 'Local gov, tribes, nonprofits', 'error'),
      fact('Category', 'Climate resilience', 'plain'), fact('Geography', 'California', 'plain'),
      fact('Total available', '$115,000,000', 'plain'), fact('Award range', '$1M – $10M', 'plain'),
      fact('Cost share', 'Not required', 'plain'), fact('Disbursement', 'Advances and reimbursements', 'plain'),
      fact('Last updated', 'Sep 15, 2026', 'plain'),
    ],
    band: ['Not a fit — applicant type', 'error'], reason: 'For-profit entities are excluded as lead applicant.',
    matchedOn: 'eligibility: applicant type excluded', evCount: 2, relevance: 41,
    evidence: [
      evidence('Applicant type', 'error', 'For-profit excluded as lead applicant'),
      evidence('Partner route', 'moderate', 'Subrecipient role allowable — not evidenced for this client'),
    ],
    when: { label: 'Application deadline', value: 'Nov 14', days: '59d', note: '2026 · 17:00 PT', tone: 'plain' },
    canPursue: false, note: 'Kept in the list because an operator saved it. Pursue is hidden while the client cannot be a lead applicant.', saved: true,
  },
  {
    id: 'r4', kind: 'forecast', source: 'agency_forecast', rule: '#DC6803', href: 'https://www.disa.mil/procurement-forecast',
    tags: [tag('Agency forecast', 'warn'), tag('Forecast · early signal', 'warn')],
    title: 'Zero Trust Network Modernization — Enterprise Services',
    meta: 'DISA · Procurement Services Directorate · provider record TGO-118442',
    summary: 'Provider-sourced forecast entry. No solicitation exists yet; the agency status is “Planned” and no response mechanism has been published.',
    facts: [
      fact('Forecast published', 'Sep 09, 2026', 'plain'), fact('Estimated value', 'Not stated by source', 'muted'),
      fact('Set-aside', 'Not determined', 'muted'), fact('Place of performance', 'Fort Meade, MD', 'plain'),
      fact('Agency status', 'Planned', 'plain'), fact('Last updated', 'Sep 09, 2026', 'plain'),
    ],
    band: ['Early signal', 'warn'], reason: 'Forecast records are scored on scope text and office history only.',
    matchedOn: 'office history · scope text', evCount: 2, relevance: 52,
    evidence: [
      evidence('Office history', 'moderate', 'DISA PSD · 1 award since FY23'),
      evidence('Scope text', 'weak', '“zero trust”, “enterprise services”'),
    ],
    when: { label: 'Anticipated solicitation', value: 'Q2 FY27', days: '', note: 'No deadline exists yet', tone: 'plain' },
    canPursue: false, note: 'A forecast has no response path, so Pursue is not offered. Monitoring is the only action available.', saved: false,
  },
  {
    id: 'r5', kind: 'contract', source: 'dibbs', rule: '', href: 'https://www.dibbs.bsm.dla.mil/RFQ/SPE4A7-26-T-0219',
    tags: [tag('DLA bid board', 'cyan'), tag('Contract · request for quote', 'gray'), tag('Open', 'success'), tag('Partial data', 'warn')],
    title: 'Cargo restraint assembly, marine sealift — NSN 3990-01-628-7745',
    meta: 'Defense Logistics Agency · DLA Land and Maritime · SPE4A7-26-T-0219',
    summary: 'Line-item request for quote against an established national stock number. Quantity is firm; the source did not return an estimated value in the last successful run.',
    facts: [
      fact('Posted', 'Sep 08, 2026', 'plain'), fact('Quantity', '1,200 EA', 'plain'),
      fact('Set-aside', 'Total small business', 'plain'), fact('Estimated value', 'Not provided by source', 'muted'),
      fact('Place of performance', 'Norfolk, VA', 'plain'), fact('Delivery', '120 days after award', 'plain'),
      fact('Last updated', 'Sep 16, 2026 · 06:10 ET', 'warn'),
    ],
    band: ['Potential fit', 'moderate'], reason: 'NSN family matches two prior client quotes; value is unreadable.',
    matchedOn: 'NSN 3990 family · 2 prior quotes', evCount: 3, relevance: 58,
    evidence: [
      evidence('NSN family', 'moderate', '3990 — materials handling'),
      evidence('Quote history', 'moderate', '2 quotes submitted, FY25–FY26'),
      evidence('Source degraded', 'warn', 'Value fields not returned after 06:10 ET'),
    ],
    when: { label: 'Quote return', value: 'Sep 20', days: '4d', note: '2026 · 16:00 ET', tone: 'warn' },
    canPursue: true, note: '', saved: false,
  },
  {
    id: 'r6', kind: 'grant', source: 'grants_gov', rule: '', href: 'https://grants.gov/search-results-detail/NNH26ZDA001N',
    tags: [tag('Grants.gov', 'purple'), tag('Grant', 'gray'), tag('Closed', 'error'), tag('Pursued', 'brand')],
    title: 'Space Technology Research Institutes — Resilient Launch Access',
    meta: 'NASA · Space Technology Mission Directorate · NNH26ZDA001N-STRI',
    summary: 'Institute-scale awards for resilient launch access research. The submission window closed before the client completed its teaming arrangement.',
    facts: [
      fact('Posted', 'May 12, 2026', 'plain'), fact('Eligible applicant', 'Academic-led teams', 'plain'),
      fact('Category', 'Space systems', 'plain'), fact('Total available', '$18,000,000', 'plain'),
      fact('Award range', 'Not provided', 'muted'), fact('Cost share', 'Not required', 'plain'),
      fact('Closed', 'Aug 18, 2026', 'error'), fact('Last updated', 'Aug 20, 2026', 'plain'),
    ],
    band: ['Was strong fit', 'gray'], reason: 'Retained because the workspace marked it pursued before it closed.',
    matchedOn: 'assistance 43.012 · academic partner', evCount: 2, relevance: 71,
    evidence: [
      evidence('Assistance listing', 'success', '43.012 — Space Technology'),
      evidence('Partner signal', 'moderate', 'Confirmed academic partner on file'),
    ],
    when: { label: 'Closed', value: 'Aug 18', days: '', note: 'Observed closed 29 days ago', tone: 'error' },
    canPursue: false, note: 'Pursue is hidden on a closed notice. History and activity remain readable.', saved: true,
  },
] as const satisfies readonly ReferenceOpportunityRow[];

export interface ReferenceClient { id: string; name: string; init: string; meta: string; count: string; }
export const referenceClients = [
  { id: 'overland', name: 'Overland AI', init: 'OA', meta: 'Defense technology · Seattle, WA', count: '6 matched' },
  { id: 'aperture', name: 'Aperture Defense', init: 'AD', meta: 'Space systems · Colorado Springs, CO', count: '4 matched' },
  { id: 'halcyon', name: 'Halcyon Grid', init: 'HG', meta: 'Energy resilience · Austin, TX', count: '3 matched' },
  { id: 'cascade', name: 'Cascade Biosciences', init: 'CB', meta: 'Health security · Cambridge, MA', count: '5 matched' },
  { id: 'northwind', name: 'Northwind Logistics', init: 'NL', meta: 'Sealift and logistics · Norfolk, VA', count: '2 matched' },
] as const satisfies readonly ReferenceClient[];

export interface ReferenceOption { key: string; label: string; }
export interface ReferenceSegment { key: string; title: string; note?: string; multi: boolean; options: readonly ReferenceOption[]; }
export interface ReferenceFilterGroup { key: string; label: string; note?: string; only?: string; multi: boolean; options: readonly ReferenceOption[]; }

/** Client-facing options/groups copied from options.js; keys are reference UI keys. */
export const referenceSegments = [
  { key: 'status', title: 'Lifecycle', note: 'Values inside a group combine with OR.', multi: true, options: [
    { key: 'active', label: 'Active / open' }, { key: 'forecast', label: 'Forecasted' }, { key: 'closed', label: 'Closed / history' }, { key: 'postaward', label: 'Post-award information' },
  ] },
  { key: 'types', title: 'Opportunity type', note: 'Grant and contract types can be mixed in one search.', multi: true, options: [
    { key: 'grant', label: 'Grants' }, { key: 'coop', label: 'Cooperative agreements' }, { key: 'loan', label: 'Loans and assistance' }, { key: 'contract', label: 'Contracts' }, { key: 'solicitation', label: 'Solicitations' }, { key: 'vehicle', label: 'Task orders and vehicles' }, { key: 'forecast', label: 'Forecasts' },
  ] },
  { key: 'client', title: 'Client context', note: 'Relevance ranking and match explanations need a client.', multi: false, options: [
    { key: 'none', label: 'Any client — discovery mode' }, { key: 'overland', label: 'Overland AI' }, { key: 'aperture', label: 'Aperture Defense' }, { key: 'halcyon', label: 'Halcyon Grid' }, { key: 'cascade', label: 'Cascade Biosciences' }, { key: 'northwind', label: 'Northwind Logistics' },
  ] },
  { key: 'sector', title: 'Category / program area', note: 'Source categories are mapped to Capiro sectors.', multi: true, options: [
    { key: 'defelec', label: 'Defense electronics' }, { key: 'autonomy', label: 'Autonomous systems' }, { key: 'energy', label: 'Energy resilience' }, { key: 'climate', label: 'Climate resilience' }, { key: 'health', label: 'Health security' }, { key: 'logistics', label: 'Logistics and sealift' },
  ] },
  { key: 'agency', title: 'Agency / department', note: 'Sub-agency and contracting office can be narrowed in Filters.', multi: true, options: [
    { key: 'any', label: 'Any agency' }, { key: 'army', label: 'Department of the Army' }, { key: 'disa', label: 'DISA' }, { key: 'doe', label: 'Department of Energy' }, { key: 'nasa', label: 'NASA' }, { key: 'casgc', label: 'California Strategic Growth Council' }, { key: 'dla', label: 'Defense Logistics Agency' },
  ] },
  { key: 'deadline', title: 'Deadline window', note: 'Applies to application and response deadlines alike.', multi: false, options: [
    { key: '14', label: 'within 14 days' }, { key: '30', label: 'within 30 days' }, { key: '90', label: 'within 90 days' }, { key: '180', label: 'within 180 days' }, { key: 'any', label: 'at any time' },
  ] },
  { key: 'eligibility', title: 'Eligibility condition', note: 'Eligibility and relevance answer different questions.', multi: false, options: [
    { key: 'meets', label: 'the client meets stated eligibility' }, { key: 'unresolved', label: 'eligibility is unresolved' }, { key: 'any', label: 'eligibility is anything' },
  ] },
] as const satisfies readonly ReferenceSegment[];

export const referenceFilterGroups = [
  { key: 'types', label: 'Opportunity type', multi: true, options: [
    { key: 'grant', label: 'Grants' }, { key: 'coop', label: 'Cooperative agreements' }, { key: 'loan', label: 'Loans and assistance' }, { key: 'contract', label: 'Contracts' }, { key: 'solicitation', label: 'Solicitations' }, { key: 'vehicle', label: 'Task orders and vehicles' }, { key: 'forecast', label: 'Forecasts' },
  ] },
  { key: 'status', label: 'Lifecycle and status', multi: true, options: [] },
  { key: 'deadline', label: 'Deadline window', multi: true, options: [] },
  { key: 'posted', label: 'Posted / open date', note: 'Range', multi: true, options: [
    { key: '7', label: 'Last 7 days' }, { key: '30', label: 'Last 30 days' }, { key: '90', label: 'Last 90 days' }, { key: 'fy', label: 'This fiscal year' },
  ] },
  { key: 'agency', label: 'Agency / department', multi: true, options: [] },
  { key: 'sector', label: 'Category / program area', multi: true, options: [] },
  { key: 'geography', label: 'Geography', note: 'Applicant location, place of performance and service area.', multi: true, options: [
    { key: 'national', label: 'National' }, { key: 'ca', label: 'California' }, { key: 'mi', label: 'Michigan' }, { key: 'wa', label: 'Washington' }, { key: 'va', label: 'Virginia' }, { key: 'oconus', label: 'OCONUS' },
  ] },
  { key: 'applicantType', label: 'Eligibility / applicant type', multi: true, options: [
    { key: 'forprofit', label: 'For-profit' }, { key: 'smallbiz', label: 'Small business' }, { key: 'nonprofit', label: 'Nonprofit' }, { key: 'localgov', label: 'Local government' }, { key: 'tribal', label: 'Tribal' }, { key: 'academic', label: 'Academic' },
  ] },
  { key: 'funding', label: 'Funding or contract value', note: 'Total available, ceiling or award range.', multi: true, options: [
    { key: 'u1', label: 'Under $1M' }, { key: '1to10', label: '$1M – $10M' }, { key: '10to50', label: '$10M – $50M' }, { key: 'o50', label: 'Over $50M' }, { key: 'unstated', label: 'Value not stated' },
  ] },
  { key: 'costShare', label: 'Match or cost share', multi: true, options: [
    { key: 'none', label: 'Not required' }, { key: 'req', label: 'Required' }, { key: 'u25', label: 'Under 25%' }, { key: 'o25', label: '25% or more' },
  ] },
  { key: 'method', label: 'Application / response method', multi: true, options: [
    { key: 'grantsgov', label: 'Grants.gov workspace' }, { key: 'agency', label: 'Agency portal' }, { key: 'email', label: 'Email submission' }, { key: 'samgov', label: 'SAM.gov response' },
  ] },
  { key: 'disbursement', label: 'Disbursement method', only: 'Grants only', multi: true, options: [
    { key: 'reimb', label: 'Reimbursements' }, { key: 'adv', label: 'Advances' }, { key: 'both', label: 'Advances and reimbursements' }, { key: 'other', label: 'Other' },
  ] },
  { key: 'loi', label: 'Grant prerequisites', only: 'Grants only', multi: true, options: [
    { key: 'loi', label: 'Letter of intent required' }, { key: 'noloi', label: 'No letter of intent' }, { key: 'match', label: 'Requires matched funding' },
  ] },
  { key: 'setaside', label: 'Set-aside and competition', only: 'Contracts only', multi: true, options: [
    { key: 'unrestricted', label: 'Unrestricted' }, { key: 'tsb', label: 'Total small business' }, { key: 'sdvosb', label: 'SDVOSB' }, { key: 'eightA', label: '8(a)' }, { key: 'hubzone', label: 'HUBZone' },
  ] },
  { key: 'codes', label: 'Classification codes', note: 'NAICS, PSC, assistance listing and program element.', multi: true, options: [
    { key: 'n541715', label: 'NAICS 541715' }, { key: 'n334511', label: 'NAICS 334511' }, { key: 'pscAR15', label: 'PSC AR15' }, { key: 'al8155', label: 'Assistance 81.155' }, { key: 'pe0603462a', label: 'PE 0603462A' }, { key: 'broader', label: 'Include broader code families' },
  ] },
  { key: 'source', label: 'Data source', multi: true, options: [
    { key: 'grants_gov', label: 'Grants.gov' }, { key: 'sam_gov', label: 'SAM.gov' }, { key: 'ca_portal', label: 'California Grants Portal' }, { key: 'dibbs', label: 'DLA bid board' }, { key: 'forecast', label: 'Agency forecasts' }, { key: 'sbir', label: 'SBIR / STTR — not enabled' },
  ] },
] as const satisfies readonly ReferenceFilterGroup[];

/** Icon names used by the reference shell, result-card menus, and saved-search actions. */
export const referenceIconNames = [
  'HomeLine', 'Briefcase01', 'Mail01', 'Grid01', 'Target04', 'Users01', 'Stars02',
  'CalendarPlus01', 'UserCheck01', 'MessageTextSquare01', 'Share04', 'LinkExternal01',
  'SlashCircle01', 'BookmarkCheck', 'Bookmark', 'RefreshCw01', 'XClose',
] as const;

export interface ReferenceSavedSearch {
  id: string;
  name: string;
  client: string;
  visibility: string;
  visibilityTone: ReferenceTone;
  keywordQuery: string;
  criteriaSentence: string;
  lastRun: string;
  resultCount: string;
  criteriaChanged: boolean;
  warning: string;
  metadata: { storedAs: string; originalCriteriaRetained: boolean };
}

/** Four saved searches, including the exact keyword, criteria sentence, run metadata and v1 migration warning. */
export const referenceSavedSearches = [
  {
    id: 's1', name: 'Defense electronics ≤ 90 days', client: 'Overland AI', visibility: 'Private', visibilityTone: 'plain', keywordQuery: 'autonomous ground vehicle sustainment',
    criteriaSentence: 'Active grants and contracts for Overland AI in defense electronics and autonomous systems, from any agency, deadlines within 90 days, eligibility met.',
    lastRun: 'Last run 42m ago', resultCount: '6 results at last run', criteriaChanged: false, warning: '',
    metadata: { storedAs: 'typed fields + keyword query', originalCriteriaRetained: false },
  },
  {
    id: 's2', name: 'Army sustainment recompetes', client: 'Overland AI', visibility: 'Shared with tenant', visibilityTone: 'brand', keywordQuery: 'sustainment OR recompete',
    criteriaSentence: 'Active contracts for Overland AI from the Army, NAICS 541715 and broader families, ceiling over $10M.',
    lastRun: 'Last run yesterday', resultCount: '14 results at last run', criteriaChanged: false, warning: '',
    metadata: { storedAs: 'typed fields + keyword query', originalCriteriaRetained: false },
  },
  {
    id: 's3', name: 'State climate programs — partner route', client: 'Overland AI', visibility: 'Private', visibilityTone: 'plain', keywordQuery: '',
    criteriaSentence: 'Active grants for Overland AI in climate resilience, California only, applicant type any, deadlines within 180 days.',
    lastRun: 'Last run 3d ago', resultCount: '9 results at last run', criteriaChanged: false, warning: '',
    metadata: { storedAs: 'typed fields + keyword query', originalCriteriaRetained: false },
  },
  {
    id: 's4', name: 'Autonomy forecasts — all clients', client: 'Tenant-wide', visibility: 'Tenant-wide', visibilityTone: 'brand', keywordQuery: 'zero trust, autonomy stack',
    criteriaSentence: 'Forecasted opportunities in autonomous systems from any agency, any deadline, any eligibility.',
    lastRun: 'Last run 6h ago', resultCount: '23 results at last run', criteriaChanged: true, warning: '',
    metadata: { storedAs: 'typed fields + keyword query', originalCriteriaRetained: true },
  },
] as const satisfies readonly ReferenceSavedSearch[];

export interface ReferenceProfileGap { title: string; tag: string; tone: ReferenceTone; text: string; }
export const referenceProfileGaps = [
  { title: 'No PSC codes on file', tag: '41 records unscored', tone: 'warn', text: 'Contract records are matched on PSC first. Without them, 41 open contracts can be listed but not ranked for this client.' },
  { title: 'Facility locations missing for 2 sites', tag: 'Place of performance', tone: 'warn', text: 'Place-of-performance alignment is unavailable for Michigan and Virginia, so proximity never contributes to a band.' },
  { title: 'Set-aside eligibility unconfirmed', tag: 'Self-reported', tone: 'muted', text: 'Small-business and SDVOSB filters are excluded from matching until the client confirms self-certification.' },
] as const satisfies readonly ReferenceProfileGap[];
export const referenceUnscored41Fixture = {
  count: 41,
  label: '41 records unscored',
  explanation: 'Contract records are matched on PSC first. Without them, 41 open contracts can be listed but not ranked for this client.',
} as const;

export interface ReferenceSourceHealth {
  source: ReferenceSourceKey;
  name: string;
  state: string;
  stateTone: ReferenceTone;
  dot: string;
  meta: string;
  text: string;
}
export const referenceSourceHealth = [
  { source: 'grants_gov', name: 'Grants.gov', state: 'Current', stateTone: 'success', dot: '#17B26A', meta: 'LAST RUN 42M AGO · 1,284 ACTIVE OF 9,610', text: 'Full run completed. Source update times are preserved separately from ingestion time.' },
  { source: 'sam_gov', name: 'SAM.gov', state: 'Current', stateTone: 'success', dot: '#17B26A', meta: 'LAST RUN 18M AGO · 3,914 ACTIVE OF 41,208', text: 'Full run completed, including attachment metadata and notice history.' },
  { source: 'ca_portal', name: 'California Grants Portal', state: 'Current', stateTone: 'success', dot: '#17B26A', meta: 'LAST RUN 3H AGO · 170 ACTIVE', text: 'Public dataset, refreshed daily by the source. Portal IDs are retained for provenance.' },
  { source: 'dibbs', name: 'DLA bid board', state: 'Degraded', stateTone: 'warn', dot: '#DC6803', meta: 'LAST RUN 6H AGO · COUNTS UNAVAILABLE', text: 'Line-item value fields were not returned after 06:10 ET. Records are listed with values marked not provided, never as $0.' },
  { source: 'agency_forecast', name: 'Agency forecasts', state: 'Stale', stateTone: 'warn', dot: '#DC6803', meta: 'LAST RUN YESTERDAY · 268 ACTIVE', text: 'Provider-sourced and additive. A forecast never overrides a first-party notice.' },
  { source: 'sbir_sttr', name: 'SBIR / STTR', state: 'Never synced', stateTone: 'muted', dot: '#D0D5DD', meta: 'NOT ENABLED', text: 'No provider surface exists for this dataset yet, so it is excluded from every count on this page.' },
] as const satisfies readonly ReferenceSourceHealth[];

export const referenceReasons = [
  { key: 'capability', label: 'Outside client capability', text: 'The scope is not work this client performs.' },
  { key: 'eligibility', label: 'Client is not eligible', text: 'Applicant type, set-aside or registration blocks a response.' },
  { key: 'economics', label: 'Economics do not work', text: 'Value, cost share or period of performance rules it out.' },
  { key: 'capacity', label: 'No capacity this cycle', text: 'A fit, but the client cannot resource a response now.' },
] as const;

export interface ReferencePursuitStage { key: string; label: string; color: string; }
export interface ReferencePursuitRow {
  id: string;
  stage: string;
  row?: string;
  title: string;
  source: readonly [string, ReferenceTone];
  ref: string;
  when: readonly [string, string, ReferenceTone];
  owner: string;
  next: string;
  flag?: readonly [string, ReferenceTone];
  basis: string;
}
export const referencePursuitStages = [
  { key: 'reviewing', label: 'Reviewing', color: '#98A2B3' }, { key: 'qualified', label: 'Qualified', color: '#98A2B3' },
  { key: 'pursuing', label: 'Pursuing', color: '#294E68' }, { key: 'submitted', label: 'Submitted', color: '#175CD3' },
  { key: 'won', label: 'Won', color: '#17B26A' }, { key: 'lost', label: 'Lost', color: '#F04438' }, { key: 'passed', label: 'Passed', color: '#D0D5DD' },
] as const satisfies readonly ReferencePursuitStage[];
export const referencePursuitTerminalMessages = {
  won: 'Nothing moves out of Won.',
  lost: 'Lost is terminal. Reinstating the record is a separate, audited action.',
  passed: 'Passed is terminal. The record stays discoverable in the catalog.',
} as const;
export const referencePursuitAllowedMoves = {
  reviewing: [['qualified', 'Qualified', false], ['passed', 'Passed', true]],
  qualified: [['pursuing', 'Pursuing', false], ['passed', 'Passed', true]],
  pursuing: [['submitted', 'Submitted', false], ['lost', 'Lost', true]],
  submitted: [['won', 'Won', false], ['lost', 'Lost', true]],
} as const;
export const referencePursuitRows = [
  { id: 'p1', stage: 'reviewing', row: 'r1', title: 'Autonomous Ground Systems Integration and Sustainment Services', source: ['SAM.gov', 'cyan'], ref: 'W911QY-26-R-0148', when: ['Closes Sep 24', '8d', 'warn'], owner: 'Neo Martinez', next: 'Confirm BOA reinstatement with ACC-DTA', basis: 'Strong fit · relevance 78' },
  { id: 'p2', stage: 'reviewing', row: 'r2', title: 'Grid Resilience and Innovation Partnerships — Utility Cyber Hardening', source: ['Grants.gov', 'purple'], ref: 'DE-FOA-0003418', when: ['Closes Oct 30', '44d', 'plain'], owner: 'Unassigned', next: 'Letter of intent decision by Sep 28', flag: ['LOI required', 'warn'], basis: 'Potential fit · relevance 64' },
  { id: 'p3', stage: 'reviewing', row: 'r5', title: 'Cargo restraint assembly, marine sealift — NSN 3990-01-628-7745', source: ['DLA bid board', 'cyan'], ref: 'SPE4A7-26-T-0219', when: ['Quote Sep 20', '4d', 'warn'], owner: 'Priya Raman', next: 'Price the line against FY25 quote', flag: ['Value not provided', 'muted'], basis: 'Potential fit · relevance 58' },
  { id: 'p4', stage: 'reviewing', row: 'r3', title: 'Community Resilience Centers Program — Round 3', source: ['California Grants Portal', 'indigo'], ref: 'SGC-CRC-26-R3', when: ['Closes Nov 14', '59d', 'plain'], owner: 'Unassigned', next: 'Find an eligible lead applicant', flag: ['Eligibility gap', 'error'], basis: 'Not a fit as lead applicant' },
  { id: 'p5', stage: 'qualified', title: 'Robotic Combat Vehicle Software Sustainment', source: ['SAM.gov', 'cyan'], ref: 'W56HZV-26-R-0072', when: ['Closes Oct 14', '28d', 'plain'], owner: 'Neo Martinez', next: 'Draft technical approach outline', basis: 'Strong fit · relevance 81' },
  { id: 'p6', stage: 'qualified', title: 'Utility Cyber Workforce Partnerships', source: ['Grants.gov', 'purple'], ref: 'DE-FOA-0003501', when: ['Closes Jan 09', '115d', 'plain'], owner: 'Priya Raman', next: 'Confirm cost-share partner', basis: 'Potential fit · relevance 61' },
  { id: 'p7', stage: 'qualified', title: 'Zero Trust Engineering Support Services', source: ['SAM.gov', 'cyan'], ref: 'HC1084-26-R-0031', when: ['Closes Oct 07', '21d', 'warn'], owner: 'Unassigned', next: 'Assign a capture owner', basis: 'Moderate fit · relevance 66' },
  { id: 'p8', stage: 'pursuing', title: 'Autonomy Test and Evaluation Support Services', source: ['SAM.gov', 'cyan'], ref: 'FA8620-26-R-2291', when: ['Closes Nov 02', '47d', 'plain'], owner: 'Neo Martinez', next: 'Countersign teaming agreement', basis: 'Strong fit · relevance 84' },
  { id: 'p9', stage: 'pursuing', title: 'Grid Sensing and Visibility Demonstrations', source: ['Grants.gov', 'purple'], ref: 'DE-FOA-0003488', when: ['Closes Dec 12', '87d', 'plain'], owner: 'Priya Raman', next: 'Cost share letters from two utilities', basis: 'Potential fit · relevance 69' },
  { id: 'p10', stage: 'pursuing', title: 'Materials handling spares, multi-line', source: ['DLA bid board', 'cyan'], ref: 'SPE4A7-26-T-0402', when: ['Quote Oct 15', '29d', 'plain'], owner: 'Priya Raman', next: 'Confirm delivery schedule with supplier', basis: 'Potential fit · relevance 57' },
  { id: 'p11', stage: 'submitted', title: 'Distribution Automation Cyber Hardening', source: ['SAM.gov', 'cyan'], ref: 'DE-SOL-0009122', when: ['Award expected Dec 2026', '', 'plain'], owner: 'Neo Martinez', next: 'Awaiting evaluation — no action', basis: 'Submitted Sep 02, 2026' },
  { id: 'p12', stage: 'won', title: 'Autonomy kit spares — delivery order 0003', source: ['SAM.gov', 'cyan'], ref: 'W911QY-25-D-0044', when: ['Awarded Aug 12', '', 'success'], owner: 'Neo Martinez', next: '', basis: 'Awarded $2,410,000' },
  { id: 'p13', stage: 'lost', row: 'r6', title: 'Space Technology Research Institutes — Resilient Launch Access', source: ['Grants.gov', 'purple'], ref: 'NNH26ZDA001N-STRI', when: ['Closed Aug 18', '', 'error'], owner: 'Neo Martinez', next: '', flag: ['Reason recorded', 'gray'], basis: 'Not submitted — teaming incomplete' },
] as const satisfies readonly ReferencePursuitRow[];

export interface ReferenceDetailExtra {
  applyLabel: string;
  kind: string;
  applyNote: string;
  scope?: readonly (readonly [string, string, string, string])[];
  codeChips?: readonly string[];
  codes?: readonly (readonly [string, string, ReferenceTone])[];
  evalFacts?: readonly (readonly [string, string, ReferenceTone])[];
  evalFoot?: string;
  howTo?: readonly (readonly [string, string, string, string])[];
  docs?: readonly (readonly [string, string, string, string])[];
  activity?: readonly (readonly [string, string, string, string])[];
  notices?: readonly (readonly [string, string, string, string])[];
  contact: { name: string; role: string; phone: string; email: string };
  similar: readonly (readonly [string, string, string])[];
}

/** Full detail overlay extras from detail-sample-extras.js, keyed by the six row ids. */
export const referenceDetailExtras = {
  r1: {
    applyLabel: 'View solicitation on SAM.gov', kind: 'Solicitation document',
    applyNote: 'The destination is the authoritative solicitation record on SAM.gov, not an application system. Responses are submitted through the contracting officer.',
    scope: [
      ['Two brigade sets', 'Integration of government-furnished autonomy kits onto 312 platforms, phased across two sites.', '', ''],
      ['Government-owned stack', 'The autonomy software baseline stays government-owned; interfaces must be documented to the open standard named in Section C.', 'Evidence-bound', 'Contractor shall deliver interface control documents for all externally visible interfaces.'],
      ['Sustainment tail', 'Five years of field service representation, spares provisioning and depot-level training.', '', ''],
    ],
    codeChips: ['NAICS 541715', 'PSC AR15', 'PE 0603462A', 'Combat vehicles'],
    codes: [['NAICS', '541715 — exact match', 'success'], ['PSC', 'AR15 — broader family', 'plain'], ['Assistance listing', 'Not applicable to contracts', 'muted'], ['Program element', 'PE 0603462A', 'plain']],
    evalFacts: [['Award basis', 'Best value tradeoff', 'plain'], ['Technical', '60% of evaluation', 'plain'], ['Price', '40% of evaluation', 'plain'], ['Awards expected', '1', 'plain']],
    evalFoot: 'Weighting is quoted from Section M of the solicitation. Where an agency does not state weighting, this section reads not provided.',
    howTo: [
      ['Register the response', 'Confirm SAM registration and CAGE are active before the questions deadline.', 'Prerequisite', ''],
      ['Submit questions in writing', 'Questions are accepted only through the contracting specialist until Sep 08, 12:00 ET.', 'Deadline', ''],
      ['Respond by the stated deadline', 'Volumes I–III as PDF, delivered through the portal named in Section L.', 'Response', ''],
    ],
    docs: [
      ['Facility clearance at Secret', 'Required at time of award, not at response.', 'Evidence-bound', 'Contractor shall possess a facility clearance at the Secret level prior to award.'],
      ['Past performance', 'Three references within five years, at or above $5M.', '', ''],
      ['Small business plan', 'Not required — the set-aside was withdrawn Aug 11.', 'Withdrawn', ''],
    ],
    activity: [
      ['Aug 20, 2026 · Neo Martinez', 'Marked pursuing. Old state: suggested.', 'Workflow', ''],
      ['Aug 19, 2026 · System', 'Response date change detected and alerted to two watchers.', 'Automated', ''],
      ['Aug 12, 2026 · Priya Raman', 'Added note: confirm BOA reinstatement route with ACC-DTA.', 'Note', ''],
    ],
    notices: [
      ['Aug 19, 2026 — response date extended', 'Sep 24 replaces Sep 04. A deadline change is material and alerts anybody who has engaged with this record.', 'Critical', ''],
      ['Aug 11, 2026 — set-aside removed', 'Total small business set-aside withdrawn; the competition is now unrestricted.', 'Significant', ''],
      ['Jul 22, 2026 — first observation', 'Presolicitation posted. A first observation never alerts.', '', ''],
    ],
    contact: { name: 'Dana Whitfield', role: 'Contract Specialist · ACC-DTA', phone: '+1 586 282 4417', email: 'dana.whitfield@army.mil' },
    similar: [
      ['Robotic Combat Vehicle Software Sustainment', 'Contract', 'Closes Oct 14, 2026'],
      ['Autonomy Test and Evaluation Support Services', 'Contract', 'Closes Nov 02, 2026'],
      ['Ground Vehicle Autonomy Research Institutes', 'Grant', 'Closes Dec 01, 2026'],
    ],
  },
  r2: {
    applyLabel: 'View guidelines on Grants.gov', kind: 'Grant guidelines page',
    applyNote: 'The destination is the funding opportunity announcement. Applications are submitted through a Grants.gov workspace, which requires an active registration.',
    scope: [
      ['Two funding tracks', 'Track 1 supports utility-side hardening; Track 2 supports sensing and situational awareness with technology partners.', '', ''],
      ['Partnership structure', 'A utility or state entity must lead; technology providers participate as named subrecipients.', 'Affects eligibility', ''],
    ],
    codeChips: ['Assistance 81.122', 'Energy resilience', 'Cyber'],
    codes: [['Assistance listing', '81.122 — Electricity Delivery', 'plain'], ['NAICS', 'Not used by this source', 'muted'], ['Program area', 'Grid Deployment Office', 'plain']],
    howTo: [
      ['Submit the letter of intent', 'Required by Sep 28, 2026. Applications without one are not reviewed.', 'Prerequisite', ''],
      ['Confirm cost share', 'A 50% non-federal cost share applies to Track 1 and Track 2 alike.', 'Deadline', ''],
      ['Apply through the workspace', 'Grants.gov workspace submission; SAM registration must be active.', 'Response', ''],
    ],
    docs: [['Letter of intent', 'One page, submitted by Sep 28.', '', ''], ['Cost share documentation', 'Signed commitment letters from each non-federal contributor.', '', '']],
    notices: [['Sep 12, 2026 — amendment 2', 'Cost-share definition clarified; deadlines unchanged.', 'Informational', ''], ['Aug 04, 2026 — first observation', 'Announcement posted.', '', '']],
    contact: { name: 'Marcus Lee', role: 'Program Manager · Grid Deployment Office', phone: '+1 202 586 5000', email: 'gdo.foa@hq.doe.gov' },
    similar: [
      ['Grid Sensing and Visibility Demonstrations', 'Grant', 'Closes Dec 12, 2026'],
      ['Utility Cyber Workforce Partnerships', 'Grant', 'Closes Jan 09, 2027'],
      ['Distribution Automation Cyber Hardening', 'Contract', 'Closes Oct 28, 2026'],
    ],
  },
  r3: {
    applyLabel: 'View program page on the California portal', kind: 'Agency program page',
    applyNote: 'The destination is the state program page. This client cannot apply as lead applicant; a subrecipient route would have to be evidenced first.',
    codeChips: ['Portal ID 12874', 'Climate resilience', 'California only'],
    codes: [['Assistance listing', 'Not provided by source', 'muted'], ['Program area', 'Community resilience', 'plain'], ['Portal ID', '12874', 'plain']],
    howTo: [['Confirm a lead applicant', 'A local government, tribe or nonprofit must hold the award.', 'Prerequisite', ''], ['Apply through the state portal', 'Application system opens Sep 22, 2026.', 'Response', '']],
    notices: [['Sep 15, 2026 — guidelines updated', 'Allowable equipment costs clarified for subrecipients.', 'Significant', ''], ['Sep 02, 2026 — first observation', 'Round 3 posted.', '', '']],
    contact: { name: 'Strategic Growth Council', role: 'Climate Resilience Division', phone: '+1 916 322 2318', email: 'crc@sgc.ca.gov' },
    similar: [
      ['Regional Climate Resilience Program — Round 2', 'Grant', 'Closes Dec 05, 2026'],
      ['Extreme Heat and Community Resilience', 'Grant', 'Closes Oct 31, 2026'],
      ['Community Hardening Technical Assistance', 'Grant', 'Rolling'],
    ],
  },
  r4: {
    applyLabel: 'View the agency forecast entry', kind: 'Agency forecast page',
    applyNote: 'A forecast has no response mechanism. There is nothing to apply to until a solicitation is published.',
    notices: [['Sep 09, 2026 — forecast published', 'Provider record created. Agency status “Planned”.', '', '']],
    contact: { name: 'Not provided by source', role: 'Forecast records rarely name a contact', phone: 'Not provided', email: '' },
    similar: [
      ['Zero Trust Engineering Support Services', 'Contract', 'Closes Oct 07, 2026'],
      ['Enterprise Identity Modernization', 'Forecast', 'Q3 FY27'],
      ['Network Modernization Research Institutes', 'Grant', 'Closes Nov 20, 2026'],
    ],
  },
  r5: {
    applyLabel: 'View the request for quote', kind: 'Quote submission system',
    applyNote: 'The destination is the DLA bid board record. Quotes are submitted in that system; the value fields there were unreadable in the last run.',
    codeChips: ['NSN 3990-01-628-7745', 'FSC 3990', 'Total small business'],
    codes: [['NSN', '3990-01-628-7745', 'plain'], ['Federal supply class', '3990 — materials handling', 'plain'], ['PSC', 'Not provided by source', 'muted']],
    howTo: [['Submit a quote', 'Quote return by Sep 20, 16:00 ET through the bid board.', 'Response', '']],
    notices: [['Sep 16, 2026 — partial run', 'Value fields not returned. Quantity and dates were read successfully.', 'Significant', '']],
    contact: { name: 'DLA Land and Maritime', role: 'Acquisition Operations', phone: '+1 614 692 3541', email: 'dibbsbsm@dla.mil' },
    similar: [
      ['Tie-down assembly, marine — NSN 3990-01-441-2208', 'Contract', 'Quote return Sep 25, 2026'],
      ['Cargo netting, sealift', 'Contract', 'Quote return Oct 02, 2026'],
      ['Materials handling spares, multi-line', 'Contract', 'Quote return Oct 15, 2026'],
    ],
  },
  r6: {
    applyLabel: 'View the closed announcement', kind: 'Grant guidelines page',
    applyNote: 'The submission window closed on Aug 18, 2026. The announcement remains readable for history and lessons learned.',
    codeChips: ['Assistance 43.012', 'Space technology'],
    codes: [['Assistance listing', '43.012 — Space Technology', 'success'], ['Program area', 'Space Technology Mission Directorate', 'plain']],
    notices: [
      ['Aug 20, 2026 — closed', 'Observed closed two days after the stated deadline.', 'Critical', ''],
      ['May 12, 2026 — first observation', 'Announcement posted.', '', ''],
    ],
    activity: [['Jul 30, 2026 · Neo Martinez', 'Marked pursuing. Teaming arrangement not completed before close.', 'Workflow', '']],
    contact: { name: 'STRI Program Office', role: 'NASA STMD', phone: 'Not provided', email: 'hq-stri@nasa.gov' },
    similar: [
      ['Space Technology Graduate Research Opportunities', 'Grant', 'Closes Nov 05, 2026'],
      ['Resilient Launch Infrastructure Studies', 'Contract', 'Closes Oct 22, 2026'],
      ['Launch Access Analysis Support', 'Contract', 'Closes Dec 08, 2026'],
    ],
  },
} as const satisfies Record<string, ReferenceDetailExtra>;

/** The six authoritative destination records used by the detail overlays. */
export const referenceResponseDestinations = referenceOpportunityRows.map((row) => ({
  rowId: row.id,
  href: row.href,
  kind: referenceDetailExtras[row.id as keyof typeof referenceDetailExtras].kind,
  label: referenceDetailExtras[row.id as keyof typeof referenceDetailExtras].applyLabel,
  note: referenceDetailExtras[row.id as keyof typeof referenceDetailExtras].applyNote,
}));

export const referenceTerminalFootnotes = [
  { text: 'A stage move records actor, timestamp, client, opportunity, old state and new state. Lost and Passed require a reason before the move commits.' },
  { text: 'Terminal stages show a sentence instead of disabled controls — an absent handler removes the control rather than greying it out.' },
  { text: 'Records stay in the pipeline even when their current relevance falls below the suggestion floor.' },
] as const;

/** Compact inventory for parity workers; data itself remains in the exports above. */
export const referenceFixtureInventory = {
  opportunities: 'referenceOpportunityRows', clients: 'referenceClients', savedSearches: 'referenceSavedSearches', profileGaps: 'referenceProfileGaps',
  unscored41: 'referenceUnscored41Fixture', sourceHealth: 'referenceSourceHealth', reasons: 'referenceReasons', pursuitStages: 'referencePursuitStages',
  pursuitRows: 'referencePursuitRows', terminalMessages: 'referencePursuitTerminalMessages', allowedMoves: 'referencePursuitAllowedMoves', detailExtras: 'referenceDetailExtras',
} as const;

/**
 * Raw-to-current-API notes for the next parity slice. These are deliberately notes,
 * not adapters: fixture data must not become a production default or hide enum gaps.
 */
export const referenceRawToApiMappingNotes = {
  opportunity: {
    id: 'id -> OpportunitySearchRecordV2.id', source: 'source -> OpportunitySearchRecordV2.source; ca_portal needs the pending enum expansion',
    href: 'href -> sourceUrl', meta: 'split only when an API field is available; preserve the complete display string for visual presentation',
    facts: 'facts -> detail presentation facts; do not infer missing API values', band: 'band/reason/evidence -> client-side presentation/match explanation',
    when: 'when -> deadline presentation; reference calendar strings are display literals',
  },
  clients: 'id/name map directly; init/meta/count are presentation-only metadata and do not replace client API records.',
  savedSearches: 'keywordQuery + criteriaSentence remain reference-only until current criteria schema is wired; visibility maps to private/tenant, with display labels preserved.',
  sourceHealth: 'source/state/stateTone/meta/text are reference presentation fields; map Current/Degraded/Stale/Never synced to current API health only in an explicit adapter.',
  pursuit: 'stage/source/ref/when/owner/next/basis are workflow presentation fields; row links only where the reference provides a catalog row id.',
  details: 'referenceDetailExtras[rowId] supplies exact overlay copy; href/applyLabel/applyNote map to an external destination only through the real audited source-click path.',
} as const;
