import type { SourceHealth } from './hearing-discovery.types.js';

/** Publisher availability and event qualification answer different questions.
 * An accessible notice with an unknown session must keep its coverage gap, but
 * must not report the publisher as down. Failed fetches/layouts never pass. */
export function floridaSourceOutcome(input: {
  pages: number;
  observations: number;
  issues: readonly string[];
  sourceIssues: readonly string[];
}): { coverage: 'complete' | 'partial' | 'failed'; health: SourceHealth } {
  const available = input.pages > 0 && input.sourceIssues.length === 0;
  return {
    coverage:
      !available || input.issues.length
        ? input.observations > 0
          ? 'partial'
          : 'failed'
        : 'complete',
    health: {
      ok: available,
      observedEvents: input.observations,
      error: available
        ? null
        : (input.sourceIssues.slice(0, 3).join('; ') || 'No Florida source page was read').slice(
            0,
            2000,
          ),
    },
  };
}

export function floridaDiscoveryRunCounts(
  results: ReadonlyArray<{
    inserted: number;
    updated: number;
    unchanged: number;
    issues: readonly string[];
  }>,
  archive: {
    inserted: number;
    updated: number;
    unchanged: number;
    errors: number;
    issues: number;
    ambiguous: readonly string[];
  },
) {
  const sourceErrors = results.reduce((total, result) => total + result.issues.length, 0);
  const errors = sourceErrors + archive.errors + archive.issues + archive.ambiguous.length;
  return {
    inserted: results.reduce((total, result) => total + result.inserted, 0) + archive.inserted,
    updated: results.reduce((total, result) => total + result.updated, 0) + archive.updated,
    skipped: results.reduce((total, result) => total + result.unchanged, 0) + archive.unchanged,
    errors,
    complete: errors === 0,
    ...(errors
      ? {
          incompleteReason: `${sourceErrors} Florida calendar issue(s), ${archive.errors + archive.issues} archive issue(s), and ${archive.ambiguous.length} ambiguous archive match(es)`,
        }
      : {}),
  };
}
