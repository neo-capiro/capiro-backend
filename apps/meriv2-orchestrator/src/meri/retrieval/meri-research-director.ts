export const MERI_FEDERAL_MARKET_RESEARCH_DOMAINS = [
  'identity',
  'company_profile',
  'capability_model',
  'mission_map',
  'budget_programs',
  'procurement',
  'contracts_otas',
  'grants_innovation',
  'congressional',
  'partners',
  'operational_validation',
  'industrial_base',
  'compliance',
  'stakeholders',
  'execution',
  'risks',
] as const;

export type MeriFederalMarketResearchDomain = (typeof MERI_FEDERAL_MARKET_RESEARCH_DOMAINS)[number];

export type MeriResearchReasoningMode = 'fast' | 'standard' | 'deep' | 'max';

export interface MeriResearchWavePlan {
  id:
    | 'identity'
    | 'capability'
    | 'mission'
    | 'acquisition'
    | 'congressional'
    | 'scale'
    | 'verification';
  objective: string;
  requiredDomains: MeriFederalMarketResearchDomain[];
  guidance: string[];
}

export interface MeriResearchDirectorPlan {
  version: 1;
  taskType: 'federal_market_strategy';
  target: string;
  comprehensive: true;
  minimumReasoningMode: 'deep';
  requiredDomains: MeriFederalMarketResearchDomain[];
  hypotheses: string[];
  waves: MeriResearchWavePlan[];
  outputSections: string[];
  stopConditions: string[];
}

const COMPREHENSIVE_RESEARCH_PATTERNS = [
  /\bcomprehensive\b/i,
  /\bfederal\s+(?:growth|market|capture|pursuit)\s+strategy\b/i,
  /\b(?:growth|capture|market|pursuit)\s+strategy\b/i,
  /\bwhat\s+(?:program\s+elements?|pes?|grants?|contracts?|opportunities)\b/i,
  /\bwhat\s+should\s+.+\s+pursue\b/i,
  /\btell\s+me\s+what\s+.+\s+should\s+pursue\b/i,
  /\bprogram\s+elements?.*\bgrants?.*\bcontracts?\b/i,
  /\bgovernment\s+contracts?.*\bgrants?\b/i,
  /\bfull\s+(?:federal|government)\s+(?:strategy|assessment|report)\b/i,
];

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function isComprehensiveFederalMarketResearch(
  request: string,
  queryClass?: string | null,
): boolean {
  const text = request.trim();
  if (!text) return false;
  if (queryClass === 'federal_market_analysis') return true;
  return COMPREHENSIVE_RESEARCH_PATTERNS.some((pattern) => pattern.test(text));
}

export function elevateMeriResearchReasoningMode(
  current: MeriResearchReasoningMode | undefined,
  comprehensive: boolean,
): MeriResearchReasoningMode {
  const mode = current ?? 'standard';
  if (!comprehensive) return mode;
  return mode === 'max' ? 'max' : 'deep';
}

function domainHypotheses(request: string): string[] {
  const text = request.toLowerCase();
  const hypotheses = [
    'The strongest funded mission may use government terminology different from the company’s product language.',
    'The fastest revenue path may be an OEM or prime design-in rather than a direct prime contract.',
    'Prototype access may come through an OTA, consortium, marketplace, test organization, SBIR, or xTech pathway rather than an open solicitation using the company’s exact terminology.',
    'A Program Element or procurement line is only a funding alignment; the capture plan must identify the corresponding customer, acquisition mechanism, partner route, and transition path.',
    'Congressional report language or an existing program increase may provide a stronger advocacy hook than a new stand-alone funding request.',
  ];

  if (/\b(?:uas|uav|drone|unmanned|autonomous|robotic)\b/.test(text)) {
    hypotheses.push(
      'Launched effects, small UAS, attritable autonomous systems, loitering systems, operational experimentation, and component-inclusive drone acquisition channels may be material adjacencies.',
    );
  }
  if (
    /\b(?:fiber|communications?|data[-\s]?link|command\s+and\s+control|c2|rf[-\s]?denied)\b/.test(
      text,
    )
  ) {
    hypotheses.push(
      'The capability should be searched as assured command-and-control, payload data transport, contested-spectrum resilience, network extension, and mission continuity—not only by its component name.',
    );
  }
  if (/\b(?:domestic|manufactur|supply\s+chain|ndaa|production|scale)\b/.test(text)) {
    hypotheses.push(
      'APFIT, industrial-base programs, DPA pathways, strategic financing, domestic traceability, and qualification programs may become relevant after customer demand is demonstrated.',
    );
  }
  return unique(hypotheses);
}

export function buildMeriResearchDirectorPlan(
  request: string,
  targetHint?: string | null,
): MeriResearchDirectorPlan {
  const target = targetHint?.trim() || 'the named company';
  return {
    version: 1,
    taskType: 'federal_market_strategy',
    target,
    comprehensive: true,
    minimumReasoningMode: 'deep',
    requiredDomains: [...MERI_FEDERAL_MARKET_RESEARCH_DOMAINS],
    hypotheses: domainHypotheses(`${request} ${target}`),
    waves: [
      {
        id: 'identity',
        objective:
          'Resolve the correct company and authoritative public identity before market analysis.',
        requiredDomains: ['identity', 'company_profile'],
        guidance: [
          'Normalize misspellings, joined words, domains, aliases, legal suffixes, and trade names.',
          'Use official-site, registry, award, and internal identity evidence; retain ambiguity instead of merging conflicting companies.',
        ],
      },
      {
        id: 'capability',
        objective:
          'Translate products into capabilities, operational effects, constraints, proof requirements, and federal vocabulary.',
        requiredDomains: ['capability_model', 'compliance'],
        guidance: [
          'Separate verified product facts from inferred mission applications.',
          'Search government language, not only the company’s marketing terminology.',
        ],
      },
      {
        id: 'mission',
        objective:
          'Generate and test mission, platform, customer, program-family, and transition hypotheses.',
        requiredDomains: [
          'mission_map',
          'budget_programs',
          'procurement',
          'operational_validation',
        ],
        guidance: [
          'Search direct fits, conditional niches, and material adjacencies.',
          'Do not let the first few Program Element matches define the whole strategy.',
        ],
      },
      {
        id: 'acquisition',
        objective:
          'Find concrete acquisition access: solicitations, OTAs, consortia, marketplaces, primes, OEMs, test organizations, and innovation programs.',
        requiredDomains: ['contracts_otas', 'grants_innovation', 'partners', 'stakeholders'],
        guidance: [
          'Treat current notices, recurring channels, and partner routes as separate evidence classes.',
          'Evaluate eligibility, timing, maturity, customer access, and transition—not keyword similarity alone.',
        ],
      },
      {
        id: 'congressional',
        objective:
          'Search authorization, appropriations, report language, program increases, and viable congressional advocacy pathways.',
        requiredDomains: ['congressional'],
        guidance: [
          'Search exact capability terms plus broader mission/program language.',
          'Distinguish a current committee recommendation, a request, an enacted amount, and a proposed future ask.',
        ],
      },
      {
        id: 'scale',
        objective:
          'Assess domestic production, industrial-base, compliance, financing, and defensibility requirements.',
        requiredDomains: ['industrial_base', 'compliance', 'risks'],
        guidance: [
          'Use scale-up capital after demand and transition sponsorship are credible.',
          'Identify qualification, cyber, supply-chain, quality, export-control, and production gaps.',
        ],
      },
      {
        id: 'verification',
        objective:
          'Verify load-bearing programs, amounts, report language, deadlines, eligibility, performers, and stakeholder identities before synthesis.',
        requiredDomains: [
          'budget_programs',
          'procurement',
          'contracts_otas',
          'grants_innovation',
          'congressional',
          'stakeholders',
        ],
        guidance: [
          'Validate Program Element and procurement-line type, current-cycle budget stage, and report language with specialist readers.',
          'Challenge omissions, contradictions, over-conservative conclusions, and speculative recommendations before writing.',
        ],
      },
    ],
    outputSections: [
      'Executive summary and identity confidence',
      'Verified company profile and capability architecture',
      'Strategic positioning and market thesis',
      'Capability-to-mission and customer map',
      'Ranked Program Elements and procurement accounts',
      'Current contracts, solicitations, OTAs, consortia, and marketplaces',
      'Grants, SBIR/STTR, xTech, and other non-dilutive pathways',
      'OEM, prime, and operational-validation strategy',
      'Congressional authorization and appropriations strategy',
      'Industrial-base, manufacturing, and strategic-finance pathways',
      'Compliance and market-access requirements',
      'Stakeholder and acquisition engagement plan',
      'Immediate 90-day capture plan',
      '12–18 month roadmap with exit criteria',
      'Risks, guardrails, uncertainties, and source basis',
    ],
    stopConditions: [
      'Every required domain was investigated or explicitly marked unavailable/not applicable.',
      'The strongest program and procurement recommendations were validated with canonical detail and budget-stage evidence.',
      'The strategy includes acquisition access and transition pathways, not only funding-account similarity.',
      'A silent critic pass found no material omitted lane that can still be investigated with available tools.',
      'The final answer distinguishes verified facts, evidence-backed inference, conditional fit, adjacency, and unresolved gaps.',
    ],
  };
}

export function meriResearchDirectorPrompt(plan: MeriResearchDirectorPlan): string {
  return [
    '# Research Director — mandatory comprehensive workflow',
    `Research subject: ${plan.target}.`,
    'This is a comprehensive federal-market strategy, not a narrow lookup or a three-result Program Element shortlist.',
    'Use the dedicated federal-market strategy recipe first. Then use lower-level tools only to close a named gap, validate a load-bearing record, or investigate a critic finding.',
    'Do not let zero results from a literal query end the investigation. Translate product language into capabilities, operational effects, mission vocabulary, program families, acquisition channels, and congressional terminology.',
    '',
    'Working hypotheses to test—not assume:',
    ...plan.hypotheses.map((hypothesis) => `- ${hypothesis}`),
    '',
    'Required research waves:',
    ...plan.waves.flatMap((wave) => [
      `## ${wave.id.toUpperCase()}: ${wave.objective}`,
      ...wave.guidance.map((item) => `- ${item}`),
    ]),
    '',
    `Required domains: ${plan.requiredDomains.join(', ')}.`,
    'Do not synthesize early merely because some coverage is partial. First use the remaining research budget to close material gaps. Partial coverage must shape uncertainty, not shrink a broad request into a narrow answer.',
  ].join('\n');
}

export function meriResearchCriticInstructions(plan: MeriResearchDirectorPlan): string {
  return [
    '# SILENT SENIOR-REVIEWER PASS',
    `Audit the accumulated research for ${plan.target} as a senior federal capture executive and defense-market analyst.`,
    'Do not answer the user in this pass. Produce a compact internal audit that the final synthesis can use.',
    'Identify omitted program families, procurement pull-through, acquisition channels, current or recurring prototype routes, operational-test pathways, OEM/prime routes, congressional hooks, transition funding, industrial-base pathways, compliance requirements, unsupported claims, contradictory recommendations, and places where the research was too literal.',
    'For every proposed recommendation, test: mission fit, funding fit, acquisition access, customer access, partner access, maturity fit, congressional fit, timing, and evidence confidence.',
    `Audit against these required sections: ${plan.outputSections.join('; ')}.`,
    'Return only a concise JSON object with keys: missingSections, unsupportedClaims, contradictions, overlookedLanes, requiredCaveats, synthesisPriorities.',
  ].join('\n');
}

export function meriResearchSynthesisInstructions(
  plan: MeriResearchDirectorPlan,
  scheduleConstraints = '',
): string {
  return [
    '# ARTIFACT-QUALITY FEDERAL STRATEGY SYNTHESIS',
    `Write the complete strategy for ${plan.target}.`,
    'Use the full evidence record and the silent senior-reviewer audit. Correct omissions before writing. Do not mention the hidden audit or private reasoning.',
    'The answer must be useful even when some sources are unavailable. Continue with verified and clearly labeled provisional findings rather than replacing the report with a request for information the research already found.',
    'Rank recommendations into Direct match, Conditional niche, and Adjacency. Explain why each belongs in that tier.',
    'For every Program Element or procurement line, state the correct exhibit/type, current-cycle budget stage, why the mission connects to the capability, the acquisition/partner path, and the principal uncertainty. Do not present a PE as a solicitation.',
    'For opportunities and grants, separate current notices from recurring channels and future watch items. State eligibility and deadline uncertainty honestly.',
    'Make congressional recommendations capability-class based and competitive; never direct an award to the company.',
    'Provide concrete next actions, owners/customer types, sequencing, and measurable exit criteria.',
    scheduleConstraints,
    '',
    'Required structure:',
    ...plan.outputSections.map((section, index) => `${index + 1}. ${section}`),
    '',
    'Do not omit a required section merely because evidence is thin. State the evidence gap and the prudent action in that section.',
    'Aim for a detailed client-ready report, not a short chat summary.',
  ].join('\n');
}
