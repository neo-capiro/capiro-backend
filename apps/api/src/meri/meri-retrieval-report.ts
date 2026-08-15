export interface MeriRetrievalReportRow {
  createdAt: Date | string;
  metadata: unknown;
}

export interface MeriRetrievalFrequency {
  key: string;
  count: number;
}

export interface MeriRetrievalRecipeMetric {
  recipe: string;
  turns: number;
  completeTurns: number;
  completeRate: number | null;
}

export interface MeriRetrievalScopeMetric {
  subjectScope: string;
  turns: number;
}

export interface MeriRetrievalProductionReport {
  version: 1;
  messagesScanned: number;
  retrievalTurns: number;
  coverageCompleteTurns: number;
  coverageCompleteRate: number | null;
  recipeFirstEligibleTurns: number;
  recipeFirstTurns: number;
  recipeFirstRate: number | null;
  durationMs: {
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  averageCumulativeToolMs: number | null;
  tokens: {
    input: number;
    output: number;
  };
  byRecipe: MeriRetrievalRecipeMetric[];
  bySubjectScope: MeriRetrievalScopeMetric[];
  missingDomains: MeriRetrievalFrequency[];
  partialDomains: MeriRetrievalFrequency[];
  paginationDebt: MeriRetrievalFrequency[];
  outOfPlanModelTools: MeriRetrievalFrequency[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function increment(map: Map<string, number>, value: string): void {
  map.set(value, (map.get(value) ?? 0) + 1);
}

function frequency(map: Map<string, number>): MeriRetrievalFrequency[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function roundedRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

/**
 * Aggregate persisted MeriV3 retrieval metadata without inspecting message
 * bodies, client names, entity names, or tool arguments. This is deliberately
 * an operational quality report rather than a second retrieval datastore.
 */
export function buildMeriRetrievalProductionReport(
  rows: readonly MeriRetrievalReportRow[],
): MeriRetrievalProductionReport {
  let retrievalTurns = 0;
  let completeTurns = 0;
  let recipeFirstEligibleTurns = 0;
  let recipeFirstTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const durations: number[] = [];
  const cumulativeToolTimes: number[] = [];
  const recipeTurns = new Map<string, number>();
  const recipeCompleteTurns = new Map<string, number>();
  const subjectScopes = new Map<string, number>();
  const missingDomains = new Map<string, number>();
  const partialDomains = new Map<string, number>();
  const paginationDebt = new Map<string, number>();
  const outOfPlanModelTools = new Map<string, number>();

  for (const row of rows) {
    if (!isRecord(row.metadata)) continue;
    const retrieval = isRecord(row.metadata.retrieval) ? row.metadata.retrieval : null;
    if (!retrieval) continue;
    const plan = isRecord(retrieval.plan) ? retrieval.plan : null;
    const coverage = isRecord(retrieval.coverage) ? retrieval.coverage : null;
    const trace = isRecord(retrieval.trace) ? retrieval.trace : null;
    retrievalTurns += 1;

    const complete = coverage?.complete === true;
    if (complete) completeTurns += 1;

    const recipe =
      typeof plan?.recipeTool === 'string' && plan.recipeTool.trim()
        ? plan.recipeTool.trim()
        : 'none';
    increment(recipeTurns, recipe);
    if (complete) increment(recipeCompleteTurns, recipe);

    const subjectScope =
      typeof plan?.subjectScope === 'string' && plan.subjectScope.trim()
        ? plan.subjectScope.trim()
        : 'unknown';
    increment(subjectScopes, subjectScope);

    for (const domain of strings(coverage?.missingDomains)) increment(missingDomains, domain);
    for (const domain of strings(coverage?.partialDomains)) increment(partialDomains, domain);
    for (const tool of strings(trace?.paginationDebt)) increment(paginationDebt, tool);
    for (const tool of strings(trace?.outOfPlanModelTools)) increment(outOfPlanModelTools, tool);

    if (trace?.recipeFirst === true || trace?.recipeFirst === false) {
      recipeFirstEligibleTurns += 1;
      if (trace.recipeFirst === true) recipeFirstTurns += 1;
    }
    const duration = finiteNumber(trace?.durationMs);
    if (duration !== null && duration >= 0) durations.push(duration);
    const cumulativeToolMs = finiteNumber(trace?.cumulativeToolMs);
    if (cumulativeToolMs !== null && cumulativeToolMs >= 0) {
      cumulativeToolTimes.push(cumulativeToolMs);
    }

    const usage = isRecord(row.metadata.usage) ? row.metadata.usage : null;
    inputTokens += Math.max(0, finiteNumber(usage?.inputTokens) ?? 0);
    outputTokens += Math.max(0, finiteNumber(usage?.outputTokens) ?? 0);
  }

  const byRecipe = [...recipeTurns.entries()]
    .map(([recipe, turns]) => {
      const completeForRecipe = recipeCompleteTurns.get(recipe) ?? 0;
      return {
        recipe,
        turns,
        completeTurns: completeForRecipe,
        completeRate: roundedRate(completeForRecipe, turns),
      };
    })
    .sort((left, right) => right.turns - left.turns || left.recipe.localeCompare(right.recipe));

  const bySubjectScope = [...subjectScopes.entries()]
    .map(([subjectScope, turns]) => ({ subjectScope, turns }))
    .sort((left, right) => right.turns - left.turns || left.subjectScope.localeCompare(right.subjectScope));

  const cumulativeToolTotal = cumulativeToolTimes.reduce((sum, value) => sum + value, 0);
  return {
    version: 1,
    messagesScanned: rows.length,
    retrievalTurns,
    coverageCompleteTurns: completeTurns,
    coverageCompleteRate: roundedRate(completeTurns, retrievalTurns),
    recipeFirstEligibleTurns,
    recipeFirstTurns,
    recipeFirstRate: roundedRate(recipeFirstTurns, recipeFirstEligibleTurns),
    durationMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : null,
    },
    averageCumulativeToolMs: cumulativeToolTimes.length
      ? Math.round(cumulativeToolTotal / cumulativeToolTimes.length)
      : null,
    tokens: { input: inputTokens, output: outputTokens },
    byRecipe,
    bySubjectScope,
    missingDomains: frequency(missingDomains),
    partialDomains: frequency(partialDomains),
    paginationDebt: frequency(paginationDebt),
    outOfPlanModelTools: frequency(outOfPlanModelTools),
  };
}
