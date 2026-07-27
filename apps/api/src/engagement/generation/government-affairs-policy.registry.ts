/**
 * Government-affairs policy registry (Phase 1 §3.f1).
 *
 * Before Phase 1, PromptSpec v2's identity and etiquette assumed ONE audience —
 * a federal congressional or agency office — and applied it to everything. That
 * is wrong in a way that is visible to the recipient: Hill etiquette ("one clear
 * ask, never imply a thing of value, never claim a member supports you") read to
 * a client's own CFO is bizarre, and federal legislative vocabulary applied to a
 * state measure is simply incorrect.
 *
 * So audience is now EXPLICIT and resolved deterministically. When it cannot be
 * resolved, selection returns a typed "audience policy required" error and the
 * user is asked — it does NOT quietly fall back to federal, because a silent
 * federal default is exactly the bug.
 *
 * Freshness thresholds live here per evidence type (§6.6): a bill's status ages
 * in days, a committee roster in weeks, a durable client fact barely at all.
 * One global staleness number would either nag constantly or miss real staleness.
 */

/** Jurisdiction of the message. */
export type GaJurisdiction = 'federal' | 'state' | 'local' | 'cross_jurisdiction' | 'internal';

/** Who is being written to. */
export type GaAudience =
  | 'congressional_office'
  | 'federal_agency'
  | 'state_legislator'
  | 'state_agency'
  | 'local_official'
  | 'coalition'
  | 'client_executive'
  | 'internal_colleague'
  | 'defense_acquisition_office';

/** Deterministic validator ids the verifier runs for a given policy. */
export type GaValidatorId =
  | 'unresolved_placeholder'
  | 'numeric_grounding'
  | 'bill_identifier_grounding'
  | 'enactment_claim'
  | 'authorization_vs_appropriation'
  | 'recipient_commitment_claim'
  | 'attendance_claim'
  | 'date_grounding'
  | 'stale_source_caveat'
  | 'group_common_facts'
  | 'federal_etiquette_scope'
  | 'jurisdiction_vocabulary';

export interface GaFreshnessThresholds {
  /** Max age in days before a source of this type needs an explicit as-of caveat. */
  [evidenceType: string]: number;
}

export interface GaPolicy {
  policyId: string;
  version: string;
  jurisdiction: GaJurisdiction;
  audienceType: GaAudience;
  label: string;
  /** Intents this audience may be written to for. */
  allowedIntents: string[];
  salutationRule: string;
  terminologyRules: string[];
  askRules: string[];
  /** Evidence types a message to this audience must be grounded in. */
  requiredEvidenceTypes: string[];
  prohibitedAssumptions: string[];
  defaultTone: 'professional' | 'friendly' | 'formal' | 'concise';
  defaultLength: 'short' | 'standard' | 'long';
  /** Legislative/funding claims must carry an as-of date for this audience. */
  requiresAsOfDates: boolean;
  /** Hill etiquette + federal lobbying compliance guardrails apply. */
  appliesHillEtiquette: boolean;
  validators: GaValidatorId[];
  freshness: GaFreshnessThresholds;
}

export const GA_POLICY_VERSION = 'ga-policy-v1';

/** Default freshness thresholds by evidence type, in days (§6.6). */
const FRESHNESS_LEGISLATIVE: GaFreshnessThresholds = {
  // A bill's canonical status is the fastest-moving fact we quote.
  bill: 14,
  stateBill: 21,
  // Budget marks move on the appropriations calendar, not daily.
  programElement: 45,
  // Rosters/assignments change at the margins between congresses.
  directory: 120,
  press: 30,
  email: 180,
  document: 365,
  prep: 90,
  debrief: 90,
  note: 365,
  // Durable relationship facts.
  client: 365,
};

const FRESHNESS_INTERNAL: GaFreshnessThresholds = {
  ...FRESHNESS_LEGISLATIVE,
  // An internal update may legitimately recap older correspondence.
  email: 365,
  press: 90,
};

const BASE_VALIDATORS: GaValidatorId[] = [
  'unresolved_placeholder',
  'numeric_grounding',
  'bill_identifier_grounding',
  'enactment_claim',
  'authorization_vs_appropriation',
  'recipient_commitment_claim',
  'attendance_claim',
  'date_grounding',
  'stale_source_caveat',
  'group_common_facts',
];

const POLICIES: Record<GaAudience, GaPolicy> = {
  // ── Federal ───────────────────────────────────────────────────────────────
  congressional_office: {
    policyId: 'federal.congressional_office',
    version: GA_POLICY_VERSION,
    jurisdiction: 'federal',
    audienceType: 'congressional_office',
    label: 'Federal congressional office',
    allowedIntents: [
      'meeting_request',
      'position_ask',
      'information_share',
      'thank_you',
      'follow_up',
      'cosponsor_ask',
      'appropriations_request',
      'hearing_follow_up',
    ],
    salutationRule:
      'Open with a brief natural greeting using the recipient’s real first name (e.g. "Hi Dana —"); never open with "Dear". If no name is available, use a short professional greeting ("Hello,").',
    terminologyRules: [
      'Use correct federal legislative vocabulary: a bill is introduced, referred, reported, passed, and only ENACTED once signed into law or a veto is overridden.',
      'Distinguish AUTHORIZATION (NDAA-style policy ceilings) from APPROPRIATION (enacted budget authority). They are never interchangeable.',
      'Refer to committees and subcommittees by their real names; never invent a jurisdiction.',
    ],
    askRules: [
      'Exactly ONE clear ask per message unless the selected template explicitly allows more.',
      'Make the ask easy to say yes to and specific about what is being requested of the office.',
    ],
    requiredEvidenceTypes: ['recipient_identity'],
    prohibitedAssumptions: [
      'Do not state or imply that the member or staffer supports, has committed to, or has taken a position on the client unless the evidence explicitly proves it.',
      'Do not assume committee membership, district, or leadership role that the evidence does not state.',
      'Do not imply a quid pro quo or anything of value in exchange for official action.',
    ],
    defaultTone: 'professional',
    defaultLength: 'standard',
    requiresAsOfDates: true,
    appliesHillEtiquette: true,
    validators: [...BASE_VALIDATORS, 'jurisdiction_vocabulary'],
    freshness: FRESHNESS_LEGISLATIVE,
  },

  federal_agency: {
    policyId: 'federal.federal_agency',
    version: GA_POLICY_VERSION,
    jurisdiction: 'federal',
    audienceType: 'federal_agency',
    label: 'Federal agency',
    allowedIntents: [
      'meeting_request',
      'information_share',
      'comment_submission',
      'rulemaking_input',
      'technical_briefing',
      'follow_up',
      'thank_you',
    ],
    salutationRule:
      'Open with a short professional greeting using the recipient’s real name and, where known, their formal title. Never open with "Dear".',
    terminologyRules: [
      'Use administrative-process vocabulary: proposed rule, comment period, final rule, guidance, docket. Do not describe agency action in legislative terms.',
      'Never describe agency guidance as law, or a proposed rule as final.',
    ],
    askRules: [
      'One clear ask, framed as information, a technical briefing, or a docket submission — not as a legislative position.',
      'Do not ask an agency official to take a position on pending legislation.',
    ],
    requiredEvidenceTypes: ['recipient_identity'],
    prohibitedAssumptions: [
      'Do not attribute a policy position to a career official.',
      'Do not imply the agency has decided anything the evidence does not state.',
      'Do not imply a quid pro quo or anything of value in exchange for official action.',
    ],
    defaultTone: 'formal',
    defaultLength: 'standard',
    requiresAsOfDates: true,
    appliesHillEtiquette: true,
    validators: [...BASE_VALIDATORS, 'jurisdiction_vocabulary'],
    freshness: FRESHNESS_LEGISLATIVE,
  },

  defense_acquisition_office: {
    policyId: 'federal.defense_acquisition_office',
    version: GA_POLICY_VERSION,
    jurisdiction: 'federal',
    audienceType: 'defense_acquisition_office',
    label: 'Defense acquisition office',
    allowedIntents: [
      'capability_brief',
      'information_share',
      'meeting_request',
      'rfi_response_notice',
      'follow_up',
    ],
    salutationRule:
      'Open with a short professional greeting using the recipient’s real name and rank/title where known. Never open with "Dear".',
    terminologyRules: [
      'Use acquisition vocabulary precisely: requirement, program of record, program element, RDT&E vs procurement, milestone, RFI/RFP, contract vehicle.',
      'A budget REQUEST, a congressional MARK, and an ENACTED amount are three different things and must be named as such with their fiscal year.',
      'Never describe an outyear projection as the current request.',
    ],
    askRules: [
      'One clear, procurement-appropriate ask (a technical exchange, an industry day, an RFI response).',
      'Do not ask for anything that would constitute improper influence on a source selection or an active competition.',
    ],
    requiredEvidenceTypes: ['recipient_identity'],
    prohibitedAssumptions: [
      'Do not imply any award, down-select, or preference the evidence does not state.',
      'Do not represent the client as an incumbent or awardee without explicit evidence.',
      'Do not discuss anything that reads as an attempt to influence an active source selection.',
    ],
    defaultTone: 'formal',
    defaultLength: 'standard',
    requiresAsOfDates: true,
    appliesHillEtiquette: true,
    validators: [...BASE_VALIDATORS, 'jurisdiction_vocabulary'],
    freshness: { ...FRESHNESS_LEGISLATIVE, programElement: 30 },
  },

  // ── State ─────────────────────────────────────────────────────────────────
  state_legislator: {
    policyId: 'state.state_legislator',
    version: GA_POLICY_VERSION,
    jurisdiction: 'state',
    audienceType: 'state_legislator',
    label: 'State legislator',
    allowedIntents: [
      'meeting_request',
      'position_ask',
      'information_share',
      'testimony_notice',
      'thank_you',
      'follow_up',
    ],
    salutationRule:
      'Open with a brief natural greeting using the recipient’s real first name or their state-appropriate title (e.g. "Assemblymember", "Delegate", "Senator"). Never open with "Dear".',
    terminologyRules: [
      'Use the CORRECT state vocabulary for the chamber and the process — a state measure is not "federal legislation", and state chambers are not uniformly "House" and "Senate" (Assembly, House of Delegates, General Assembly, and Legislature all exist).',
      'Never describe a state bill as enacted into federal law, referred to a federal committee, or signed by the President.',
      'A state bill becomes law when the Governor signs it (or by the state’s own veto/override process) — never by federal action.',
    ],
    askRules: [
      'One clear ask appropriate to a part-time or session-limited legislature; respect session calendars and crossover deadlines when the evidence provides them.',
    ],
    requiredEvidenceTypes: ['recipient_identity'],
    prohibitedAssumptions: [
      'Do not apply federal Hill etiquette, federal committee names, or federal procedural steps to a state legislature.',
      'Do not assume the legislator’s committee assignments or leadership role without evidence.',
      'Do not state or imply support the evidence does not prove.',
    ],
    defaultTone: 'professional',
    defaultLength: 'standard',
    requiresAsOfDates: true,
    // State ethics regimes differ from the federal LDA framework, so the FEDERAL
    // lobbying compliance block does not apply verbatim.
    appliesHillEtiquette: false,
    validators: [...BASE_VALIDATORS, 'jurisdiction_vocabulary', 'federal_etiquette_scope'],
    freshness: FRESHNESS_LEGISLATIVE,
  },

  state_agency: {
    policyId: 'state.state_agency',
    version: GA_POLICY_VERSION,
    jurisdiction: 'state',
    audienceType: 'state_agency',
    label: 'State agency',
    allowedIntents: [
      'meeting_request',
      'information_share',
      'comment_submission',
      'technical_briefing',
      'follow_up',
    ],
    salutationRule:
      'Open with a short professional greeting using the recipient’s real name and formal title where known. Never open with "Dear".',
    terminologyRules: [
      'Use state administrative vocabulary; do not import federal rulemaking terms (e.g. "Federal Register", "CFR") for a state process.',
      'Never describe state agency guidance as law.',
    ],
    askRules: ['One clear ask, framed as information or a technical exchange.'],
    requiredEvidenceTypes: ['recipient_identity'],
    prohibitedAssumptions: [
      'Do not apply federal Hill etiquette or federal procedure to a state agency.',
      'Do not attribute a policy position to a career official.',
    ],
    defaultTone: 'formal',
    defaultLength: 'standard',
    requiresAsOfDates: true,
    appliesHillEtiquette: false,
    validators: [...BASE_VALIDATORS, 'jurisdiction_vocabulary', 'federal_etiquette_scope'],
    freshness: FRESHNESS_LEGISLATIVE,
  },

  // ── Local ─────────────────────────────────────────────────────────────────
  local_official: {
    policyId: 'local.local_official',
    version: GA_POLICY_VERSION,
    jurisdiction: 'local',
    audienceType: 'local_official',
    label: 'Local official',
    allowedIntents: [
      'meeting_request',
      'information_share',
      'project_support',
      'thank_you',
      'follow_up',
    ],
    salutationRule:
      'Open with a brief natural greeting using the recipient’s real name and local title (Mayor, Councilmember, Commissioner, Supervisor). Never open with "Dear".',
    terminologyRules: [
      'Use local-government vocabulary: ordinance, resolution, council/commission/board, agenda item, public comment.',
      'Never describe a local ordinance as state or federal legislation.',
    ],
    askRules: [
      'One clear, locally actionable ask; tie it to the jurisdiction’s own process (an agenda item, a public-comment window) when the evidence supports it.',
    ],
    requiredEvidenceTypes: ['recipient_identity'],
    prohibitedAssumptions: [
      'Do not apply federal Hill etiquette or federal procedure to a local body.',
      'Do not assume the official’s committee or portfolio without evidence.',
    ],
    defaultTone: 'professional',
    defaultLength: 'short',
    requiresAsOfDates: true,
    appliesHillEtiquette: false,
    validators: [...BASE_VALIDATORS, 'jurisdiction_vocabulary', 'federal_etiquette_scope'],
    freshness: FRESHNESS_LEGISLATIVE,
  },

  // ── Cross-jurisdiction ────────────────────────────────────────────────────
  coalition: {
    policyId: 'cross_jurisdiction.coalition',
    version: GA_POLICY_VERSION,
    jurisdiction: 'cross_jurisdiction',
    audienceType: 'coalition',
    label: 'Coalition partner',
    allowedIntents: [
      'coordination',
      'information_share',
      'joint_action_ask',
      'meeting_request',
      'follow_up',
    ],
    salutationRule:
      'Open with a brief collegial greeting using the recipient’s first name, or a collective greeting ("Hi all —") for a group.',
    terminologyRules: [
      'Name the jurisdiction for every legislative or regulatory reference — a coalition message may span federal, state, and local matters in one paragraph, and an unqualified "the bill" is ambiguous.',
      'Do not describe a coalition position as any member organization’s official position without evidence.',
    ],
    askRules: [
      'One clear coordination ask. Multiple asks are permitted when the selected template is a coordination update.',
    ],
    requiredEvidenceTypes: [],
    prohibitedAssumptions: [
      'Do not state that a coalition member has signed on, endorsed, or committed resources without explicit evidence.',
      'Do not represent the coalition’s membership beyond what the evidence lists.',
    ],
    defaultTone: 'professional',
    defaultLength: 'standard',
    requiresAsOfDates: true,
    appliesHillEtiquette: false,
    validators: [...BASE_VALIDATORS, 'jurisdiction_vocabulary'],
    freshness: FRESHNESS_LEGISLATIVE,
  },

  // ── Internal / client ─────────────────────────────────────────────────────
  client_executive: {
    policyId: 'internal.client_executive',
    version: GA_POLICY_VERSION,
    jurisdiction: 'internal',
    audienceType: 'client_executive',
    label: 'Client executive',
    allowedIntents: [
      'status_update',
      'strategy_recommendation',
      'information_share',
      'meeting_request',
      'decision_request',
      'follow_up',
    ],
    salutationRule:
      'Open with a brief, familiar greeting using the recipient’s first name. This is the firm’s own client — do not use congressional-office formality.',
    terminologyRules: [
      'Write as the client’s trusted operator: candid, specific, action-oriented.',
      'Still name jurisdictions and stages precisely — a client acting on "the bill passed" needs to know which chamber and whether it is law.',
    ],
    askRules: [
      'Multiple asks are permitted: an internal briefing may legitimately request several decisions or confirmations.',
      'Do NOT require a single congressional-style ask, and do not frame the message as an external advocacy request.',
    ],
    requiredEvidenceTypes: [],
    prohibitedAssumptions: [
      'Do not apply Hill etiquette or federal lobbying-compliance framing to the client’s own executives.',
      'Do not overstate progress; distinguish what happened from what we are pursuing.',
      'Do not invent outcomes, commitments, or meetings.',
    ],
    defaultTone: 'professional',
    defaultLength: 'standard',
    requiresAsOfDates: true,
    appliesHillEtiquette: false,
    validators: [...BASE_VALIDATORS, 'federal_etiquette_scope'],
    freshness: FRESHNESS_INTERNAL,
  },

  internal_colleague: {
    policyId: 'internal.internal_colleague',
    version: GA_POLICY_VERSION,
    jurisdiction: 'internal',
    audienceType: 'internal_colleague',
    label: 'Internal colleague',
    allowedIntents: [
      'status_update',
      'handoff',
      'information_share',
      'decision_request',
      'follow_up',
    ],
    salutationRule:
      'Open with a short informal greeting using the colleague’s first name, or none at all for a brief internal note.',
    terminologyRules: [
      'Internal shorthand is acceptable, but every factual claim still needs a source.',
      'Name jurisdictions and stages precisely.',
    ],
    askRules: ['Multiple asks are permitted. No external-advocacy ask structure is required.'],
    requiredEvidenceTypes: [],
    prohibitedAssumptions: [
      'Do not apply Hill etiquette or federal lobbying-compliance framing to an internal note.',
      'Do not invent status, outcomes, or client instructions.',
    ],
    defaultTone: 'concise',
    defaultLength: 'short',
    requiresAsOfDates: false,
    appliesHillEtiquette: false,
    validators: [...BASE_VALIDATORS, 'federal_etiquette_scope'],
    freshness: FRESHNESS_INTERNAL,
  },
};

/** Every defined audience, for exhaustiveness tests. */
export const GA_AUDIENCES: GaAudience[] = Object.keys(POLICIES) as GaAudience[];

export const GA_JURISDICTIONS: GaJurisdiction[] = [
  'federal',
  'state',
  'local',
  'cross_jurisdiction',
  'internal',
];

/** Fetch a policy by audience. */
export function policyForAudience(audience: GaAudience): GaPolicy {
  return POLICIES[audience];
}

/** Raised when the audience cannot be determined. NEVER defaulted to federal. */
export class AudiencePolicyRequiredError extends Error {
  readonly code = 'AUDIENCE_POLICY_REQUIRED';
  readonly candidates: GaAudience[];
  constructor(message: string, candidates: GaAudience[] = []) {
    super(message);
    this.name = 'AudiencePolicyRequiredError';
    this.candidates = candidates;
  }
}

/** Inputs the resolver may use. All server-derived. */
export interface PolicySelectionInput {
  /** An explicit user/tenant choice always wins. */
  explicitAudience?: GaAudience | null;
  /** The wizard's direction: 'to-clients' is unambiguously internal. */
  direction?: 'on-behalf' | 'to-clients' | null;
  /** Selected template id (system template ids carry audience intent). */
  templateId?: string | null;
  /**
   * Server-resolved recipient signals, from the directory match / target office
   * rather than anything the browser asserted.
   */
  recipient?: {
    /** 'congress' | 'federal_agency' | 'state_legislature' | 'state_agency' | 'local' | 'client' | 'internal' | 'coalition' | null */
    sourceType?: string | null;
    /** Email domain, lowercased. */
    emailDomain?: string | null;
    /** Directory chamber, e.g. 'House' | 'Senate'. */
    chamber?: string | null;
    /** True when the recipient resolved to a DoD acquisition organization. */
    defenseAcquisition?: boolean;
  } | null;
}

/**
 * Deterministically select a policy from template + recipient source type.
 *
 * Throws AudiencePolicyRequiredError when the signals are absent or conflicting.
 * That is the correct behavior: asking the user which audience this is costs one
 * click, whereas silently applying congressional etiquette to a client executive
 * produces a message the lobbyist has to notice and rewrite.
 */
export function selectPolicy(input: PolicySelectionInput): GaPolicy {
  if (input.explicitAudience) return POLICIES[input.explicitAudience];

  // 'to-clients' is an unambiguous server-side signal: the wizard's own direction
  // step recorded that this campaign writes to the firm's portfolio clients.
  if (input.direction === 'to-clients') return POLICIES.client_executive;

  const r = input.recipient ?? null;
  const sourceType = r?.sourceType?.trim().toLowerCase() || null;
  const domain = r?.emailDomain?.trim().toLowerCase() || null;

  if (r?.defenseAcquisition) return POLICIES.defense_acquisition_office;

  switch (sourceType) {
    case 'congress':
    case 'congressional':
    case 'congress_member':
    case 'congress_staff':
      return POLICIES.congressional_office;
    case 'federal_agency':
    case 'agency':
      return POLICIES.federal_agency;
    case 'state_legislature':
    case 'state_legislator':
      return POLICIES.state_legislator;
    case 'state_agency':
      return POLICIES.state_agency;
    case 'local':
    case 'local_official':
      return POLICIES.local_official;
    case 'coalition':
      return POLICIES.coalition;
    case 'client':
    case 'client_executive':
      return POLICIES.client_executive;
    case 'internal':
    case 'internal_colleague':
      return POLICIES.internal_colleague;
    default:
      break;
  }

  // Domain-based inference, but ONLY for domains that are unambiguous by
  // construction. These are reserved federal legislative-branch domains; there
  // is no non-congressional sender behind mail.house.gov.
  if (domain) {
    if (domain.endsWith('mail.house.gov') || domain.endsWith('house.gov')) {
      return POLICIES.congressional_office;
    }
    if (domain.endsWith('senate.gov')) return POLICIES.congressional_office;
  }

  // Chamber alone is NOT sufficient: "House" and "Senate" name state chambers in
  // most states too, so inferring federal from chamber is precisely the silent
  // federal default this registry exists to prevent.
  throw new AudiencePolicyRequiredError(
    'The audience for this message could not be determined from the template and recipient. ' +
      'Choose an audience so the correct government-affairs rules apply — federal congressional ' +
      'etiquette must not be applied by default.',
    GA_AUDIENCES,
  );
}

/**
 * Render the policy as prompt text. Kept here (not in prompt-spec-v2) so adding
 * an audience never requires touching prompt assembly.
 */
export function renderPolicyBlock(policy: GaPolicy): string {
  const lines: string[] = [
    `AUDIENCE POLICY (${policy.label} — ${policy.jurisdiction}; policy ${policy.policyId} ${policy.version}):`,
    `- ${policy.salutationRule}`,
  ];
  for (const rule of policy.terminologyRules) lines.push(`- ${rule}`);
  for (const rule of policy.askRules) lines.push(`- ${rule}`);
  for (const rule of policy.prohibitedAssumptions) lines.push(`- ${rule}`);
  if (policy.requiresAsOfDates) {
    lines.push(
      '- Every legislative or funding claim must carry the as-of date supplied with its source. If no date is supplied, do not make the claim.',
    );
  }
  return lines.join('\n');
}

/**
 * Days after which a source of `evidenceType` needs an explicit as-of caveat
 * under this policy. Falls back to the most conservative configured threshold
 * rather than "no limit" for an unknown type.
 */
export function freshnessThresholdDays(policy: GaPolicy, evidenceType: string): number {
  const explicit = policy.freshness[evidenceType];
  if (typeof explicit === 'number') return explicit;
  const all = Object.values(policy.freshness);
  return all.length ? Math.min(...all) : 14;
}
