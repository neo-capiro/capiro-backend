const MAX_PRIMARY_RESULTS = 30;
const MAX_CARRYOVER_RESULTS = 10;
const MAX_COMPANY_RESULTS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactCompanyResearch(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { coverage, results, ...rest } = value;
  return {
    ...(coverage !== undefined ? { coverage } : {}),
    ...rest,
    ...(Array.isArray(results) ? { results: results.slice(0, MAX_COMPANY_RESULTS) } : {}),
  };
}

/**
 * The Responses runtime bounds each tool result before returning it to the
 * model. Coverage must therefore appear before evidence arrays, otherwise a
 * large result could hide the very metadata that prevents false exhaustive
 * claims. This helper also caps evidence at a useful reasoning size while the
 * underlying governed calls retain their complete audit traces.
 */
export function compactMeriRetrievalRecipeResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const {
    coverage,
    results,
    carryoverAttention,
    companyResearch,
    ...rest
  } = value;
  return {
    ...(coverage !== undefined ? { coverage } : {}),
    ...rest,
    ...(companyResearch !== undefined
      ? { companyResearch: compactCompanyResearch(companyResearch) }
      : {}),
    ...(Array.isArray(results) ? { results: results.slice(0, MAX_PRIMARY_RESULTS) } : {}),
    ...(Array.isArray(carryoverAttention)
      ? { carryoverAttention: carryoverAttention.slice(0, MAX_CARRYOVER_RESULTS) }
      : {}),
  };
}
