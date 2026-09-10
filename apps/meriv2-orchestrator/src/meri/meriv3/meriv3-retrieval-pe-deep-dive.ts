import {
  isRecord,
  resultHasError,
  resultRows,
  safeInvoke,
  stringValue,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

const PE_READERS = [
  'get_pe_budget_timeline',
  'get_pe_report_language',
  'get_pe_contractors',
  'get_pe_bills',
] as const;

function peCodeFrom(input: Record<string, unknown>, ctx: MeriRetrievalRecipeContext): string | null {
  const explicit = stringValue(input.peCode) ?? stringValue(input.pe);
  if (explicit) return explicit.trim().toUpperCase();
  const hint = ctx.plan.targetHint;
  if (hint && /^[0-9A-Z]{6,}$/i.test(hint.trim())) return hint.trim().toUpperCase();
  return null;
}

function sourceHasEvidence(source: SourceResult): boolean {
  return !resultHasError(source.result) && resultRows(source.result).length > 0;
}

/**
 * Deterministic Program Element deep-dive fan-out for "brief me on PE X"
 * requests. Resolves the PE (explicit code, or one search hop when the user
 * did not supply a number), then runs all four readers plus the PE definition
 * and emits a coverage manifest — every required domain checked or named.
 */
export async function executeMeriPeDeepDive(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const peCode = peCodeFrom(input, ctx);
  const sources: SourceResult[] = [];
  let resolvedPeCode = peCode;
  let searchNote: string | null = null;

  if (!resolvedPeCode) {
    const query = stringValue(input.query) ?? 'program element';
    const search: SourceResult = {
      tool: 'search_program_elements',
      result: await ctx.invoke('search_program_elements', { query, limit: 5 }),
    };
    sources.push(search);
    if (resultHasError(search.result)) {
      return {
        error: `could not resolve Program Element: no PE code provided and search failed (${String(
          (isRecord(search.result) ? search.result.error : null) ?? 'unknown error',
        )})`,
        results: sources.map((source) => ({ tool: source.tool, result: source.result })),
      };
    }
    const rows = resultRows(search.result).filter(isRecord);
    const code =
      stringValue(rows[0]?.peCode) ??
      stringValue(rows[0]?.pe_number) ??
      stringValue(rows[0]?.code);
    if (!code) {
      return {
        error: 'could not resolve Program Element: no PE code provided and search returned no match',
        results: sources.map((source) => ({ tool: source.tool, result: source.result })),
      };
    }
    resolvedPeCode = code.toUpperCase();
    searchNote =
      'PE code resolved via search_program_elements (top hit); confirm the match before relying on the brief.';
  }

  const definition: SourceResult = {
    tool: 'get_program_element',
    result: await ctx.invoke('get_program_element', { peCode: resolvedPeCode }),
  };
  sources.push(definition);

  const readerResults = await Promise.all(
    PE_READERS.map(async (tool): Promise<SourceResult> => ({
      tool,
      result: await ctx.invoke(tool, { peCode: resolvedPeCode }),
    })),
  );
  sources.push(...readerResults);

  const coverage = sources.map((source) => ({
    tool: source.tool,
    checked: true,
    complete: sourceHasEvidence(source),
  }));
  const failed = coverage.filter((entry) => !entry.complete).map((entry) => entry.tool);

  return {
    peCode: resolvedPeCode,
    results: sources.map((source) => ({ tool: source.tool, result: source.result })),
    coverageManifest: {
      requiredDomains: ['budget'],
      optionalDomains: ['awards', 'legislation'],
      searchedDomains: ['budget'],
      coverage,
      gaps: failed.length > 0 ? failed : [],
      note:
        searchNote ??
        (failed.length > 0
          ? `Reader(s) returned no rows for ${resolvedPeCode}: ${failed.join(', ')}. Named above; not silently omitted.`
          : null),
    },
  };
}