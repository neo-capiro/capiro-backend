import { publicResearchSourceTool } from './meri-report-provenance.js';

const PREPARING_REPORT = 'Reviewing evidence and preparing the report…';
const STARTING_RUNTIME = 'Starting the research runtime…';
const READING_SOURCE = 'Reading an authorized research source…';
const SOURCE_STEP_FINISHED = 'Research source step finished.';
const SOURCE_STEP_NEEDS_ATTENTION = 'Research source step needs attention.';
const READ_ONLY_CONTINUATION = 'Research is continuing in read-only mode.';

const FIXED_PROGRESS_NOTES = new Set([
  PREPARING_REPORT,
  STARTING_RUNTIME,
  READING_SOURCE,
  SOURCE_STEP_FINISHED,
  SOURCE_STEP_NEEDS_ATTENTION,
  READ_ONLY_CONTINUATION,
]);

export const RESEARCH_PROVIDER_FAILURE = 'Research provider failed before report publication.';

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
