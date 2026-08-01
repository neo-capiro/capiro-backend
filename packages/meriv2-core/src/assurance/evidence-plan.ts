import type {
  GovernmentAffairsJurisdiction,
  GovernmentAffairsOperatingFrame,
} from './operating-frame';

export const EVIDENCE_CLASSES = [
  'primary_legislative_legal_text',
  'official_action_vote_status',
  'committee_agency_guidance',
  'official_budget_exhibit_mark_law',
  'capiro_system_of_record',
  'client_approved_context',
  'official_government_data',
  'secondary_reporting',
  'institutional_memory',
  'inference',
] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export type EvidenceRequirementLevel = 'required' | 'optional' | 'supplemental';

export type ClaimCategory =
  | 'bill_status'
  | 'member_vote'
  | 'current_role'
  | 'budget_amount'
  | 'budget_delta'
  | 'enactment'
  | 'report_language'
  | 'regulatory_deadline'
  | 'regulatory_stage'
  | 'district_representation'
  | 'grant_opportunity'
  | 'grant_award'
  | 'procurement_opportunity'
  | 'client_recommendation'
  | 'negative_or_exhaustive'
  | 'general_background';

export interface EvidenceRequirement {
  id: string;
  claimCategory: ClaimCategory;
  level: EvidenceRequirementLevel;
  evidenceClass: EvidenceClass;
  toolFamilies: string[];
  freshness: 'same_turn' | 'current_cycle' | 'current_session' | 'dated' | 'durable';
  reason: string;
  /** Required dimensions that must accompany the evidence, not be inferred. */
  requiredFields: string[];
}

export interface DomainEvidencePlan {
  version: 'ga-evidence-plan-v1';
  requestCategories: ClaimCategory[];
  jurisdictions: GovernmentAffairsJurisdiction[];
  requirements: EvidenceRequirement[];
  requiredRequirementIds: string[];
  optionalRequirementIds: string[];
  supplementalRequirementIds: string[];
  unresolvedFrameFields: string[];
  incomplete: boolean;
}

export interface EvidencePlanInput {
  request: string;
  frame: GovernmentAffairsOperatingFrame;
  /** Surface may add stricter requirements, but never remove a category's required evidence. */
  surface?:
    | 'chat'
    | 'in-editor'
    | 'workspace-gen'
    | 'strategy'
    | 'research'
    | 'outreach'
    | 'memo'
    | 'district-brief';
}

const REQUIREMENTS: Readonly<Record<ClaimCategory, readonly EvidenceRequirement[]>> = {
  bill_status: [
    requirement(
      'bill-status.official-status',
      'bill_status',
      'required',
      'official_action_vote_status',
      ['get_bill_status', 'get_state_bill_status', 'get_state_rule_status'],
      'same_turn',
      'A bill or rule status must come from the authoritative status/action record for the correct jurisdiction.',
      ['jurisdiction', 'vehicleId', 'status', 'statusAt'],
    ),
    requirement(
      'bill-status.procedure',
      'bill_status',
      'required',
      'official_action_vote_status',
      [
        'get_bill_status',
        'search_floor_votes',
        'search_state_floor_votes',
        'get_state_rule_status',
      ],
      'same_turn',
      'Procedural advancement requires the action, rule, or vote evidence that produced it.',
      ['actionsOrVoteEvidence'],
    ),
    requirement(
      'bill-status.text',
      'bill_status',
      'optional',
      'primary_legislative_legal_text',
      ['search_congress_bills', 'search_state_bills'],
      'current_session',
      'Primary bill text is useful when the answer describes what the measure does.',
      ['versionOrAsOf'],
    ),
  ],
  member_vote: [
    requirement(
      'member-vote.roll-call',
      'member_vote',
      'required',
      'official_action_vote_status',
      ['search_floor_votes', 'search_state_floor_votes'],
      'same_turn',
      'A member vote must resolve to the actual roll call and member position.',
      ['voteId', 'voteDate', 'memberId', 'position'],
    ),
    requirement(
      'member-vote.entity',
      'member_vote',
      'required',
      'official_government_data',
      ['resolve_entity', 'get_state_legislator'],
      'current_session',
      'The named person must resolve canonically before their vote is attributed.',
      ['canonicalEntityId'],
    ),
  ],
  current_role: [
    requirement(
      'current-role.roster',
      'current_role',
      'required',
      'official_government_data',
      ['get_committee_roster', 'resolve_entity', 'get_state_legislator', 'list_members'],
      'same_turn',
      'Current office, committee, chair, and staff-role claims require a dated current roster.',
      ['canonicalEntityId', 'role', 'asOf'],
    ),
  ],
  budget_amount: [
    requirement(
      'budget-amount.official',
      'budget_amount',
      'required',
      'official_budget_exhibit_mark_law',
      ['get_pe_budget_timeline', 'get_program_element', 'get_funding_positions'],
      'current_cycle',
      'A budget amount must identify the fiscal year, stage, vehicle, scope, units, and source.',
      ['fiscalYear', 'stage', 'vehicleClass', 'scope', 'amount', 'units', 'sourceId'],
    ),
  ],
  budget_delta: [
    requirement(
      'budget-delta.comparable-positions',
      'budget_delta',
      'required',
      'official_budget_exhibit_mark_law',
      ['get_pe_budget_timeline', 'get_funding_positions'],
      'current_cycle',
      'A delta is valid only between positions with the same fiscal year, funding scope, units, and compatible vehicle stages.',
      ['fromFiscalYear', 'toFiscalYear', 'fromScope', 'toScope', 'fromAmount', 'toAmount', 'units'],
    ),
  ],
  enactment: [
    requirement(
      'enactment.public-law',
      'enactment',
      'required',
      'primary_legislative_legal_text',
      ['get_bill_status', 'get_state_bill_status', 'get_state_rule_status'],
      'same_turn',
      'Enactment or legal effectiveness requires public-law, chapter, signed, or equivalent enacted proof.',
      ['enactedEvidence', 'effectiveOrSignedAt'],
    ),
  ],
  report_language: [
    requirement(
      'report-language.exact-source',
      'report_language',
      'required',
      'official_budget_exhibit_mark_law',
      ['get_pe_report_language', 'get_pe_bills'],
      'current_cycle',
      'Report language must be attributed to the exact report, vehicle, provision, and program or line it addresses.',
      ['reportId', 'vehicle', 'quotedOrParaphrasedLanguage', 'subjectId'],
    ),
  ],
  regulatory_deadline: [
    requirement(
      'regulatory-deadline.docket',
      'regulatory_deadline',
      'required',
      'committee_agency_guidance',
      ['query_regulatory_dockets', 'get_state_rule_status'],
      'same_turn',
      'Comment and effective deadlines require the official docket or register date and its timezone semantics.',
      ['docketId', 'deadline', 'timezone', 'stage', 'asOf'],
    ),
  ],
  regulatory_stage: [
    requirement(
      'regulatory-stage.official',
      'regulatory_stage',
      'required',
      'committee_agency_guidance',
      ['query_regulatory_dockets', 'get_state_rule_status'],
      'same_turn',
      'Proposed, final, effective, withdrawn, and open are distinct states derived from the official record.',
      ['stage', 'stageAt', 'asOf'],
    ),
  ],
  district_representation: [
    requirement(
      'district-representation.join',
      'district_representation',
      'required',
      'official_government_data',
      ['get_representation'],
      'same_turn',
      'District and representative claims must come from the deterministic facility/geospatial/roster join.',
      ['facilityId', 'districtId', 'representativeId', 'asOf'],
    ),
  ],
  grant_opportunity: [
    requirement(
      'grant-opportunity.official',
      'grant_opportunity',
      'required',
      'official_government_data',
      ['search_federal_grants'],
      'same_turn',
      'A grant opportunity must be distinguished from an award and include eligibility and response dates.',
      ['opportunityId', 'status', 'closeDateOrDescription', 'eligibility'],
    ),
  ],
  grant_award: [
    requirement(
      'grant-award.official',
      'grant_award',
      'required',
      'official_government_data',
      ['search_federal_awards'],
      'same_turn',
      'An awarded assistance claim must resolve to an actual award record rather than an opportunity notice.',
      ['awardId', 'recipient', 'amount', 'awardDate'],
    ),
  ],
  procurement_opportunity: [
    requirement(
      'procurement-opportunity.sam',
      'procurement_opportunity',
      'required',
      'official_government_data',
      ['search_sam_opportunities'],
      'same_turn',
      'A procurement opportunity must come from the official notice and retain notice type, agency, deadline, and status.',
      ['opportunityId', 'noticeType', 'agency', 'deadline', 'status'],
    ),
  ],
  client_recommendation: [
    requirement(
      'client-recommendation.approved-direction',
      'client_recommendation',
      'required',
      'client_approved_context',
      ['get_client_context', 'search_memory'],
      'same_turn',
      'A client-specific recommendation must advance an approved objective or authorized ask and respect client constraints.',
      ['clientId', 'objectiveOrAsk', 'authority', 'constraints'],
    ),
    requirement(
      'client-recommendation.policy-basis',
      'client_recommendation',
      'required',
      'official_government_data',
      ['domain_specific_tools'],
      'same_turn',
      'The recommended action must be tied to current procedural and policy evidence.',
      ['evidenceIds', 'target', 'timing'],
    ),
    requirement(
      'client-recommendation.relationships',
      'client_recommendation',
      'supplemental',
      'capiro_system_of_record',
      ['query_knowledge_graph', 'query_engagement', 'query_debriefs'],
      'dated',
      'Firm relationship and engagement history may improve targeting but cannot replace official status evidence.',
      ['asOf'],
    ),
  ],
  negative_or_exhaustive: [
    requirement(
      'negative-claim.coverage',
      'negative_or_exhaustive',
      'required',
      'official_government_data',
      ['domain_specific_tools'],
      'same_turn',
      'No/none/only/all/every claims require explicit, non-truncated source coverage; an empty or failed query is not proof of absence.',
      ['coverageDescription', 'complete', 'truncated', 'failures'],
    ),
  ],
  general_background: [
    requirement(
      'background.primary-preferred',
      'general_background',
      'optional',
      'official_government_data',
      ['domain_specific_tools'],
      'dated',
      'Use primary or system-of-record material when the answer makes a factual claim.',
      ['asOf'],
    ),
    requirement(
      'background.secondary',
      'general_background',
      'supplemental',
      'secondary_reporting',
      ['search_public_web', 'search_intel_articles'],
      'dated',
      'Secondary reporting may explain context but does not outrank primary evidence.',
      ['publisher', 'publishedAt'],
    ),
  ],
};

export function inferClaimCategories(request: string): ClaimCategory[] {
  const text = String(request ?? '');
  const categories: ClaimCategory[] = [];
  addIf(
    categories,
    /\b(?:status|where\s+(?:is|does).*(?:bill|measure)|advance[sd]?|pass(?:ed|es)?|fail(?:ed|s)?|dead|alive)\b/i.test(
      text,
    ),
    'bill_status',
  );
  addIf(
    categories,
    /\b(?:how\s+did|vote[sd]?|roll\s*call|yeas?|nays?)\b/i.test(text),
    'member_vote',
  );
  addIf(
    categories,
    /\b(?:current|now|today|chair|ranking\s+member|committee\s+member|chief\s+of\s+staff|director|secretary)\b/i.test(
      text,
    ),
    'current_role',
  );
  addIf(
    categories,
    /(?:\$|\bdollars?\b|\bamount\b|\bfunding\b|\bbudget\b|\brequest\b|\bmark\b)/i.test(text),
    'budget_amount',
  );
  addIf(
    categories,
    /\b(?:delta|increase|decrease|cut|plus-?up|difference|change[sd]?\s+from|versus|vs\.)\b/i.test(
      text,
    ),
    'budget_delta',
  );
  addIf(
    categories,
    /\b(?:enacted|signed\s+into\s+law|public\s+law|chaptered|became\s+law)\b/i.test(text),
    'enactment',
  );
  addIf(
    categories,
    /\b(?:report\s+language|committee\s+report|directs|encourages|requires\s+the\s+secretary)\b/i.test(
      text,
    ),
    'report_language',
  );
  addIf(
    categories,
    /\b(?:comment\s+(?:deadline|period|due)|effective\s+date|deadline|due\s+date)\b/i.test(text),
    'regulatory_deadline',
  );
  addIf(
    categories,
    /\b(?:proposed\s+rule|final\s+rule|effective|withdrawn|rulemaking|docket)\b/i.test(text),
    'regulatory_stage',
  );
  addIf(
    categories,
    /\b(?:district|representative|representation|facility\s+footprint|state\s+senator|state\s+representative)\b/i.test(
      text,
    ),
    'district_representation',
  );
  addIf(
    categories,
    /\b(?:grant\s+opportunity|nofo|notice\s+of\s+funding|grants?\.gov|eligible\s+applicant)\b/i.test(
      text,
    ),
    'grant_opportunity',
  );
  addIf(
    categories,
    /\b(?:grant\s+award|assistance\s+award|awarded\s+grant|cooperative\s+agreement\s+award)\b/i.test(
      text,
    ),
    'grant_award',
  );
  addIf(
    categories,
    /\b(?:procurement\s+opportunity|solicitation|rfp|rfi|sam\.gov|contract\s+opportunity)\b/i.test(
      text,
    ),
    'procurement_opportunity',
  );
  addIf(
    categories,
    /\b(?:recommend|strategy|who\s+should\s+we|what\s+should\s+we\s+ask|engage|advocacy|next\s+step)\b/i.test(
      text,
    ),
    'client_recommendation',
  );
  addIf(
    categories,
    /\b(?:no|none|only|all|every|never|nothing|nobody|no\s+evidence|does\s+not\s+exist)\b/i.test(
      text,
    ),
    'negative_or_exhaustive',
  );
  if (!categories.length) categories.push('general_background');
  return orderedUnique(categories);
}

export function planGovernmentAffairsEvidence(input: EvidencePlanInput): DomainEvidencePlan {
  const categories = inferClaimCategories(input.request);
  const requirements = categories
    .flatMap((category) => REQUIREMENTS[category])
    .map((item) => ({
      ...item,
      toolFamilies: [...item.toolFamilies],
      requiredFields: [...item.requiredFields],
    }));

  // External/client-facing surfaces require a primary/system-of-record basis for
  // every factual category. This adds an explicit requirement; it never upgrades
  // institutional memory or inference into authoritative evidence.
  if (
    ['outreach', 'memo', 'workspace-gen', 'in-editor', 'strategy', 'district-brief'].includes(
      input.surface ?? '',
    )
  ) {
    requirements.push(
      requirement(
        'surface.high-risk-primary-basis',
        'general_background',
        'required',
        'official_government_data',
        ['domain_specific_tools'],
        'same_turn',
        'Client-facing and strategy-execution content requires same-turn primary or system-of-record support before release.',
        ['sourceIds', 'asOf'],
      ),
    );
  }

  const deduped = dedupeRequirements(requirements);
  const requiredRequirementIds = deduped
    .filter((item) => item.level === 'required')
    .map((item) => item.id);
  const optionalRequirementIds = deduped
    .filter((item) => item.level === 'optional')
    .map((item) => item.id);
  const supplementalRequirementIds = deduped
    .filter((item) => item.level === 'supplemental')
    .map((item) => item.id);
  return {
    version: 'ga-evidence-plan-v1',
    requestCategories: categories,
    jurisdictions: [...input.frame.jurisdictions],
    requirements: deduped,
    requiredRequirementIds,
    optionalRequirementIds,
    supplementalRequirementIds,
    unresolvedFrameFields: [...input.frame.missingRequired],
    incomplete: input.frame.missingRequired.length > 0 || requiredRequirementIds.length === 0,
  };
}

export function missingRequiredEvidence(
  plan: DomainEvidencePlan,
  evidence: readonly { requirementIds?: readonly string[]; available?: boolean }[],
): string[] {
  const satisfied = new Set<string>();
  for (const item of evidence) {
    if (item.available === false) continue;
    for (const id of item.requirementIds ?? []) satisfied.add(id);
  }
  return plan.requiredRequirementIds.filter((id) => !satisfied.has(id));
}

function requirement(
  id: string,
  claimCategory: ClaimCategory,
  level: EvidenceRequirementLevel,
  evidenceClass: EvidenceClass,
  toolFamilies: string[],
  freshness: EvidenceRequirement['freshness'],
  reason: string,
  requiredFields: string[],
): EvidenceRequirement {
  return {
    id,
    claimCategory,
    level,
    evidenceClass,
    toolFamilies,
    freshness,
    reason,
    requiredFields,
  };
}

function addIf<T>(out: T[], condition: boolean, value: T): void {
  if (condition && !out.includes(value)) out.push(value);
}

function orderedUnique<T>(values: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function dedupeRequirements(requirements: readonly EvidenceRequirement[]): EvidenceRequirement[] {
  const byId = new Map<string, EvidenceRequirement>();
  for (const item of requirements) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}
