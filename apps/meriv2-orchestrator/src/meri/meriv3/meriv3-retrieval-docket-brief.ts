import {
  resultHasError,
  resultRows,
  safeInvoke,
  stringValue,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

/**
 * Deterministic Regulatory Docket Brief fan-out for "where does this
 * rulemaking stand?" — one intent, two tools: federal docket activity, then
 * state register status. Both lanes are exhaustive-capable, so the manifest
 * can claim complete coverage for the named rule/docket.
 */
export async function executeMeriRegulatoryDocketBrief(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const query = stringValue(input.query) ?? null;
  const agencyId = stringValue(input.agencyId) ?? null;
  const state = stringValue(input.state) ?? null;

  const sources: SourceResult[] = [
    {
      tool: 'query_regulatory_dockets',
      result: await safeInvoke(ctx.invoke, 'query_regulatory_dockets', {
        ...(agencyId ? { agencyId } : {}),
        limit: 25,
      }),
    },
  ];
  const docket = sources[0] ?? {
    tool: 'query_regulatory_dockets',
    result: { error: 'docket search did not run' },
  };

  // State lane: keyword needs a rule id, FR number, or title keyword. Skipped
  // lanes are named, never silent.
  let stateRule: SourceResult | null = null;
  if (query) {
    stateRule = {
      tool: 'get_state_rule_status',
      result: await safeInvoke(ctx.invoke, 'get_state_rule_status', {
        query,
        ...(state ? { state } : {}),
      }),
    };
    sources.push(stateRule);
  }

  const docketOk = !resultHasError(docket.result) && resultRows(docket.result).length > 0;
  const stateOk = stateRule
    ? !resultHasError(stateRule.result) && resultRows(stateRule.result).length > 0
    : false;

  return {
    tool: 'query_regulatory_docket_brief',
    query,
    agencyId,
    state,
    results: sources.map((source) => ({ tool: source.tool, result: source.result })),
    coverageManifest: {
      requiredDomains: ['regulatory'],
      optionalDomains: [],
      searchedDomains: [...(docketOk ? ['regulatory'] : [])],
      coverage: [
        { tool: 'query_regulatory_dockets', checked: true, complete: docketOk },
        { tool: 'get_state_rule_status', checked: Boolean(stateRule), complete: stateOk },
      ],
      gaps: [
        ...(docketOk ? [] : ['query_regulatory_dockets']),
        ...(query ? (stateOk ? [] : ['get_state_rule_status']) : ['get_state_rule_status (no rule id/keyword provided — federal docket only)']),
      ],
    },
  };
}