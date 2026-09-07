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
  const initial = record(coverage.initialContext);
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
      ...(coverage.phase === 'turn' ? { phase: 'turn' as const } : {}),
      ...(initial && typeof initial.complete === 'boolean'
        ? { initialContext: meriRetrievalMetadata({ plan, coverage: {
            ...initial, initialContext: undefined, toolReads: undefined,
          } })!.coverage }
        : {}),
      ...(strings(coverage.restoredSources) ? { restoredSources: strings(coverage.restoredSources) } : {}),
      ...(Array.isArray(coverage.toolReads) ? {
        toolReads: coverage.toolReads.flatMap((value): NonNullable<ChatMessageRetrieval['coverage']['toolReads']> => {
          const read = record(value);
          if (!read || typeof read.source !== 'string' || typeof read.tool !== 'string' ||
              !['complete', 'partial', 'error', 'unavailable'].includes(String(read.status))) return [];
          return [{
            source: read.source,
            tool: read.tool,
            status: read.status as 'complete' | 'partial' | 'error' | 'unavailable',
            recordsReturned: count(read.recordsReturned) ?? null,
            recordsEvaluated: count(read.recordsEvaluated) ?? null,
            paginationComplete: typeof read.paginationComplete === 'boolean' ? read.paginationComplete : null,
            truncated: read.truncated === true,
            ...(typeof read.lastSyncAt === 'string' && Number.isFinite(Date.parse(read.lastSyncAt))
              ? { lastSyncAt: read.lastSyncAt } : {}),
            ...(typeof read.detail === 'string' ? { detail: read.detail } : {}),
          }];
        }),
      } : {}),
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
    retrieval_not_requested: 'No initial retrieval was requested',
    source_not_searched: 'This source was not read in the initial context',
    source_disabled: 'This source is not enabled',
    source_read_failed: 'This read did not complete',
    source_stale: 'Source freshness is stale; verify current records before acting',
    source_access_restored_coverage_unproven: 'A later read reached this source; complete coverage of the original request remains unverified',
    turn_coverage_partial: 'Some information remains incomplete; initial context and subsequent reads are shown separately',
  };
  if (descriptions[reason]) return descriptions[reason];
  if (reason.startsWith('subsequent_read:'))
    return `Subsequent read did not complete (${meriCoverageReason(reason.slice('subsequent_read:'.length))})`;
  // Context packets retain diagnostic codes for operators. Product surfaces
  // expose the affected source and implication without internal IDs.
  const diagnostic = reason.match(/^(source_unavailable|source_error|source_not_searched|source_degraded|profile_section):(.+)$/);
  if (diagnostic) {
    const source = meriCoverageSourceLabel(diagnostic[2]!);
    if (diagnostic[1] === 'profile_section') return `Profile section: ${source}`;
    if (diagnostic[1] === 'source_degraded') return `${source} returned partial data during initial context retrieval`;
    return `${source} could not be read during initial context retrieval`;
  }
  if (/^[a-z_]+(?::|$)/.test(reason) && /[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(reason))
    return 'This context item was excluded by scope or review requirements';
  return reason.replace(/[_-]/g, ' ');
}

export function meriCoverageSourceLabel(value: string): string {
  const labels: Record<string, string> = {
    clients: 'Client profile and work', client_documents: 'Client documents',
    institutional_knowledge: 'Institutional Knowledge', submissionHistory: 'Submission history',
    advocacyMatters: 'Advocacy matters', advocacyHistory: 'Advocacy history',
  };
  return labels[value] ?? value.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
