import type { MeriContext } from '@capiro/meriv2-core';
import { meriRecipeCatalogEntry } from './meri-data-catalog.js';
import { isComprehensiveFederalMarketResearch } from './meri-research-director.js';
import type {
  MeriQueryClass,
  MeriRetrievalIntent,
  MeriSubjectScope,
} from './meri-retrieval-intent.js';

/** Recipes represented in the static Meri data catalog. */
export const MERI_RETRIEVAL_RECIPE_TOOLS = [
  'query_relationship_brief',
  'query_client_changes',
  'query_portfolio_changes',
  'research_external_company',
  'query_portfolio_overlap',
] as const;

export type MeriRetrievalRecipeTool = (typeof MERI_RETRIEVAL_RECIPE_TOOLS)[number];

/** Runtime recipes include the deeper Research Director workflow. */
export const MERI_RUNTIME_RETRIEVAL_RECIPE_TOOLS = [
  ...MERI_RETRIEVAL_RECIPE_TOOLS,
  'research_federal_market_strategy',
] as const;

export type MeriRuntimeRetrievalRecipeTool =
  (typeof MERI_RUNTIME_RETRIEVAL_RECIPE_TOOLS)[number];

export type MeriRetrievalDomain =
  | 'identity'
  | 'clients'
  | 'internal_research'
  | 'documents'
  | 'mail'
  | 'contacts'
  | 'meetings'
  | 'tasks'
  | 'action_items'
  | 'outreach'
  | 'memory'
  | 'legislation'
  | 'hearings'
  | 'regulatory'
  | 'directory'
  | 'intelligence'
  | 'economic'
  | 'budget'
  | 'opportunities'
  | 'awards'
  | 'grants'
  | 'registries'
  | 'public_web';

export interface MeriRetrievalClientRef {
  /** UUID when supplied by the context plane; otherwise exact authorized client name. */
  id?: string;
  name: string;
  status: string;
}

export interface MeriRetrievalTimeWindow {
  expression: string;
  withinDays: number;
}

export interface MeriRetrievalPlan {
  version: 1;
  queryClass: MeriQueryClass;
  subjectScope: MeriSubjectScope;
  targetHint: string | null;
  recipeTool: MeriRuntimeRetrievalRecipeTool | null;
  requireCompleteCoverage: boolean;
  requiredDomains: MeriRetrievalDomain[];
  optionalDomains: MeriRetrievalDomain[];
  recommendedTools: string[];
  timeWindow: MeriRetrievalTimeWindow | null;
  activeClients: MeriRetrievalClientRef[];
  reasons: string[];
}

const PORTFOLIO_OVERLAP_RE =
  /\b(?:search|scan|compare)\s+(?:across|against)\s+(?:my|our|the)?\s*clients?\b|\bwhich\s+(?:of\s+)?(?:my|our)\s+clients?\b|\bportfolio\s+(?:overlap|match|partner|fit)\b|\bpotential\s+partners?\s+(?:in|across)\s+(?:my|our)\s+(?:clients?|portfolio)\b/i;

const MAIL_HISTORY_RE =
  /\b(?:email|emails|mail|mailbox|inbox|correspondence|messages?)\b.*\b(?:history|with|from|about|between)\b|\b(?:history|correspondence)\b.*\b(?:email|emails|mail|mailbox|inbox|messages?)\b|\blook\s+in\s+my\s+inbox\b/i;

const QUICK_COMPANY_QUERY_CLASSES: MeriQueryClass[] = [
  'lookup',
  'semantic_recall',
  'entity_history',
  'temporal_state',
];

const RESEARCH_DIRECTOR_REQUIRED_DOMAINS: MeriRetrievalDomain[] = [
  'identity',
  'public_web',
  'registries',
  'awards',
  'opportunities',
  'grants',
  'budget',
  'intelligence',
  'directory',
];

const RESEARCH_DIRECTOR_OPTIONAL_DOMAINS: MeriRetrievalDomain[] = [
  'internal_research',
  'memory',
  'legislation',
  'hearings',
];

const RESEARCH_DIRECTOR_RECOMMENDED_TOOLS = [
  'research_federal_market_strategy',
  'research_external_company',
  'resolve_entity',
  'search_public_web',
  'scrape_web_page',
  'search_lda_filings',
  'search_sec_filings',
  'search_federal_awards',
  'search_sam_opportunities',
  'search_federal_grants',
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
  'get_pe_report_language',
  'get_pe_contractors',
  'get_pe_bills',
  'search_acquisition_personnel',
  'search_intel_articles',
  'search_gao_reports',
  'search_crs_reports',
  'search_committee_hearings',
  'search_research_sources',
  'search_memory',
];

const MAIL_HISTORY_RECOMMENDED_TOOLS = [
  'query_relationship_brief',
  'search_emails',
  'find_contacts',
  'search_memory',
  'lookup_client_registry',
];

const RELATIONSHIP_RECOMMENDED_TOOLS = [
  ...MAIL_HISTORY_RECOMMENDED_TOOLS,
  'get_client_context',
  'search_client_knowledge',
  'query_debriefs',
  'query_tasks',
  'query_outreach',
];

const QUICK_COMPANY_RECOMMENDED_TOOLS = [
  'research_external_company',
  'lookup_client_registry',
  'search_research_sources',
  'search_public_web',
  'scrape_web_page',
];

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function inferTimeWindow(request: string): MeriRetrievalTimeWindow | null {
  const normalized = request.toLowerCase();
  const explicitDays = normalized.match(/\b(?:last|past|previous|within)\s+(\d{1,3})\s+days?\b/);
  if (explicitDays?.[1]) {
    return {
      expression: explicitDays[0],
      withinDays: Math.min(Math.max(Number(explicitDays[1]) || 7, 1), 365),
    };
  }
  if (/\btoday\b|\bsince this morning\b/.test(normalized)) {
    return { expression: 'today', withinDays: 1 };
  }
  if (/\byesterday\b/.test(normalized)) {
    return { expression: 'yesterday', withinDays: 2 };
  }
  if (/\bthis week\b|\bsince monday\b|\bweek to date\b|\bwtd\b/.test(normalized)) {
    return { expression: 'this week', withinDays: 7 };
  }
  if (/\blast week\b|\bprevious week\b/.test(normalized)) {
    return { expression: 'last week', withinDays: 14 };
  }
  if (/\bthis month\b|\bmonth to date\b|\bmtd\b/.test(normalized)) {
    return { expression: 'this month', withinDays: 31 };
  }
  return null;
}

function recipeFor(
  request: string,
  intent: MeriRetrievalIntent,
): MeriRuntimeRetrievalRecipeTool | null {
  // This explicit command is a follow-up to an entity/company analysis in the
  // product flow. Check it before the generic portfolio-scan rule so “Search
  // across clients” compares the current entity against the portfolio instead
  // of returning an unrelated weekly-change brief.
  if (PORTFOLIO_OVERLAP_RE.test(request)) return 'query_portfolio_overlap';
  if (
    intent.subjectScope === 'portfolio' &&
    (intent.queryClass === 'change_detection' || intent.queryClass === 'portfolio_scan')
  ) {
    return 'query_portfolio_changes';
  }
  if (intent.subjectScope === 'client' && intent.queryClass === 'change_detection') {
    return 'query_client_changes';
  }
  // Research Director must win over exhaustive_search → relationship_brief when the
  // user asked for a comprehensive federal/company strategy.
  if (isComprehensiveFederalMarketResearch(request, intent.queryClass)) {
    return 'research_federal_market_strategy';
  }
  if (intent.queryClass === 'federal_market_analysis') {
    return 'research_external_company';
  }
  if (
    intent.queryClass === 'relationship_history' ||
    (intent.queryClass === 'exhaustive_search' && intent.subjectScope === 'external_entity')
  ) {
    return 'query_relationship_brief';
  }
  if (intent.queryClass === 'comparison' && intent.subjectScope === 'external_entity') {
    return 'research_external_company';
  }
  if (
    intent.subjectScope === 'external_entity' &&
    QUICK_COMPANY_QUERY_CLASSES.includes(intent.queryClass)
  ) {
    return 'research_external_company';
  }
  return null;
}

export function buildMeriRetrievalPlan(
  request: string,
  intent: MeriRetrievalIntent,
  ctx: MeriContext,
  priorTargetHint?: string | null,
): MeriRetrievalPlan {
  const recipeTool = recipeFor(request, intent);
  const catalogRecipe =
    recipeTool && recipeTool !== 'research_federal_market_strategy'
      ? meriRecipeCatalogEntry(recipeTool)
      : null;
  const roster = (ctx.clientRoster ?? []) as MeriRetrievalClientRef[];
  // Every client-scoped Meri tool resolves an exact display name through the
  // same authorization choke point when no UUID is available. Using that exact
  // name here avoids a second client-roster query and still fails closed on an
  // ambiguous or unauthorized name.
  const activeClients = roster
    .filter((client) => client.status === 'active')
    .map((client) => ({ ...client, id: client.id ?? client.name }));
  const timeWindow = inferTimeWindow(request);
  // Only the existing explicit portfolio-overlap follow-up inherits an entity.
  // A formatting or client-scoped turn must not silently carry an old subject.
  const targetHint = intent.targetHint
    ?? (recipeTool === 'query_portfolio_overlap' ? priorTargetHint ?? null : null);
  const mailHistoryFocus =
    recipeTool === 'query_relationship_brief' && MAIL_HISTORY_RE.test(request);
  const quickCompanyProfile =
    recipeTool === 'research_external_company' &&
    QUICK_COMPANY_QUERY_CLASSES.includes(intent.queryClass);
  const reasons = [...intent.reasonCodes];
  if (recipeTool) reasons.push(`recipe:${recipeTool}`);
  if (recipeTool === 'research_federal_market_strategy') reasons.push('research-director-required');
  if (mailHistoryFocus) reasons.push('mail-history-focus');
  if (quickCompanyProfile) reasons.push('quick-company-profile');
  if (timeWindow) reasons.push(`time-window:${timeWindow.expression}`);
  if (targetHint && !intent.targetHint) reasons.push('target-from-conversation-history');
  if (intent.requireCompleteCoverage) reasons.push('coverage-required');

  const requiredDomains =
    recipeTool === 'research_federal_market_strategy'
      ? RESEARCH_DIRECTOR_REQUIRED_DOMAINS
      : mailHistoryFocus
        ? (['mail'] as MeriRetrievalDomain[])
        : recipeTool === 'query_relationship_brief'
          ? (['mail', 'contacts', 'memory'] as MeriRetrievalDomain[])
          : quickCompanyProfile
            ? (['public_web'] as MeriRetrievalDomain[])
            : catalogRecipe?.requiredDomains ?? [];
  const optionalDomains =
    recipeTool === 'research_federal_market_strategy'
      ? RESEARCH_DIRECTOR_OPTIONAL_DOMAINS
      : mailHistoryFocus
        ? (['contacts', 'memory', 'internal_research'] as MeriRetrievalDomain[])
        : recipeTool === 'query_relationship_brief'
          ? ([
              'clients',
              'internal_research',
              'documents',
              'meetings',
              'tasks',
              'outreach',
            ] as MeriRetrievalDomain[])
          : quickCompanyProfile
            ? (['clients', 'internal_research'] as MeriRetrievalDomain[])
            : catalogRecipe?.optionalDomains ?? [];
  const recommendedTools =
    recipeTool === 'research_federal_market_strategy'
      ? RESEARCH_DIRECTOR_RECOMMENDED_TOOLS
      : mailHistoryFocus
        ? MAIL_HISTORY_RECOMMENDED_TOOLS
        : recipeTool === 'query_relationship_brief'
          ? RELATIONSHIP_RECOMMENDED_TOOLS
          : quickCompanyProfile
            ? QUICK_COMPANY_RECOMMENDED_TOOLS
            : catalogRecipe?.recommendedTools ?? [];

  return {
    version: 1,
    queryClass: intent.queryClass,
    subjectScope: intent.subjectScope,
    targetHint,
    recipeTool,
    requireCompleteCoverage: intent.requireCompleteCoverage,
    requiredDomains: unique(requiredDomains),
    optionalDomains: unique(optionalDomains),
    recommendedTools: unique(recommendedTools),
    timeWindow,
    activeClients,
    reasons: unique(reasons),
  };
}

export function meriRetrievalPlanPrompt(plan: MeriRetrievalPlan): string {
  const lines = [
    '# Deterministic Meri retrieval plan',
    `Query class: ${plan.queryClass}.`,
    `Subject scope: ${plan.subjectScope}.`,
    `Complete coverage required: ${plan.requireCompleteCoverage ? 'yes' : 'no'}.`,
  ];
  if (plan.targetHint) lines.push(`Resolved subject hint: ${plan.targetHint}.`);
  if (plan.timeWindow) {
    lines.push(
      `Requested time window: ${plan.timeWindow.expression} (use withinDays=${plan.timeWindow.withinDays} when the tool supports it; preserve the user's exact date wording in the answer).`,
    );
  }
  if (plan.recipeTool) {
    lines.push(
      `Call ${plan.recipeTool} FIRST. It performs the required deterministic fan-out and returns a coverage manifest. Use lower-level tools afterward only to close a named gap or verify a load-bearing record.`,
    );
  }
  if (plan.reasons.includes('mail-history-focus')) {
    lines.push(
      'This is a mailbox-history request. Mail is the required evidence lane; contacts and memory are supplementary. Do not search public web, LDA, SEC, awards, grants, contracts, Program Elements, legislation, or other federal-market sources for this answer.',
    );
  }
  if (plan.reasons.includes('quick-company-profile')) {
    lines.push(
      'This is a bounded company-description request. Stop once client, official-site, or reliable public evidence supports the company’s core capabilities. Do not search LDA, SEC, awards, SAM, grants, Program Elements, report language, or federal opportunities unless the user explicitly asks for federal-market research.',
    );
  }
  if (plan.recipeTool === 'research_federal_market_strategy') {
    lines.push(
      'This recipe is a Research Director workflow. Do not substitute research_external_company or a few literal keyword searches. It must complete capability abstraction, mission expansion, acquisition-channel discovery, congressional research, program validation, partner analysis, compliance/scale analysis, and a senior-reviewer gap check before synthesis.',
    );
  }
  if (plan.requiredDomains.length) {
    lines.push(`Required evidence domains: ${plan.requiredDomains.join(', ')}.`);
  }
  if (plan.optionalDomains.length) {
    lines.push(`Optional evidence domains when material: ${plan.optionalDomains.join(', ')}.`);
  }
  if (plan.subjectScope === 'portfolio') {
    lines.push(
      `Authorized active client count: ${plan.activeClients.length}. A portfolio-wide claim is incomplete unless the recipe reports all ${plan.activeClients.length} were searched or identifies the omitted clients/sources.`,
    );
    if (plan.activeClients.length) {
      lines.push(
        'Authorized active clients (UUID or exact authorized name):\n' +
          plan.activeClients
            .slice(0, 100)
            .map((client) => `- ${client.name} (${client.id})`)
            .join('\n'),
      );
    }
  }
  lines.push(
    'Do not replace an enumerative recipe with one generic keyword search. Do not turn zero matches into a claim of absence unless coverage.complete is true.',
  );
  return lines.join('\n');
}
