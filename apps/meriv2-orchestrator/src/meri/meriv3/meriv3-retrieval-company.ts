import {
  extractMeriFederalMarketSignals,
  meriFederalMarketQualificationGaps,
  meriFederalMarketSearchTerms,
  type MeriFederalMarketSignals,
} from '../retrieval/meri-federal-market-signals.js';
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
  safeInvoke,
  safePagedLda,
  sourceCount,
  stringValue,
  uniqueEvidence,
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
