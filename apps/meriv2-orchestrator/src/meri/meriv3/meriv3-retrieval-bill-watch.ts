import {
  isRecord,
  resultHasError,
  resultRows,
  safeInvoke,
  stringValue,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

function sourceHasEvidence(source: SourceResult): boolean {
  return !resultHasError(source.result) && resultRows(source.result).length > 0;
}

/**
 * Deterministic Bill Watch fan-out for "what's happening with bills affecting
 * [client]?" requests. Tracked list first (our watch state), then federal and
 * (when the client has a state footprint) state legislation — one coverage
 * manifest, no silent omissions. Status-driven, unlike calendar-driven
 * Hearing Watch.
 */
export async function executeMeriBillWatch(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const clientId = stringValue(input.clientId) ?? ctx.plan.activeClients[0]?.id ?? null;
  if (!clientId) {
    return { error: 'client is required', results: [] };
  }

  const tracked: SourceResult = {
    tool: 'search_tracked_bills',
    result: await ctx.invoke('search_tracked_bills', { clientId }),
  };
  const sources: SourceResult[] = [tracked];

  const keyword =
    stringValue(input.query) ?? stringValue(input.keyword) ?? ctx.plan.targetHint ?? null;

  const congress: SourceResult = {
    tool: 'search_congress_bills',
    result: await ctx.invoke('search_congress_bills', {
      ...(keyword ? { query: keyword.slice(0, 500) } : {}),
      limit: 25,
      page: 1,
    }),
  };
  sources.push(congress);

  // State lane runs only when the caller indicates (or we are told to check)
  // a state footprint — otherwise it is an explicitly skipped coverage entry.
  const stateCodes = input.states;
  const states: string[] = Array.isArray(stateCodes)
    ? stateCodes.filter((s): s is string => typeof s === 'string')
    : typeof stateCodes === 'string' && stateCodes.trim()
      ? [stateCodes.trim()]
      : [];

  const stateSources: SourceResult[] = await Promise.all(
    states.map(async (state): Promise<SourceResult> => ({
      tool: 'search_state_bills',
      result: await ctx.invoke('search_state_bills', {
        state,
        ...(keyword ? { query: keyword.slice(0, 500) } : {}),
        limit: 25,
      }),
    })),
  );
  sources.push(...stateSources);

  const coverage = [
    { tool: 'search_tracked_bills', checked: true, complete: sourceHasEvidence(tracked) },
    { tool: 'search_congress_bills', checked: true, complete: sourceHasEvidence(congress) },
    ...states.map((state, index) => ({
      tool: `search_state_bills[${state}]`,
      checked: true,
      complete: Boolean(stateSources[index] && sourceHasEvidence(stateSources[index])),
    })),
  ];
  if (states.length === 0) {
    coverage.push({
      tool: 'search_state_bills',
      checked: false,
      complete: false,
    });
  }

  return {
    tool: 'query_bill_watch',
    clientId,
    keyword,
    results: sources.map((source) => ({ tool: source.tool, result: source.result })),
    coverageManifest: {
      requiredDomains: ['legislation'],
      searchedDomains: ['legislation'],
      coverage,
      gaps:
        states.length === 0
          ? ['search_state_bills skipped: no state footprint provided for this client']
          : sources
              .filter((source) => resultHasError(source.result))
              .map((source) => source.tool),
      note:
        states.length === 0
          ? 'State lane skipped — pass states[] to include state legislation for clients with state footprints.'
          : null,
    },
  };
}