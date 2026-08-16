import {
  extractMeriFederalMarketSignals,
  meriFederalMarketQualificationGaps,
  meriFederalMarketSearchTerms,
  type MeriFederalMarketSignals,
} from '../retrieval/meri-federal-market-signals.js';
import {
  buildMeriFederalMarketStrategyBlueprint,
  evaluateMeriFederalMarketStrategyCoverage,
  type MeriFederalMarketResearchQuery,
  type MeriFederalMarketResearchWave,
  type MeriStrategyObservedSource,
} from '../retrieval/meri-federal-market-strategy.js';
import {
  buildMeriResearchDirectorPlan,
  type MeriFederalMarketResearchDomain,
} from '../retrieval/meri-research-director.js';
import {
  extractMeriClientOverlapSignals,
  scoreMeriPortfolioOverlap,
} from '../retrieval/meri-portfolio-overlap.js';
import { executeMeriExternalCompanyDiscovery } from './meriv3-external-company-discovery.js';
import {
  actualClientId,
  evidenceRows,
  isRecord,
  parallelMapLimit,
  recipeCoverage,
  resultHasError,
  resultRows,
  safeInvoke,
  safePagedLda,
  sourceCount,
  stringValue,
  uniqueEvidence,
  type MeriRecipeEvidence,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

export async function executeMeriExternalCompanyResearch(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const target = stringValue(input.entity) ?? ctx.plan.targetHint;
  if (!target) return { error: 'entity is required', results: [] };

  // External-company research is a discovery workflow, not an exact-name
  // lookup. The skill normalizes malformed inputs, runs typo-tolerant public
  // discovery, reconciles likely legal names/domains against registries, and
  // verifies a likely official site before deciding identity is unavailable.
  const discovery = await executeMeriExternalCompanyDiscovery(target, ctx.invoke);
  const resolution = discovery.resolution;
  const canonical = discovery.researchName;
  const sources: SourceResult[] = [
    {
      tool: 'resolve_entity',
      result: {
        ...resolution,
        identityStatus: discovery.identityStatus,
        researchName: canonical,
        correctionApplied: discovery.correctionApplied,
        candidates: discovery.candidates.slice(0, 5),
      },
    },
    ...discovery.sources,
  ];

  const domain =
    resolution.resolvedEntity?.domains[0] ??
    discovery.selectedCandidate?.domains[0];
  sources.push(
    ...(await Promise.all([
      safeInvoke(ctx.invoke, 'search_public_web', {
        query: `${canonical} official company capabilities products services`,
        limit: 10,
      }),
      safeInvoke(ctx.invoke, 'search_public_web', {
        query: `${canonical} government contracts federal customers awards`,
        limit: 10,
      }),
      safeInvoke(ctx.invoke, 'search_public_web', {
        query: `"${canonical}" company`,
        limit: 10,
      }),
      safePagedLda(ctx.invoke, { clientName: canonical, limit: 50, page: 1 }, 4),
      safeInvoke(ctx.invoke, 'search_sec_filings', { query: canonical, limit: 25 }),
      safeInvoke(ctx.invoke, 'search_federal_awards', { query: canonical, limit: 50 }),
      safeInvoke(ctx.invoke, 'search_research_sources', { query: canonical, limit: 25 }),
      safeInvoke(ctx.invoke, 'search_memory', {
        query: `internal relationships, capabilities, programs, customers, and prior work involving ${canonical}`,
        k: 15,
      }),
      ...(domain && !discovery.officialSite
        ? [safeInvoke(ctx.invoke, 'scrape_web_page', { url: `https://${domain}` })]
        : []),
    ])),
  );

  const initialSignals = extractMeriFederalMarketSignals(sources);
  const searchTerms = meriFederalMarketSearchTerms(initialSignals).slice(0, 6);
  const discoveryWave: Array<Promise<SourceResult>> = [];
  for (const term of searchTerms.slice(0, 4)) {
    discoveryWave.push(
      safeInvoke(ctx.invoke, 'search_sam_opportunities', { query: term, limit: 15 }),
    );
  }
  for (const naics of initialSignals.naicsCodes.slice(0, 3)) {
    discoveryWave.push(
      safeInvoke(ctx.invoke, 'search_sam_opportunities', { naics, limit: 20 }),
    );
  }
  for (const term of searchTerms.slice(0, 3)) {
    discoveryWave.push(
      safeInvoke(ctx.invoke, 'search_federal_grants', { query: term, limit: 15 }),
    );
  }
  for (const term of searchTerms.slice(0, 4)) {
    discoveryWave.push(
      safeInvoke(ctx.invoke, 'search_program_elements', { query: term, limit: 20 }),
    );
  }
  if (discoveryWave.length) sources.push(...(await Promise.all(discoveryWave)));

  const discoveredSignals = extractMeriFederalMarketSignals(sources);
  const peValidation = await Promise.all(
    discoveredSignals.peCodes.slice(0, 5).map(async (peCode) => {
      const [detail, budgetTimeline, reportLanguage] = await Promise.all([
        safeInvoke(ctx.invoke, 'get_program_element', { peCode }),
        safeInvoke(ctx.invoke, 'get_pe_budget_timeline', { peCode }),
        safeInvoke(ctx.invoke, 'get_pe_report_language', { peCode }),
      ]);
      sources.push(detail, budgetTimeline, reportLanguage);
      return {
        peCode,
        detail: detail.result,
        budgetTimeline: budgetTimeline.result,
        reportLanguage: reportLanguage.result,
        verified:
          !resultHasError(detail.result) &&
          !resultHasError(budgetTimeline.result),
      };
    }),
  );

  const signals = extractMeriFederalMarketSignals(sources);
  const evidence = uniqueEvidence(
    sources.flatMap((source) => evidenceRows(source.tool, source.result, 20)),
  );
  const historicalAwardCount = sourceCount(sources, 'search_federal_awards');
  const qualificationGaps = meriFederalMarketQualificationGaps({
    resolutionStatus: resolution.resolutionStatus,
    identifiers: resolution.resolvedEntity?.identifiers ?? null,
    signals,
    historicalAwardCount,
  });
  if (discovery.identityStatus === 'provisional') {
    qualificationGaps.unshift(
      'Company identity is a high-confidence provisional web/official-domain match and should be confirmed before an external submission or binding pursuit decision.',
    );
  }
  if (discovery.identityStatus === 'ambiguous' && discovery.ambiguityReason) {
    qualificationGaps.unshift(discovery.ambiguityReason);
  }

  const byTool = (tool: string, max: number) =>
    evidence.filter((row) => row.sourceTool === tool).slice(0, max);
  const identityUsable =
    discovery.identityStatus === 'resolved' ||
    discovery.identityStatus === 'provisional';
  const manifest = recipeCoverage(
    ['identity', 'public_web', 'registries', 'awards', 'opportunities'],
    sources,
    1,
    identityUsable ? 1 : 0,
  );
  const researchEntity = resolution.resolvedEntity ??
    (discovery.selectedCandidate
      ? {
          canonicalName: discovery.selectedCandidate.canonicalName,
          domains: discovery.selectedCandidate.domains,
          identifiers: {},
          confidence: discovery.selectedCandidate.score,
          provenance: ['public_web', 'official_site'],
        }
      : null);

  return {
    tool: 'research_external_company',
    subject: target,
    researchSubject: canonical,
    researchEntity,
    resolvedEntity: resolution.resolvedEntity,
    resolutionStatus: resolution.resolutionStatus,
    identityDiscovery: {
      status: discovery.identityStatus,
      normalizedInput: discovery.normalizedInput,
      researchName: canonical,
      correctionApplied: discovery.correctionApplied,
      queryVariants: discovery.queryVariants,
      selectedCandidate: discovery.selectedCandidate,
      candidates: discovery.candidates.slice(0, 5),
      officialSiteVerified: Boolean(
        discovery.officialSite && !resultHasError(discovery.officialSite.result),
      ),
      ambiguityReason: discovery.ambiguityReason,
    },
    federalMarketSignals: signals,
    searchTermsUsed: searchTerms,
    qualificationGaps,
    publicCapabilities: [
      ...byTool('scrape_web_page', 8),
      ...byTool('search_public_web', 16),
    ].slice(0, 20),
    historicalAwards: byTool('search_federal_awards', 25),
    candidateOpportunities: byTool('search_sam_opportunities', 35),
    candidateGrants: byTool('search_federal_grants', 20),
    candidateProgramElements: byTool('search_program_elements', 35),
    validatedProgramElements: peValidation,
    results: evidence.slice(0, 100),
    coverage: manifest,
    answerDirective:
      identityUsable
        ? 'Produce the full company and federal-market report now. Do not ask the user to provide the legal name, website, UEI, CAGE, or capabilities when this result already contains a resolved or high-confidence provisional identity and retrieved official/public evidence. Clearly label provisional identity, verified facts, inferred fit, qualification gaps, and candidate opportunities.'
        : 'Do not stop merely because the literal input did not resolve. Use the discovered candidates and evidence to explain the ambiguity, provide any useful conditional findings that are safe, and ask for clarification only when two materially plausible companies remain after the full discovery workflow.',
    nextRecommendedTools: [
      'specialist opportunity tools before treating a SAM/NOFO search match as a pursue recommendation',
      'government-directory/acquisition-personnel tools when a validated PE needs a stakeholder engagement plan',
    ],
    note:
      'External-company research is discovery-first and typo-tolerant. A failed literal lookup is not a stopping condition. Verified company facts, high-confidence provisional identity, candidate federal-market matches, and strategic inference are separate layers. Capability-driven SAM/grant/PE searches are discovery, not proof of eligibility, customer demand, appropriability, or program alignment. Up to five discovered PE codes are checked against canonical PE detail, budget, and report-language readers. Ask the user for identity information only after broad unquoted discovery, candidate reconciliation, registry follow-up, and official-site verification still leave material ambiguity.',
  };
}

function federalSignalsFromResearch(company: unknown): MeriFederalMarketSignals {
  if (isRecord(company) && isRecord(company.federalMarketSignals)) {
    const signals = company.federalMarketSignals;
    const pick = (key: string): string[] => {
      const raw = signals[key];
      return Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string')
        : [];
    };
    return {
      capabilityTerms: pick('capabilityTerms'),
      agencies: pick('agencies'),
      serviceBranches: pick('serviceBranches'),
      naicsCodes: pick('naicsCodes'),
      pscCodes: pick('pscCodes'),
      peCodes: pick('peCodes'),
    };
  }
  const evidence = isRecord(company) && Array.isArray(company.results) ? company.results : [];
  return extractMeriFederalMarketSignals([
    { tool: 'companyResearch', result: { results: evidence } },
  ]);
}

interface RankedProgramCandidate {
  peCode: string;
  score: number;
  titles: string[];
  matchedQueries: string[];
  evidence: MeriRecipeEvidence[];
}

function textField(record: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = stringValue(record[name]);
    if (value) return value;
  }
  return null;
}

function programCode(record: Record<string, unknown>): string | null {
  const code = textField(record, [
    'peCode',
    'code',
    'peNumber',
    'programElement',
    'programElementCode',
    'lineItem',
    'lineItemCode',
  ]);
  if (!code) return null;
  const normalized = code.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return /^(?:\d{7}[A-Z]|\d{4}[A-Z]\d{4}|\d{8,12})$/.test(normalized)
    ? normalized
    : null;
}

function programCandidateText(record: Record<string, unknown>): string {
  return [
    textField(record, ['title', 'name', 'programName']),
    textField(record, ['description', 'summary', 'snippet', 'mission']),
    textField(record, ['service', 'serviceBranch', 'militaryService']),
    textField(record, ['budgetActivity', 'appropriationType', 'budgetExhibitType']),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
}

function termTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4);
}

function overlapScore(left: string, right: string): number {
  const leftTokens = new Set(termTokens(left));
  const rightTokens = new Set(termTokens(right));
  let score = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) score += 1;
  return score;
}

function rankedProgramCandidates(
  sources: readonly MeriStrategyObservedSource[],
  signals: MeriFederalMarketSignals,
  missionTerms: readonly string[],
): RankedProgramCandidate[] {
  const candidates = new Map<string, RankedProgramCandidate>();
  for (const source of sources) {
    if (source.tool !== 'search_program_elements') continue;
    const query = source.query ?? '';
    for (const raw of resultRows(source.result)) {
      if (!isRecord(raw)) continue;
      const peCode = programCode(raw);
      if (!peCode) continue;
      const title = textField(raw, ['title', 'name', 'programName']) ?? peCode;
      const material = programCandidateText(raw);
      const score =
        4 +
        overlapScore(material, query) * 2 +
        missionTerms.reduce((total, term) => total + Math.min(overlapScore(material, term), 3), 0);
      const current = candidates.get(peCode) ?? {
        peCode,
        score: 0,
        titles: [],
        matchedQueries: [],
        evidence: [],
      };
      current.score += score;
      current.titles = [...new Set([...current.titles, title])].slice(0, 4);
      if (query) {
        current.matchedQueries = [...new Set([...current.matchedQueries, query])].slice(0, 8);
      }
      current.evidence.push(...evidenceRows(source.tool, { results: [raw] }, 1));
      candidates.set(peCode, current);
    }
  }

  for (const peCode of signals.peCodes) {
    if (!candidates.has(peCode)) {
      candidates.set(peCode, {
        peCode,
        score: 2,
        titles: [peCode],
        matchedQueries: [],
        evidence: [],
      });
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.peCode.localeCompare(b.peCode))
    .slice(0, 12);
}

function evidenceByDomain(
  sources: readonly MeriStrategyObservedSource[],
  domain: MeriFederalMarketResearchDomain,
  max = 30,
): MeriRecipeEvidence[] {
  return uniqueEvidence(
    sources
      .filter((source) => source.domain === domain)
      .flatMap((source) => evidenceRows(source.tool, source.result, 12)),
  ).slice(0, max);
}

function extractUrls(result: unknown): string[] {
  const urls: string[] = [];
  for (const raw of resultRows(result)) {
    if (!isRecord(raw)) continue;
    for (const field of ['url', 'link', 'sourceUrl', 'webUrl', 'documentUrl']) {
      const value = stringValue(raw[field]);
      if (value && /^https?:\/\//i.test(value)) urls.push(value);
    }
  }
  return [...new Set(urls)];
}

function isHighValuePublicUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.endsWith('.gov') ||
      host.endsWith('.mil') ||
      host.endsWith('sofwerx.org') ||
      host.endsWith('xtech.army.mil') ||
      host.includes('sbir') ||
      host.includes('consortium') ||
      host.includes('sam.gov')
    );
  } catch {
    return false;
  }
}

function waveToolResult(
  query: MeriFederalMarketResearchQuery,
  source: SourceResult,
): MeriStrategyObservedSource {
  return {
    domain: query.domain,
    wave: query.wave,
    tool: source.tool,
    result: source.result,
    query:
      stringValue(query.input.query) ??
      stringValue(query.input.naics) ??
      query.reason,
  };
}

function validationSource(
  domain: MeriFederalMarketResearchDomain,
  wave: MeriFederalMarketResearchWave,
  source: SourceResult,
  query: string,
): MeriStrategyObservedSource {
  return { domain, wave, tool: source.tool, result: source.result, query };
}

/**
 * Comprehensive Research Director recipe.
 *
 * This deliberately starts with the narrower identity/company evidence packet,
 * then expands product language into government mission vocabulary, acquisition
 * channels, congressional hooks, partner routes, scale-up mechanisms, and
 * specialist budget validation. It is bounded and read-only, but it does not
 * allow a few literal keyword misses to redefine a broad strategy request.
 */
export async function executeMeriFederalMarketStrategyResearch(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const target = stringValue(input.entity) ?? ctx.plan.targetHint;
  if (!target) return { error: 'entity is required', results: [] };

  const companyResearch = await executeMeriExternalCompanyResearch({ entity: target }, ctx);
  const researchSubject =
    (isRecord(companyResearch) ? stringValue(companyResearch.researchSubject) : null) ?? target;
  const identityStatus =
    isRecord(companyResearch) && isRecord(companyResearch.identityDiscovery)
      ? stringValue(companyResearch.identityDiscovery.status)
      : null;
  const identityUsable = identityStatus === 'resolved' || identityStatus === 'provisional';
  const initialSignals = federalSignalsFromResearch(companyResearch);
  const directorPlan = buildMeriResearchDirectorPlan(
    stringValue(input.objective) ?? 'Comprehensive federal growth and capture strategy',
    researchSubject,
  );
  const blueprint = buildMeriFederalMarketStrategyBlueprint(researchSubject, initialSignals);

  const observed: MeriStrategyObservedSource[] = [];
  const queryResults = await parallelMapLimit(blueprint.queries, 8, async (query) => {
    const source = await safeInvoke(ctx.invoke, query.tool, query.input);
    return waveToolResult(query, source);
  });
  observed.push(...queryResults);

  // Search results often point to the authoritative source but expose only a
  // short snippet. Scrape a bounded set of high-value government/acquisition
  // pages so the strategy is based on the actual notice/report/program page.
  const authoritativePages = queryResults
    .flatMap((source) =>
      extractUrls(source.result).map((url) => ({
        url,
        domain: source.domain,
        wave: source.wave,
        query: source.query ?? url,
      })),
    )
    .filter((entry) => isHighValuePublicUrl(entry.url))
    .filter(
      (entry, index, values) =>
        values.findIndex((candidate) => candidate.url === entry.url) === index,
    )
    .slice(0, 14);
  const scrapedPages = await parallelMapLimit(authoritativePages, 5, async (entry) => {
    const source = await safeInvoke(ctx.invoke, 'scrape_web_page', { url: entry.url });
    return validationSource(entry.domain, entry.wave, source, entry.query);
  });
  observed.push(...scrapedPages);

  const expandedSignals = extractMeriFederalMarketSignals([
    { tool: 'research_external_company', result: companyResearch },
    ...observed.map((source) => ({ tool: source.tool, result: source.result })),
  ]);
  const candidates = rankedProgramCandidates(observed, expandedSignals, blueprint.missionTerms);

  const validatedPrograms = await parallelMapLimit(candidates.slice(0, 10), 4, async (candidate, index) => {
    const core = await Promise.all([
      safeInvoke(ctx.invoke, 'get_program_element', { peCode: candidate.peCode }),
      safeInvoke(ctx.invoke, 'get_pe_budget_timeline', { peCode: candidate.peCode }),
      safeInvoke(ctx.invoke, 'get_pe_report_language', { peCode: candidate.peCode }),
    ]);
    const [detail, budgetTimeline, reportLanguage] = core;
    observed.push(
      validationSource('budget_programs', 'verification', detail, candidate.peCode),
      validationSource('budget_programs', 'verification', budgetTimeline, candidate.peCode),
      validationSource('congressional', 'verification', reportLanguage, candidate.peCode),
    );

    let contractors: SourceResult | null = null;
    let bills: SourceResult | null = null;
    let personnel: SourceResult | null = null;
    if (index < 6) {
      [contractors, bills, personnel] = await Promise.all([
        safeInvoke(ctx.invoke, 'get_pe_contractors', { peCode: candidate.peCode }),
        safeInvoke(ctx.invoke, 'get_pe_bills', { peCode: candidate.peCode }),
        safeInvoke(ctx.invoke, 'search_acquisition_personnel', {
          peCode: candidate.peCode,
          limit: 25,
        }),
      ]);
      observed.push(
        validationSource('partners', 'verification', contractors, candidate.peCode),
        validationSource('congressional', 'verification', bills, candidate.peCode),
        validationSource('stakeholders', 'verification', personnel, candidate.peCode),
      );
    }

    const detailRecord = isRecord(detail.result) ? detail.result : null;
    const exhibitType = detailRecord
      ? textField(detailRecord, ['budgetExhibitType', 'exhibitType', 'appropriationType'])
      : null;
    const programType = /p-?1|p-?40|procurement/i.test(exhibitType ?? '')
      ? 'procurement_line'
      : /r-?1|r-?2|rdt&e|research/i.test(exhibitType ?? '')
        ? 'program_element'
        : 'budget_line_unconfirmed';

    return {
      ...candidate,
      programType,
      budgetExhibitType: exhibitType,
      detail: detail.result,
      budgetTimeline: budgetTimeline.result,
      reportLanguage: reportLanguage.result,
      contractors: contractors?.result ?? null,
      bills: bills?.result ?? null,
      acquisitionPersonnel: personnel?.result ?? null,
      verified:
        !resultHasError(detail.result) &&
        !resultHasError(budgetTimeline.result),
      evidenceLimitations: [
        ...(resultHasError(detail.result) ? ['Program detail unavailable.'] : []),
        ...(resultHasError(budgetTimeline.result) ? ['Budget timeline unavailable.'] : []),
        ...(resultRows(reportLanguage.result).length === 0
          ? ['No linked committee report language was retrieved for this code.']
          : []),
      ],
    };
  });

  const finalSignals = extractMeriFederalMarketSignals([
    { tool: 'research_external_company', result: companyResearch },
    ...observed.map((source) => ({ tool: source.tool, result: source.result })),
  ]);

  const derivedDomains: MeriFederalMarketResearchDomain[] = [
    'company_profile',
    'capability_model',
    'mission_map',
    'execution',
    'risks',
    ...(validatedPrograms.some((program) => program.programType === 'procurement_line')
      ? (['procurement'] as MeriFederalMarketResearchDomain[])
      : []),
  ];
  const coverageGate = evaluateMeriFederalMarketStrategyCoverage({
    sources: observed,
    derivedDomains,
    identityUsable,
  });

  const allSources: SourceResult[] = [
    { tool: 'research_external_company', result: companyResearch },
    ...observed.map((source) => ({ tool: source.tool, result: source.result })),
  ];
  const evidence = uniqueEvidence(
    allSources.flatMap((source) => evidenceRows(source.tool, source.result, 16)),
  );
  const coverage = recipeCoverage(
    [
      'identity',
      'public_web',
      'registries',
      'awards',
      'opportunities',
      'grants',
      'budget',
      'intelligence',
      'directory',
    ],
    allSources,
    1,
    identityUsable ? 1 : 0,
  );

  return {
    tool: 'research_federal_market_strategy',
    subject: target,
    researchSubject,
    companyResearch,
    researchDirector: {
      plan: directorPlan,
      blueprint: {
        version: blueprint.version,
        capabilityTerms: blueprint.capabilityTerms,
        missionTerms: blueprint.missionTerms,
        customerTerms: blueprint.customerTerms,
        acquisitionTerms: blueprint.acquisitionTerms,
        congressionalTerms: blueprint.congressionalTerms,
        queryCount: blueprint.queries.length,
        wavesExecuted: [...new Set(blueprint.queries.map((query) => query.wave))],
      },
      coverageGate,
      criticChecklist: [
        ...directorPlan.stopConditions,
        ...coverageGate.criticFindings,
      ],
    },
    identityUsable,
    federalMarketSignals: finalSignals,
    capabilityMissionMap: {
      capabilities: blueprint.capabilityTerms,
      missions: blueprint.missionTerms,
      customers: blueprint.customerTerms,
      acquisitionVocabulary: blueprint.acquisitionTerms,
      congressionalVocabulary: blueprint.congressionalTerms,
    },
    programCandidates: candidates,
    validatedPrograms,
    acquisitionChannels: evidenceByDomain(observed, 'contracts_otas', 40),
    currentAndRecurringOpportunities: evidenceByDomain(observed, 'contracts_otas', 40),
    grantsAndInnovation: evidenceByDomain(observed, 'grants_innovation', 30),
    congressionalEvidence: evidenceByDomain(observed, 'congressional', 40),
    partnerAndOemEvidence: evidenceByDomain(observed, 'partners', 35),
    operationalValidation: evidenceByDomain(observed, 'operational_validation', 25),
    industrialBaseAndFinance: evidenceByDomain(observed, 'industrial_base', 25),
    complianceAndMarketAccess: evidenceByDomain(observed, 'compliance', 25),
    acquisitionStakeholders: evidenceByDomain(observed, 'stakeholders', 30),
    authoritativeRiskEvidence: evidenceByDomain(observed, 'risks', 25),
    publicEvidence: evidence.slice(0, 160),
    coverageGate,
    coverage,
    answerDirective:
      'Write an artifact-quality, client-ready federal growth and capture strategy using the Research Director plan. Do not collapse this into a short company profile or three-program shortlist. Cover every required section, rank Direct match / Conditional niche / Adjacency, distinguish current notices from recurring channels and future watch items, state the correct PE/procurement exhibit type and budget stage, connect each funding account to an acquisition/customer/partner path, include congressional and industrial-base lanes when supported, and provide a measurable 90-day plus 12–18 month roadmap. A searched miss is not proof the market lane is absent. Clearly identify remaining evidence gaps without handing the research task back to the user.',
    note:
      'This dossier was produced by deterministic multi-wave research across internal Capiro data and public sources, followed by specialist validation of the highest-ranked budget lines. The outer Meri runtime must perform its request-local senior-reviewer audit and final synthesis before releasing the answer.',
  };
}

export async function executeMeriPortfolioOverlap(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const target = stringValue(input.entity) ?? ctx.plan.targetHint;
  if (!target) return { error: 'entity is required', results: [] };
  const company = await executeMeriExternalCompanyResearch({ entity: target }, ctx);
  const companySignals = federalSignalsFromResearch(company);
  const activeClients = ctx.plan.activeClients;
  const scopedClients = activeClients.filter((client) => Boolean(client.id));

  const contexts = await parallelMapLimit(scopedClients, 5, async (client) => {
    const profile = await safeInvoke(ctx.invoke, 'get_client_context', { clientId: client.id });
    const realId = actualClientId(profile.result);
    const opportunity = realId
      ? await safeInvoke(ctx.invoke, 'get_opportunity_client_context', { clientId: realId })
      : null;
    const clientSignals = extractMeriClientOverlapSignals(profile.result, opportunity?.result);
    const match = scoreMeriPortfolioOverlap(companySignals, clientSignals);
    return { client, realId, profile, opportunity, clientSignals, match };
  });

  const ranked = contexts
    .sort(
      (a, b) =>
        b.match.score - a.match.score ||
        b.match.evidenceCoverage - a.match.evidenceCoverage,
    )
    .map((entry) => ({
      id: entry.realId ?? entry.client.id ?? entry.client.name,
      title: entry.client.name,
      url: null,
      snippet: `${entry.match.reasons.slice(0, 3).join('. ')}. Treat this as a candidate overlap until the underlying capabilities, customer need, and strategy are reviewed.`,
      sourceTool: 'get_client_context',
      clientId: entry.realId ?? entry.client.id,
      clientName: entry.client.name,
      metadata: {
        overlapScore: entry.match.score,
        confidence: entry.match.confidence,
        evidenceCoverage: entry.match.evidenceCoverage,
        dimensions: entry.match.dimensions,
        matchedTerms: entry.match.matchedTerms,
        matchedPeCodes: entry.match.matchedPeCodes,
        matchedAgencies: entry.match.matchedAgencies,
        matchedServiceBranches: entry.match.matchedServiceBranches,
        matchedNaicsCodes: entry.match.matchedNaicsCodes,
        matchedPscCodes: entry.match.matchedPscCodes,
        reasons: entry.match.reasons,
        profileGaps: entry.clientSignals.profileGaps,
      },
    }));
  const sourceResults = contexts.flatMap((entry) => [
    entry.profile,
    ...(entry.opportunity ? [entry.opportunity] : []),
  ]);
  const searchedClients = contexts.filter(
    (entry) => !resultHasError(entry.profile.result),
  ).length;
  const manifest = recipeCoverage(
    ['identity', 'clients', 'internal_research'],
    sourceResults,
    activeClients.length,
    searchedClients,
  );
  return {
    tool: 'query_portfolio_overlap',
    subject: target,
    companyResearch: company,
    companySignals,
    results: ranked.slice(0, 50),
    coverage: manifest,
    note:
      'Overlap is multi-signal: capability language, shared Program Elements, agencies/customers, military services, NAICS and PSC are scored separately and confidence is calibrated to evidence coverage. It is candidate generation, not evidence that two companies have a relationship or should team.',
  };
}
