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
