import {
  evidenceRows,
  isRecord,
  resultHasError,
  resultRows,
  safeInvoke,
  stringValue,
  uniqueEvidence,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

const SEARCH_PAGE_SIZE = 5;
const MAX_CANDIDATES = 3;

interface OpportunityRef {
  source: string;
  sourceRecordId: string;
  title: string;
}

function opportunityRefsFrom(result: unknown): OpportunityRef[] {
  if (!isRecord(result)) return [];
  const rows = [...resultRows(result)].filter(isRecord);
  const refs: OpportunityRef[] = [];
  for (const row of rows) {
    const source = stringValue(row.source) ?? stringValue(row.sourceType);
    const sourceRecordId =
      stringValue(row.sourceRecordId) ??
      stringValue(row.id) ??
      stringValue(row.noticeId) ??
      stringValue(row.opportunityId);
    const title =
      stringValue(row.title) ?? stringValue(row.name) ?? stringValue(row.headline) ?? '';
    if (source && sourceRecordId) {
      refs.push({ source, sourceRecordId, title });
    }
  }
  return refs;
}

function sourceHasEvidence(source: SourceResult): boolean {
  return !resultHasError(source.result) && resultRows(source.result).length > 0;
}

/**
 * Deterministic funding-opportunity match fan-out for "is this opportunity a
 * good fit for [client]?" requests. Discover candidates first, then run the
 * same client-context / government-landscape / match-explanation evidence
 * packet the semantic gateway's analyze_funding_opportunity expects — with a
 * coverage manifest instead of ad-hoc model fan-out.
 */
export async function executeMeriFundingOpportunityMatch(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const clientId = stringValue(input.clientId) ?? ctx.plan.activeClients[0]?.id ?? null;
  if (!clientId) {
    return { error: 'client is required', results: [] };
  }
  const keyword = stringValue(input.query) ?? ctx.plan.targetHint ?? null;

  const sources: SourceResult[] = [
    await safeInvoke(ctx.invoke, 'get_opportunity_client_context', { clientId }),
  ];
  const clientContext: SourceResult = sources[0] ?? {
    tool: 'get_opportunity_client_context',
    result: { error: 'client context unavailable' },
  };

  const searchResult = await safeInvoke(ctx.invoke, 'search_funding_opportunities', {
    clientId,
    ...(keyword ? { query: keyword.slice(0, 500) } : {}),
    activeState: 'active',
    page: 1,
    pageSize: SEARCH_PAGE_SIZE,
  });
  sources.push(searchResult);

  const candidates = opportunityRefsFrom(searchResult.result)
    .filter((ref) => ref.source === 'sam_gov' || ref.source === 'grants_gov')
    .slice(0, MAX_CANDIDATES);

  const matchResults = await Promise.all(
    candidates.map(async (ref) => {
      const [landscape, match] = await Promise.all([
        safeInvoke(ctx.invoke, 'get_opportunity_government_landscape', {
          clientId,
          source: ref.source,
          sourceRecordId: ref.sourceRecordId,
        }),
        safeInvoke(ctx.invoke, 'explain_opportunity_match', {
          clientId,
          source: ref.source,
          sourceRecordId: ref.sourceRecordId,
        }),
      ]);
      sources.push(landscape, match);
      return {
        source: ref.source,
        sourceRecordId: ref.sourceRecordId,
        title: ref.title,
        governmentLandscape: landscape.result,
        match: match.result,
      };
    }),
  );

  const evidence = uniqueEvidence(
    sources.flatMap((source) => evidenceRows(source.tool, source.result, 8)),
  );
  const successfulSources = sources.filter(sourceHasEvidence);
  const unavailable = sources.filter((source) => resultHasError(source.result));
  const complete =
    sourceHasEvidence(clientContext) && sourceHasEvidence(searchResult) && candidates.length > 0;

  return {
    tool: 'query_funding_opportunity_match',
    clientId,
    keyword,
    candidateCount: candidates.length,
    candidates: matchResults,
    clientContext: clientContext.result,
    results: evidence.slice(0, 40),
    coverage: {
      complete,
      authoritative: true,
      requestedDomains: ['opportunities', 'clients', 'identity'],
      searchedDomains: [
        ...new Set(
          successfulSources.map((source) =>
            source.tool.includes('opportunity') ? 'opportunities' : 'clients',
          ),
        ),
      ],
      requestedEntityCount: 1,
      searchedEntityCount: sourceHasEvidence(clientContext) ? 1 : 0,
      paginationComplete: candidates.length < SEARCH_PAGE_SIZE,
      partialSources: candidates.length === 0 ? ['no active candidates matched the query'] : [],
      unavailableSources: unavailable.map((source) => ({
        source: source.tool,
        reason:
          isRecord(source.result) && typeof source.result.error === 'string'
            ? source.result.error
            : 'unavailable',
      })),
    },
    answerDirective:
      'Answer the opportunity-fit question directly from the retrieved evidence. For each candidate: state what the opportunity funds, how it aligns with the client’s capabilities, past awards, and the agency/program landscape, and give the fit verdict with [N] citations. Use only the numbered [N] citations supplied with this tool result; never expose internal [S:tool:id] markers. The match/landscape tools return top-k evidence, not exhaustive coverage — do not claim the client was compared against every possible opportunity. Do not discuss tool execution, coverage plumbing, or failed optional sources unless the user asked.',
    nextRecommendedTools: [],
    note: 'Deterministic four-tool fan-out: client context → opportunity search → per-candidate government landscape + match explanation. Comparison across multiple known opportunities (compare_funding_opportunities) and action-plan generation (build_opportunity_action_plan) are separate intents and intentionally not part of this recipe.',
  };
}
