import { publicResearchSourceTool } from './meri-report-provenance.js';

const PREPARING_REPORT = 'Reviewing evidence and preparing the report…';
const STARTING_RUNTIME = 'Starting the research runtime…';
const READING_SOURCE = 'Reading an authorized research source…';
const SOURCE_STEP_FINISHED = 'Research source step finished.';
const SOURCE_STEP_NEEDS_ATTENTION = 'Research source step needs attention.';
const READ_ONLY_CONTINUATION = 'Research is continuing in read-only mode.';

export const RESEARCH_OBSERVER_STATUS = {
  startingRun: 'Starting the research run…',
  planning: 'Planning the research…',
  reviewingPlan: 'Reviewing the research plan…',
  gatheringEvidence: 'Gathering evidence…',
  gatheringThinking: 'Reviewing evidence and planning the next research step…',
  reviewingEvidence: 'Reviewing the retrieved evidence for the report…',
  writingReport: 'Writing the report…',
  checkingReport: 'Checking the report against the gathered sources…',
  savingReport: 'Saving the report…',
  preparingReport: PREPARING_REPORT,
  startingRuntime: STARTING_RUNTIME,
  readingSource: READING_SOURCE,
  sourceFinished: SOURCE_STEP_FINISHED,
  sourceNeedsAttention: SOURCE_STEP_NEEDS_ATTENTION,
  readOnlyContinuation: READ_ONLY_CONTINUATION,
} as const;

const FIXED_PROGRESS_NOTES = new Set([
  PREPARING_REPORT,
  STARTING_RUNTIME,
  READING_SOURCE,
  SOURCE_STEP_FINISHED,
  SOURCE_STEP_NEEDS_ATTENTION,
  READ_ONLY_CONTINUATION,
  ...Object.values(RESEARCH_OBSERVER_STATUS),
]);

export const RESEARCH_PROVIDER_FAILURE = 'Research provider failed before report publication.';
export const RESEARCH_RUN_FAILURE = 'Research failed before report publication.';
export const RESEARCH_CANCELLED = 'Research was cancelled.';
export const RESEARCH_PARTIAL =
  'Research did not complete; partial provider output has not been released as a report.';
export const RESEARCH_LEASE_FAILURE = 'Research lease is no longer active.';

/** Rebuild a terminal observer error from a finite, source-independent vocabulary. */
export function projectResearchObserverError(error: unknown, signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'ResearchLeaseError')
    return RESEARCH_LEASE_FAILURE;
  if (signal?.aborted) return RESEARCH_CANCELLED;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message === RESEARCH_PROVIDER_FAILURE) return RESEARCH_PROVIDER_FAILURE;
  if (/cancelled/i.test(message)) return RESEARCH_CANCELLED;
  if (/partial|max_output_tokens|did not complete|without a completed/i.test(message))
    return RESEARCH_PARTIAL;
  if (/lease|no longer owns the run/i.test(message)) return RESEARCH_LEASE_FAILURE;
  return RESEARCH_RUN_FAILURE;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function optionalString(target: Record<string, unknown>, key: string, value: unknown) {
  if (nonEmptyString(value)) target[key] = value;
}

function optionalNonNegativeInteger(target: Record<string, unknown>, key: string, value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) target[key] = value;
}

/**
 * Select the private control fields needed by the existing receipt barrier. The
 * input/result pair is consumed by that barrier and replaced before observer I/O;
 * it is never a public projection.
 */
function projectReceiptCandidate(event: Record<string, unknown>): Record<string, unknown> | null {
  const source = record(event.source);
  const receipt = record(event.durableSafeRead);
  if (!source || !receipt || receipt.outcome !== 'complete' || source.confidence !== 'high')
    return null;

  const tool = publicResearchSourceTool(receipt.tool);
  if (!tool || source.tool !== tool || !nonEmptyString(receipt.toolCallId)) return null;

  const durableSafeRead: Record<string, unknown> = {
    outcome: 'complete',
    tool,
    toolCallId: receipt.toolCallId,
  };
  optionalString(durableSafeRead, 'executionId', receipt.executionId);
  optionalString(durableSafeRead, 'providerCallId', receipt.providerCallId);
  optionalString(durableSafeRead, 'toolVersion', receipt.toolVersion);
  optionalString(durableSafeRead, 'receiptId', receipt.receiptId);
  optionalString(durableSafeRead, 'runId', receipt.runId);
  optionalString(durableSafeRead, 'completedAt', receipt.completedAt);
  optionalNonNegativeInteger(durableSafeRead, 'version', receipt.version);
  optionalNonNegativeInteger(durableSafeRead, 'leaseEpoch', receipt.leaseEpoch);
  optionalNonNegativeInteger(durableSafeRead, 'sequence', receipt.sequence);
  optionalNonNegativeInteger(durableSafeRead, 'resultByteSize', receipt.resultByteSize);
  if (receipt.persisted === true) durableSafeRead.persisted = true;
  if (receipt.replayed === true || receipt.replayed === false)
    durableSafeRead.replayed = receipt.replayed;
  if (receipt.effectClass === 'safe_read') durableSafeRead.effectClass = 'safe_read';
  if (receipt.status === 'complete' || receipt.status === 'failed')
    durableSafeRead.status = receipt.status;
  if (receipt.classifier === 'complete' || receipt.classifier === 'empty')
    durableSafeRead.classifier = receipt.classifier;

  if (receipt.persisted !== true) {
    const input = record(receipt.input);
    if (!input || !('result' in receipt)) return null;
    durableSafeRead.input = input;
    durableSafeRead.result = receipt.result;
  }

  return {
    type: 'source',
    source: {
      tool,
      label: 'Research source',
      summary: 'Authorized read completed',
      confidence: 'high',
    },
    durableSafeRead,
  };
}

/**
 * Research-only observer contract. Every returned event is newly constructed;
 * provider objects, labels, prose, metadata and unknown keys are never forwarded.
 */
export function projectResearchObserverEvent(
  value: unknown,
  options: { receiptCandidates?: boolean } = {},
): Record<string, unknown> | null {
  const event = record(value);
  if (!event || typeof event.type !== 'string') return null;

  switch (event.type) {
    case 'thinking':
    case 'reasoning':
    case 'reasoning_delta':
    case 'reasoning_summary':
      return { type: 'progress', note: PREPARING_REPORT };
    case 'start':
    case 'runtime':
      return { type: 'progress', note: STARTING_RUNTIME };
    case 'progress':
      return {
        type: 'progress',
        note:
          typeof event.note === 'string' && FIXED_PROGRESS_NOTES.has(event.note)
            ? event.note
            : PREPARING_REPORT,
      };
    case 'tool_call': {
      const tool = publicResearchSourceTool(event.tool);
      return tool
        ? { type: 'step', tool, label: 'Research source' }
        : { type: 'progress', note: READING_SOURCE };
    }
    case 'tool_done':
      if (event.status === 'done') return { type: 'progress', note: SOURCE_STEP_FINISHED };
      if (event.status === 'error') return { type: 'progress', note: SOURCE_STEP_NEEDS_ATTENTION };
      return { type: 'progress', note: READ_ONLY_CONTINUATION };
    case 'pending_approval':
      return { type: 'progress', note: READ_ONLY_CONTINUATION };
    case 'source':
      return options.receiptCandidates ? projectReceiptCandidate(event) : null;
    default:
      // text/done remain internal until canonical report publication. Content-bearing
      // artifact/page/caveat frames, provider errors and unknown events are withheld.
      return null;
  }
}
