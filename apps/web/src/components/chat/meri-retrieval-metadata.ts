import type { ChatMessageRetrieval } from './chat-store.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** One public coverage contract for streamed and reloaded messages. */
export function meriRetrievalMetadata(value: unknown): ChatMessageRetrieval | undefined {
  const raw = record(value);
  const plan = record(raw?.plan);
  const coverage = record(raw?.coverage);
  if (
    !plan ||
    !coverage ||
    typeof plan.subjectScope !== 'string' ||
    typeof coverage.complete !== 'boolean'
  )
    return undefined;
  const window = record(plan.timeWindow);
  const sourceHealth = Array.isArray(coverage.sourceHealth)
    ? coverage.sourceHealth.flatMap(
        (item): NonNullable<ChatMessageRetrieval['coverage']['sourceHealth']> => {
          const source = record(item);
          if (!source || typeof source.source !== 'string') return [];
          const status = source.status;
          if (
            status !== 'complete' &&
            status !== 'partial' &&
            status !== 'error' &&
            status !== 'unavailable'
          )
            return [];
          return [
            {
              source: source.source,
              status,
              ...(typeof source.lastSyncAt === 'string' &&
              Number.isFinite(Date.parse(source.lastSyncAt))
                ? { lastSyncAt: source.lastSyncAt }
                : {}),
              ...(typeof source.detail === 'string' ? { detail: source.detail } : {}),
            },
          ];
        },
      )
    : undefined;
  return {
    plan: {
      subjectScope: plan.subjectScope,
      targetHint: typeof plan.targetHint === 'string' ? plan.targetHint : null,
      recipeTool: typeof plan.recipeTool === 'string' ? plan.recipeTool : null,
      queryClass: typeof plan.queryClass === 'string' ? plan.queryClass : 'unknown',
      ...(typeof plan.requireCompleteCoverage === 'boolean'
        ? { requireCompleteCoverage: plan.requireCompleteCoverage }
        : {}),
      ...(strings(plan.requiredDomains) ? { requiredDomains: strings(plan.requiredDomains) } : {}),
      ...(plan.timeWindow === null
        ? { timeWindow: null }
        : window && typeof window.expression === 'string' && count(window.withinDays) !== undefined
          ? {
              timeWindow: {
                expression: window.expression,
                withinDays: window.withinDays as number,
              },
            }
          : {}),
    },
    coverage: {
      complete: coverage.complete,
      stopReason: typeof coverage.stopReason === 'string' ? coverage.stopReason : 'unknown',
      ...Object.fromEntries(
        [
          'requestedDomains',
          'searchedDomains',
          'missingDomains',
          'partialDomains',
          'toolsInvoked',
        ].flatMap((key) => (strings(coverage[key]) ? [[key, strings(coverage[key])]] : [])),
      ),
      ...Object.fromEntries(
        [
          'recordsEvaluated',
          'recordsReturned',
          'requestedEntityCount',
          'searchedEntityCount',
        ].flatMap((key) =>
          count(coverage[key]) !== undefined
            ? [[key, coverage[key]]]
            : coverage[key] === null && key.endsWith('EntityCount')
              ? [[key, null]]
              : [],
        ),
      ),
      ...(typeof coverage.paginationComplete === 'boolean'
        ? { paginationComplete: coverage.paginationComplete }
        : {}),
      ...(typeof coverage.truncated === 'boolean' ? { truncated: coverage.truncated } : {}),
      ...(sourceHealth ? { sourceHealth } : {}),
      ...(Array.isArray(coverage.unavailableSources)
        ? {
            unavailableSources: coverage.unavailableSources.flatMap((item) => {
              const source = record(item);
              return source &&
                typeof source.source === 'string' &&
                typeof source.reason === 'string'
                ? [{ source: source.source, reason: source.reason }]
                : [];
            }),
          }
        : {}),
    },
  };
}

export function meriCoverageReason(reason: string): string {
  const descriptions: Record<string, string> = {
    complete: 'Requested retrieval completed',
    partial: 'Some requested information was not fully retrieved',
    model_context_projection_truncated: 'Some retrieved content was shortened before the answer',
    truncated: 'Some results were shortened or omitted',
    pagination_incomplete: 'More result pages remain',
    source_unavailable_or_unsupported: 'A requested source could not be read',
    source_degraded: 'A source returned incomplete or degraded data',
    requested_entity_scope_incomplete: 'Some requested clients or entities were not covered',
    coverage_not_proven: 'Complete coverage could not be established',
    no_retrieval_required: 'No retrieval was requested',
    'no-retrieval-required': 'No retrieval was requested',
  };
  return descriptions[reason] ?? reason.replace(/[_-]/g, ' ');
}
