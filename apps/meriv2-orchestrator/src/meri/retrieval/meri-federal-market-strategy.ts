import type { MeriFederalMarketSignals } from './meri-federal-market-signals.js';
import {
  MERI_FEDERAL_MARKET_RESEARCH_DOMAINS,
  type MeriFederalMarketResearchDomain,
} from './meri-research-director.js';

export type MeriFederalMarketResearchWave =
  | 'capability'
  | 'mission'
  | 'budget'
  | 'acquisition'
  | 'congressional'
  | 'partners'
  | 'scale'
  | 'verification';

export interface MeriFederalMarketResearchQuery {
  id: string;
  wave: MeriFederalMarketResearchWave;
  domain: MeriFederalMarketResearchDomain;
  tool: string;
  input: Record<string, unknown>;
  reason: string;
}

export interface MeriFederalMarketStrategyBlueprint {
  version: 1;
  target: string;
  capabilityTerms: string[];
  missionTerms: string[];
  customerTerms: string[];
  acquisitionTerms: string[];
  congressionalTerms: string[];
  queries: MeriFederalMarketResearchQuery[];
}

export interface MeriStrategyObservedSource {
  domain: MeriFederalMarketResearchDomain;
  wave: MeriFederalMarketResearchWave;
  tool: string;
  result: unknown;
  query?: string;
}

export interface MeriFederalMarketCoverageGate {
  requiredDomains: MeriFederalMarketResearchDomain[];
  searchedDomains: MeriFederalMarketResearchDomain[];
  evidenceDomains: MeriFederalMarketResearchDomain[];
  missingDomains: MeriFederalMarketResearchDomain[];
  partialDomains: MeriFederalMarketResearchDomain[];
  sourceErrors: Array<{
    tool: string;
    domain: MeriFederalMarketResearchDomain;
    reason: string;
  }>;
  readyForSynthesis: boolean;
  criticFindings: string[];
}

interface OntologyRule {
  pattern: RegExp;
  missions: string[];
  customers: string[];
  acquisitions: string[];
  capabilityAliases: string[];
}

const ONTOLOGY: OntologyRule[] = [
  {
    pattern: /\b(?:uas|uav|drone|unmanned|autonomous|autonomy|robotic|airframe)\b/i,
    missions: [
      'launched effects',
      'small unmanned aircraft systems',
      'attritable autonomous systems',
      'offensive small UAS',
      'loitering munitions',
      'expeditionary unmanned systems',
      'autonomous warfare experimentation',
      'counter-UAS testing and threat surrogates',
    ],
    customers: [
      'Army PM UAS',
      'Army aviation',
      'USSOCOM',
      'Marine Corps unmanned systems',
      'Naval aviation',
      'Air Force autonomous systems',
    ],
    acquisitions: [
      'drone OTA consortium',
      'UAS marketplace',
      'component-inclusive prototype solicitation',
      'SOFWERX autonomous warfare',
      'Army xTech UAS',
    ],
    capabilityAliases: [
      'unmanned systems component',
      'platform integration kit',
      'modular autonomous systems subsystem',
    ],
  },
  {
    pattern:
      /\b(?:fiber|optic|communications?|data[-\s]?link|command|control|c2|network|rf|spectrum|video)\b/i,
    missions: [
      'assured command and control',
      'RF-denied mission continuity',
      'contested-spectrum communications',
      'resilient tactical data links',
      'payload and full-motion-video transport',
      'airborne network extension',
      'electronic-warfare-resilient connectivity',
    ],
    customers: [
      'C5ISR organizations',
      'electronic warfare organizations',
      'tactical communications program offices',
      'UAS payload and mission-system integrators',
    ],
    acquisitions: [
      'C5 Consortium',
      'communications prototype OTA',
      'resilient communications SBIR',
      'contested logistics and communications experimentation',
    ],
    capabilityAliases: [
      'control and data-link subsystem',
      'assured communications subsystem',
      'non-RF command link',
      'mission data transport',
    ],
  },
  {
    pattern: /\b(?:manufactur|domestic|supply\s+chain|production|ndaa|traceab|industrial)\b/i,
    missions: [
      'domestic defense industrial base',
      'secure drone component supply chain',
      'trusted and traceable manufacturing',
      'production scale-up for fielded technology',
    ],
    customers: [
      'Office of the Secretary of Defense industrial-base organizations',
      'service manufacturing and production offices',
      'Defense Contract Management Agency',
    ],
    acquisitions: [
      'APFIT production scale-up',
      'Defense Production Act Title III',
      'industrial base analysis and sustainment',
      'Office of Strategic Capital financing',
      'DCMA Blue List qualification',
    ],
    capabilityAliases: [
      'domestic production capacity',
      'serialized supply-chain traceability',
      'NDAA-compliant component manufacturing',
    ],
  },
  {
    pattern: /\b(?:ground|vehicle|logistics|resupply|mobility)\b/i,
    missions: [
      'autonomous ground systems',
      'expeditionary logistics',
      'tactical resupply unmanned systems',
      'contested logistics',
    ],
    customers: ['Army ground robotics', 'Marine Corps logistics', 'Defense Logistics Agency'],
    acquisitions: ['ground vehicle OTA', 'autonomous logistics prototype', 'robotics SBIR'],
    capabilityAliases: ['ground robotic subsystem', 'autonomous logistics integration'],
  },
  {
    pattern: /\b(?:maritime|naval|littoral|surface|undersea|usv|uuv)\b/i,
    missions: [
      'unmanned maritime systems',
      'littoral autonomous operations',
      'expeditionary maritime systems',
      'over-water contested communications',
    ],
    customers: [
      'Naval Sea Systems Command',
      'Naval Air Systems Command',
      'Marine Corps littoral forces',
    ],
    acquisitions: ['Naval Aviation Systems Consortium', 'Navy maritime prototype OTA'],
    capabilityAliases: ['littoral-qualified subsystem', 'maritime autonomous systems integration'],
  },
  {
    pattern: /\b(?:sensor|payload|isr|surveillance|targeting|reconnaissance)\b/i,
    missions: [
      'intelligence surveillance and reconnaissance',
      'payload integration',
      'target acquisition',
      'sensor data transport',
    ],
    customers: ['ISR program offices', 'mission payload integrators'],
    acquisitions: ['sensor payload prototype', 'ISR SBIR'],
    capabilityAliases: ['payload integration subsystem', 'sensor data architecture'],
  },
  {
    pattern: /\b(?:ai|artificial intelligence|machine learning|software|analytics)\b/i,
    missions: [
      'autonomous mission planning',
      'edge AI',
      'human-machine teaming',
      'operational analytics',
    ],
    customers: ['service autonomy offices', 'Chief Digital and Artificial Intelligence Office'],
    acquisitions: [
      'Tradewinds solutions marketplace',
      'AI prototype OTA',
      'SBIR Direct-to-Phase II',
    ],
    capabilityAliases: ['edge software subsystem', 'autonomy software module'],
  },
];

const GENERIC_ACQUISITION_TERMS = [
  'OTA consortium',
  'prototype solicitation',
  'sources sought',
  'broad agency announcement',
  'SBIR STTR',
  'Direct-to-Phase II',
  'xTech competition',
  'operational experimentation',
  'government marketplace',
  'APFIT',
];

const GENERIC_CONGRESSIONAL_TERMS = [
  'House defense appropriations report program increase',
  'Senate defense appropriations report',
  'NDAA report language',
  'congressional program increase',
  'appropriations explanatory statement',
  'Rules Committee defense appropriations amendment',
];

const WAVE_LIMITS: Record<MeriFederalMarketResearchWave, number> = {
  capability: 6,
  mission: 8,
  budget: 10,
  acquisition: 18,
  congressional: 10,
  partners: 8,
  scale: 7,
  verification: 5,
};

function unique(values: readonly string[], max = 100): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, max);
}

function normalizedMaterial(target: string, signals: MeriFederalMarketSignals): string {
  return [target, ...signals.capabilityTerms, ...signals.agencies, ...signals.serviceBranches]
    .join(' ')
    .toLowerCase();
}

function shortTerms(values: readonly string[], max: number): string[] {
  return unique(
    values.filter((value) => value.length >= 4),
    max,
  );
}

function queryKey(query: MeriFederalMarketResearchQuery): string {
  return `${query.tool}:${JSON.stringify(query.input)}`;
}

function balancedQueries(
  queries: MeriFederalMarketResearchQuery[],
): MeriFederalMarketResearchQuery[] {
  const seen = new Set<string>();
  const deduped = queries.filter((query) => {
    const key = queryKey(query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const selected = (Object.keys(WAVE_LIMITS) as MeriFederalMarketResearchWave[]).flatMap((wave) =>
    deduped.filter((query) => query.wave === wave).slice(0, WAVE_LIMITS[wave]),
  );
  return selected.map((query, index) => ({ ...query, id: `${query.wave}-${index + 1}` }));
}

export function buildMeriFederalMarketStrategyBlueprint(
  target: string,
  signals: MeriFederalMarketSignals,
): MeriFederalMarketStrategyBlueprint {
  const material = normalizedMaterial(target, signals);
  const missions: string[] = [];
  const customers: string[] = [];
  const acquisitions: string[] = [];
  const aliases: string[] = [];
  for (const rule of ONTOLOGY) {
    if (!rule.pattern.test(material)) continue;
    missions.push(...rule.missions);
    customers.push(...rule.customers);
    acquisitions.push(...rule.acquisitions);
    aliases.push(...rule.capabilityAliases);
  }

  // Comprehensive federal strategy always investigates industrial-base / scale-up
  // lanes. Seed those acquisition terms even when early company signals omit
  // explicit manufacturing vocabulary (they often only surface later in wave results).
  const industrialBaseRule = ONTOLOGY.find((rule) =>
    /manufactur|domestic|industrial|production|ndaa/.test(String(rule.pattern)),
  );
  if (industrialBaseRule) {
    acquisitions.push(...industrialBaseRule.acquisitions);
    aliases.push(...industrialBaseRule.capabilityAliases);
  }

  const capabilityTerms = shortTerms([...signals.capabilityTerms, ...aliases], 14);
  const missionTerms = shortTerms(missions.length ? missions : signals.capabilityTerms, 14);
  const customerTerms = shortTerms(
    [...signals.agencies, ...signals.serviceBranches, ...customers],
    12,
  );
  // Keep domain acquisitions (incl. APFIT / OTA / marketplace) ahead of generics and
  // allow enough headroom that multi-ontology hits do not drop scale-up vocabulary.
  const acquisitionTerms = shortTerms([...acquisitions, ...GENERIC_ACQUISITION_TERMS], 28);
  const congressionalTerms = shortTerms(
    [
      ...capabilityTerms.slice(0, 4).map((term) => `${term} congressional report language`),
      ...missionTerms.slice(0, 4).map((term) => `${term} program increase`),
      ...GENERIC_CONGRESSIONAL_TERMS,
    ],
    18,
  );

  const queries: MeriFederalMarketResearchQuery[] = [];
  const add = (
    wave: MeriFederalMarketResearchWave,
    domain: MeriFederalMarketResearchDomain,
    tool: string,
    input: Record<string, unknown>,
    reason: string,
  ) => queries.push({ id: '', wave, domain, tool, input, reason });

  add(
    'capability',
    'company_profile',
    'search_research_sources',
    { query: `${target} capabilities products customers programs`, limit: 25 },
    'Search authorized Capiro evidence about the company before relying only on public sources.',
  );
  add(
    'capability',
    'company_profile',
    'search_memory',
    { query: `${target} capabilities relationships customers priorities`, k: 15 },
    'Search authorized institutional memory for firm-specific company context.',
  );
  for (const term of capabilityTerms.slice(0, 5)) {
    add(
      'capability',
      'capability_model',
      'search_public_web',
      { query: `${target} ${term} technical capability integration`, limit: 10 },
      'Verify product architecture and translate marketing language into measurable capability evidence.',
    );
  }

  for (const term of missionTerms.slice(0, 8)) {
    add(
      'mission',
      'mission_map',
      'search_public_web',
      { query: `${term} Department of Defense program acquisition`, limit: 10 },
      'Discover government mission vocabulary and named program families connected to the capability.',
    );
    add(
      'mission',
      'mission_map',
      'search_intel_articles',
      { query: term, limit: 20 },
      'Search Capiro intelligence for current mission, program, acquisition and competitor context.',
    );
    add(
      'mission',
      'operational_validation',
      'search_committee_hearings',
      { query: term, limit: 15 },
      'Find hearings and oversight evidence that reveals validated operational needs and customer language.',
    );
    add(
      'budget',
      'budget_programs',
      'search_program_elements',
      { query: term, limit: 30 },
      'Search RDT&E Program Elements and procurement lines by mission language rather than literal product terminology.',
    );
  }

  for (const term of unique([...missionTerms.slice(0, 5), ...capabilityTerms.slice(0, 3)], 8)) {
    add(
      'acquisition',
      'contracts_otas',
      'search_sam_opportunities',
      { query: term, limit: 25, includeInactive: true },
      'Find active, forecasted, recently closed and recurring contracting signals that reveal acquisition demand and vocabulary.',
    );
    add(
      'acquisition',
      'grants_innovation',
      'search_federal_grants',
      { query: term, limit: 20 },
      'Find NOFO, SBIR-adjacent and technology-maturation opportunities tied to a mission or transition need.',
    );
  }
  for (const naics of signals.naicsCodes.slice(0, 4)) {
    add(
      'acquisition',
      'contracts_otas',
      'search_sam_opportunities',
      { naics, limit: 30, includeInactive: true },
      'Search verified NAICS lanes without relying on exact-name keyword matches.',
    );
  }
  for (const term of acquisitionTerms.slice(0, 12)) {
    add(
      'acquisition',
      term.includes('SBIR') || term.includes('xTech') || term.includes('Phase II')
        ? 'grants_innovation'
        : term.includes('experimentation') || term.includes('SOFWERX')
          ? 'operational_validation'
          : 'contracts_otas',
      'search_public_web',
      { query: `${missionTerms[0] ?? capabilityTerms[0] ?? target} ${term}`, limit: 10 },
      'Discover acquisition channels, recurring prototype mechanisms, marketplaces, consortia and operational-test routes.',
    );
  }

  for (const term of congressionalTerms.slice(0, 12)) {
    add(
      'congressional',
      'congressional',
      'search_public_web',
      { query: term, limit: 10 },
      'Search authorization, appropriations, program increases, explanatory statements and amendment pathways using capability and mission language.',
    );
  }
  for (const term of unique([...missionTerms.slice(0, 3), ...capabilityTerms.slice(0, 2)], 5)) {
    add(
      'congressional',
      'congressional',
      'search_congress_bills',
      { query: term, limit: 20 },
      'Search Capiro congressional data for bills, provisions and current legislative vehicles tied to the capability or mission.',
    );
  }

  for (const term of missionTerms.slice(0, 5)) {
    add(
      'partners',
      'partners',
      'search_public_web',
      { query: `${term} vendors OEM integrators awardees`, limit: 10 },
      'Identify platform vendors, primes, integrators and likely design-in routes.',
    );
    add(
      'partners',
      'partners',
      'search_federal_awards',
      { query: term, limit: 50 },
      'Identify incumbent recipients and customer/agency patterns from actual awards.',
    );
  }

  const scaleQueries = [
    `${target} SAM UEI CAGE CMMC NIST 800-171 ITAR EAR`,
    `${target} domestic manufacturing supply chain traceability`,
    `${missionTerms[0] ?? target} APFIT production scale-up`,
    `${missionTerms[0] ?? target} Defense Production Act Title III`,
    `${missionTerms[0] ?? target} Office of Strategic Capital financing`,
    `${missionTerms[0] ?? target} DCMA Blue List`,
    `${missionTerms[0] ?? target} industrial base manufacturing capacity`,
  ];
  for (const term of scaleQueries) {
    const domain: MeriFederalMarketResearchDomain = /SAM|CMMC|NIST|ITAR|EAR|Blue List/i.test(term)
      ? 'compliance'
      : 'industrial_base';
    add(
      'scale',
      domain,
      'search_public_web',
      { query: term, limit: 10 },
      'Assess market access, domestic production, qualification, scale-up and strategic-finance requirements.',
    );
  }

  for (const term of unique([...capabilityTerms.slice(0, 3), ...missionTerms.slice(0, 3)], 6)) {
    add(
      'verification',
      'risks',
      'search_gao_reports',
      { query: term, limit: 10 },
      'Find authoritative implementation, acquisition, testing or supply-chain risks that should shape the strategy.',
    );
    add(
      'verification',
      'congressional',
      'search_crs_reports',
      { query: term, limit: 10 },
      'Find authoritative policy and congressional context for the mission and acquisition lane.',
    );
  }

  return {
    version: 1,
    target,
    capabilityTerms,
    missionTerms,
    customerTerms,
    acquisitionTerms,
    congressionalTerms,
    queries: balancedQueries(queries),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sourceError(result: unknown): string | null {
  if (!isRecord(result)) return null;
  return typeof result.error === 'string' && result.error.trim() ? result.error.trim() : null;
}

function arrayRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!isRecord(result)) return [];
  for (const key of ['results', 'items', 'data', 'rows', 'opportunities', 'awards', 'grants']) {
    if (Array.isArray(result[key])) return result[key] as unknown[];
  }
  return [];
}

function hasEvidence(result: unknown): boolean {
  if (arrayRows(result).length > 0) return true;
  if (!isRecord(result)) return typeof result === 'string' && result.trim().length > 40;
  return [
    'title',
    'name',
    'description',
    'summary',
    'text',
    'bodyText',
    'canonicalName',
    'peCode',
    'budgetExhibitType',
  ].some((key) => typeof result[key] === 'string' && String(result[key]).trim().length > 0);
}

export function evaluateMeriFederalMarketStrategyCoverage(input: {
  sources: readonly MeriStrategyObservedSource[];
  derivedDomains?: readonly MeriFederalMarketResearchDomain[];
  identityUsable: boolean;
}): MeriFederalMarketCoverageGate {
  const searched = new Set<MeriFederalMarketResearchDomain>(input.derivedDomains ?? []);
  const evidence = new Set<MeriFederalMarketResearchDomain>(input.derivedDomains ?? []);
  const sourceErrors: MeriFederalMarketCoverageGate['sourceErrors'] = [];

  for (const source of input.sources) {
    const error = sourceError(source.result);
    if (error) {
      sourceErrors.push({ tool: source.tool, domain: source.domain, reason: error });
      continue;
    }
    searched.add(source.domain);
    if (hasEvidence(source.result)) evidence.add(source.domain);
  }
  if (input.identityUsable) {
    searched.add('identity');
    evidence.add('identity');
  }

  const requiredDomains = [...MERI_FEDERAL_MARKET_RESEARCH_DOMAINS];
  const searchedDomains = requiredDomains.filter((domain) => searched.has(domain));
  const evidenceDomains = requiredDomains.filter((domain) => evidence.has(domain));
  const missingDomains = requiredDomains.filter((domain) => !searched.has(domain));
  const partialDomains = requiredDomains.filter(
    (domain) => searched.has(domain) && !evidence.has(domain),
  );

  const coreDomains: MeriFederalMarketResearchDomain[] = [
    'identity',
    'company_profile',
    'capability_model',
    'mission_map',
    'budget_programs',
    'contracts_otas',
    'congressional',
    'partners',
    'compliance',
  ];
  const readyForSynthesis =
    input.identityUsable &&
    coreDomains.every((domain) => searched.has(domain)) &&
    evidenceDomains.length >= 9;

  const criticFindings: string[] = [];
  if (!input.identityUsable) {
    criticFindings.push(
      'Identity remains unresolved or materially ambiguous; keep all recommendations conditional.',
    );
  }
  if (missingDomains.length) {
    criticFindings.push(`Uninvestigated domains remain: ${missingDomains.join(', ')}.`);
  }
  if (partialDomains.length) {
    criticFindings.push(
      `The following domains were searched but returned no usable evidence: ${partialDomains.join(', ')}. Distinguish a searched miss from proof of absence.`,
    );
  }
  if (!evidence.has('budget_programs')) {
    criticFindings.push(
      'No load-bearing Program Element or procurement account has been validated.',
    );
  }
  if (!evidence.has('contracts_otas')) {
    criticFindings.push(
      'No current or recurring acquisition channel has usable evidence; avoid presenting a keyword match as a pursuit.',
    );
  }
  if (!evidence.has('congressional')) {
    criticFindings.push(
      'No congressional hook has usable evidence; do not invent report language or a funding increase.',
    );
  }
  if (!evidence.has('partners')) {
    criticFindings.push(
      'Partner/OEM routes remain unsubstantiated; identify them as hypotheses rather than established relationships.',
    );
  }

  return {
    requiredDomains,
    searchedDomains,
    evidenceDomains,
    missingDomains,
    partialDomains,
    sourceErrors,
    readyForSynthesis,
    criticFindings,
  };
}
