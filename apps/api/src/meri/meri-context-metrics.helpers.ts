/**
 * Phase 7A — recall-miss observability (master plan gap #8). The bulk context
 * assembler swallows a recall FAILURE in a bare catch and answers with no
 * memory and no signal. These pure helpers build CloudWatch EMF metric payloads
 * (same embedded-metric-format shape as observability/api-latency.middleware.ts)
 * so hit / empty / error are all countable — the silent fail-open case
 * (memory.error) becomes an alarmable metric instead of an invisible degradation.
 *
 * Pure (returns the log payload); the caller does this.logger.log(JSON.stringify).
 */

const NAMESPACE = 'Capiro/MeriContext';

/** Recall outcome at the memory boundary. 'error' is the previously-silent
 *  fail-open case (recall threw ⇒ Meri answered with no memory). */
export type RecallOutcome = 'hit' | 'empty' | 'error';

export interface RecallMetric {
  _aws: { CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string; Unit: string }> }> };
  MetricName: string;
  Value: number;
  Unit: string;
  outcome: RecallOutcome;
  recallSource: string;
  count: number;
  Timestamp: string;
}

/**
 * Build the EMF payload for a memory-recall outcome. `count` is the number of
 * memories returned (0 for empty/error). `at` is the ISO timestamp (passed in
 * so this stays pure/testable).
 */
export function recallOutcomeMetric(
  outcome: RecallOutcome,
  recallSource: string,
  count: number,
  at: string,
): RecallMetric {
  return {
    _aws: {
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [['outcome'], ['outcome', 'recallSource']],
          Metrics: [
            { Name: 'memory.recall', Unit: 'Count' },
            { Name: 'memory.recall_count', Unit: 'Count' },
          ],
        },
      ],
    },
    MetricName: 'memory.recall',
    Value: 1,
    Unit: 'Count',
    outcome,
    recallSource,
    count,
    Timestamp: at,
  };
}

/** One-line human summary companion to the EMF metric (for log scans). */
export function recallOutcomeSummary(outcome: RecallOutcome, recallSource: string, count: number): string {
  return `meri.memory_recall outcome=${outcome} source=${recallSource} count=${count}`;
}
