/**
 * Phase 4 — Business Development brief observability (telemetry-01).
 *
 * Pure helpers that build a single-line CloudWatch EMF payload for the brief
 * lifecycle operations (create / edit / refresh proposal / refresh accept /
 * citation resolve / claim check). The caller does
 * `this.logger.log(JSON.stringify(payload))` — the same embedded-metric-format
 * shape as `observability/api-latency.middleware.ts` and
 * `meri/meri-context-metrics.helpers.ts`. No second telemetry framework.
 *
 * PRIVACY CONTRACT: the payload carries ONLY low-cardinality
 * operation/outcome/latency/count fields. Never brief text, section titles,
 * prompts, internal notes, provider payloads, contacts, names,
 * tenant/user/prospect/canonical ids, or source passages. The allowed field
 * set is fixed below and asserted by the telemetry spec.
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

const NAMESPACE = 'Capiro/BizDevBrief';

/** The six Phase 4 operations that carry product-level observability. */
export type BizDevBriefOperation =
  | 'brief.create'
  | 'brief.edit'
  | 'brief.refresh_proposal'
  | 'brief.refresh_accept'
  | 'brief.citation_resolve'
  | 'brief.claim_check';

/**
 * Closed outcome vocabulary — fixed, low-cardinality, and safe to use as a
 * CloudWatch dimension. Conflict/not-found outcomes double as the
 * authorization/scope signal: a guessed or cross-tenant id lands here as
 * `not_found` (the same safe 404 as any nonexistent row).
 */
export type BizDevBriefOutcome =
  // create/edit/accept successes and idempotent replays
  | 'created'
  | 'saved'
  | 'accepted'
  | 'replay'
  // refresh proposal
  | 'built'
  // citation resolution (limitations are the fixed resolveCitation enum)
  | 'resolved'
  | 'citation_index_out_of_range'
  | 'brief_not_found'
  | 'source_changed'
  // claim verdicts (semantic BD-CLAIM validation remains DARK — the
  // deterministic checker is the only path)
  | 'supported'
  | 'qualified'
  | 'unsupported'
  // failure/scope classifications (from classifyBriefError)
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'already_exists'
  | 'not_found'
  | 'bad_request'
  | 'conflict'
  | 'error';

export interface BizDevBriefMetric {
  _aws: {
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: string }>;
    }>;
  };
  MetricName: string;
  Value: number;
  Unit: string;
  operation: BizDevBriefOperation;
  outcome: BizDevBriefOutcome;
  latency_ms: number;
  count: number;
  Timestamp: string;
}

/**
 * Build the EMF payload for one brief operation. One metric,
 * `bizdev.brief.latency_ms`, serves both latency (Avg/Max) and count (Sample
 * Count) per operation/outcome dimension pair. `latencyMs` is the wall-clock
 * duration of the operation; for `brief.create` an `ok`-family sample is
 * exactly the time-to-usable-brief (create returns the first saved, usable
 * version). Pure — `at` is passed in so this stays unit-testable.
 */
export function bizdevBriefMetric(
  operation: BizDevBriefOperation,
  outcome: BizDevBriefOutcome,
  latencyMs: number,
  at: string,
): BizDevBriefMetric {
  return {
    _aws: {
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [['operation'], ['operation', 'outcome']],
          Metrics: [{ Name: 'bizdev.brief.latency_ms', Unit: 'Milliseconds' }],
        },
      ],
    },
    MetricName: 'bizdev.brief.latency_ms',
    Value: latencyMs,
    Unit: 'Milliseconds',
    operation,
    outcome,
    latency_ms: latencyMs,
    count: 1,
    Timestamp: at,
  };
}

/** One-line human summary companion to the EMF metric (for log scans). */
export function bizdevBriefMetricSummary(
  operation: BizDevBriefOperation,
  outcome: BizDevBriefOutcome,
  latencyMs: number,
): string {
  return `bizdev.brief operation=${operation} outcome=${outcome} ms=${latencyMs}`;
}

/**
 * Classify a thrown error into the closed outcome vocabulary — WITHOUT ever
 * including the error message or any response payload, which may embed
 * request-derived content. Conflict payloads are discriminated by their
 * stable public `code` only.
 */
export function classifyBriefError(error: unknown): BizDevBriefOutcome {
  if (isHttpError(error)) {
    const code = errorCode(error);
    switch (error.constructor) {
      case ConflictException:
        if (code === 'BIZDEV_BRIEF_VERSION_CONFLICT') return 'version_conflict';
        if (code === 'BIZDEV_BRIEF_IDEMPOTENCY_MISMATCH') return 'idempotency_conflict';
        if (code === 'BIZDEV_BRIEF_ALREADY_EXISTS') return 'already_exists';
        return 'conflict';
      case NotFoundException:
        return 'not_found';
      case BadRequestException:
        return 'bad_request';
    }
  }
  return 'error';
}

function isHttpError(error: unknown): error is object {
  return typeof error === 'object' && error !== null;
}

/** Stable public `code` from a Nest exception's response body, if present. */
function errorCode(error: object): string | null {
  const getResponse = (error as { getResponse?: unknown }).getResponse;
  if (typeof getResponse !== 'function') return null;
  try {
    const body = (getResponse as () => unknown).call(error);
    if (typeof body === 'object' && body !== null) {
      const code = (body as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  } catch {
    return null;
  }
  return null;
}
