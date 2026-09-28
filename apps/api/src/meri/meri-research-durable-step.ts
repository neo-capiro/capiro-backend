import {
  readResearchRun,
  researchMetadata,
  type ResearchRunState,
} from './meri-research-run-state.js';

const MAX_DURABLE_STEP_RECEIPTS = 100;
const MAX_RECEIPT_TEXT = 500;

export type DurableResearchStepStatus = 'complete' | 'failed';

/** Public operational receipt only; tool inputs/results and provider reasoning stay outside metadata. */
export interface DurableResearchStepReceipt {
  version: 1 | 2;
  receiptId: string;
  runId: string;
  leaseEpoch: number;
  sequence: number;
  effectClass: 'safe_read';
  /** Stable provider/tool-dispatch identity. Legacy version-1 rows may omit it. */
  toolCallId?: string;
  tool: string;
  label: string;
  status: DurableResearchStepStatus;
  summary: string;
  completedAt: string;
  /** Version 2 is the first replay-authoritative receipt. Version 1 remains progress-only. */
  executionId?: string;
  providerCallId?: string;
  toolVersion?: string;
  inputSha256?: string;
  resultSha256?: string;
  resultBodySha256?: string;
  resultRef?: string;
  resultByteSize?: number;
  classifier?: 'complete' | 'empty';
}

export interface DurableResearchStepInput {
  receiptId: string;
  /** Required for new qualified writes; optional only for call-site compatibility. */
  toolCallId?: string;
  tool: string;
  label: string;
  status: DurableResearchStepStatus;
  summary: string;
  completedAt: string;
}

export interface DurableResearchResultReceiptInput extends DurableResearchStepInput {
  executionId: string;
  providerCallId: string;
  toolVersion: string;
  inputSha256: string;
  resultSha256: string;
  resultBodySha256: string;
  resultRef: string;
  resultByteSize: number;
  classifier: 'complete' | 'empty';
}

function boundedText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_RECEIPT_TEXT) : '';
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function readDurableResearchStepReceipts(value: unknown): DurableResearchStepReceipt[] {
  const rows = researchMetadata(value).durableStepReceipts;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value) => {
    const row = researchMetadata(value);
    if (
      ![1, 2].includes(Number(row.version)) ||
      typeof row.receiptId !== 'string' ||
      typeof row.runId !== 'string' ||
      !nonNegativeInteger(row.leaseEpoch) ||
      !nonNegativeInteger(row.sequence) ||
      row.effectClass !== 'safe_read' ||
      (row.toolCallId !== undefined && typeof row.toolCallId !== 'string') ||
      typeof row.tool !== 'string' ||
      typeof row.label !== 'string' ||
      !['complete', 'failed'].includes(String(row.status)) ||
      typeof row.summary !== 'string' ||
      typeof row.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(row.completedAt)) ||
      (row.version === 2 &&
        (typeof row.executionId !== 'string' ||
          typeof row.providerCallId !== 'string' ||
          typeof row.toolVersion !== 'string' ||
          typeof row.inputSha256 !== 'string' ||
          typeof row.resultSha256 !== 'string' ||
          typeof row.resultBodySha256 !== 'string' ||
          typeof row.resultRef !== 'string' ||
          !nonNegativeInteger(row.resultByteSize) ||
          !['complete', 'empty'].includes(String(row.classifier))))
    )
      return [];
    return [row as unknown as DurableResearchStepReceipt];
  });
}

/**
 * Append one fenced safe-read receipt and advance the run event cursor. The caller
 * commits the returned metadata with the same run-id/lease-epoch transaction.
 */
export function appendDurableResearchStepReceipt(
  value: unknown,
  expectedRun: Pick<ResearchRunState, 'id' | 'leaseEpoch'>,
  input: DurableResearchStepInput,
): {
  metadata: Record<string, unknown>;
  run: ResearchRunState;
  receipt: DurableResearchStepReceipt;
} {
  const metadata = researchMetadata(value);
  const run = readResearchRun(metadata);
  if (
    !run ||
    run.status !== 'running' ||
    run.id !== expectedRun.id ||
    run.leaseEpoch !== expectedRun.leaseEpoch
  )
    throw new Error('Research lease is no longer active.');

  const retained = readDurableResearchStepReceipts(metadata);
  const sequence = Math.max(
    run.eventSequence,
    ...retained.map((receipt) => receipt.sequence),
  ) + 1;
  const receipt: DurableResearchStepReceipt = {
    version: 1,
    receiptId: input.receiptId,
    runId: run.id,
    leaseEpoch: run.leaseEpoch,
    sequence,
    effectClass: 'safe_read',
    ...(boundedText(input.toolCallId) ? { toolCallId: boundedText(input.toolCallId) } : {}),
    tool: boundedText(input.tool),
    label: boundedText(input.label),
    status: input.status,
    summary: boundedText(input.summary),
    completedAt: input.completedAt,
  };
  if (!receipt.receiptId || !receipt.tool || !receipt.label)
    throw new Error('A durable research receipt requires an identity, tool, and label.');

  const nextRun = { ...run, eventSequence: sequence };
  return {
    metadata: {
      ...metadata,
      run: nextRun,
      durableStepReceipts: [...retained, receipt].slice(-MAX_DURABLE_STEP_RECEIPTS),
    },
    run: nextRun,
    receipt,
  };
}

/** Append a result receipt in the same transaction as its private result artifact. */
export function appendDurableResearchResultReceipt(
  value: unknown,
  expectedRun: Pick<ResearchRunState, 'id' | 'leaseEpoch'>,
  input: DurableResearchResultReceiptInput,
): {
  metadata: Record<string, unknown>;
  run: ResearchRunState;
  receipt: DurableResearchStepReceipt;
} {
  const appended = appendDurableResearchStepReceipt(value, expectedRun, input);
  const required = [
    input.executionId,
    input.providerCallId,
    input.toolVersion,
    input.inputSha256,
    input.resultSha256,
    input.resultBodySha256,
    input.resultRef,
  ];
  if (
    required.some((field) => !boundedText(field)) ||
    !Number.isSafeInteger(input.resultByteSize) ||
    input.resultByteSize < 0
  ) {
    throw new Error('A durable research result receipt requires complete replay identity.');
  }
  const receipt: DurableResearchStepReceipt = {
    ...appended.receipt,
    version: 2,
    executionId: boundedText(input.executionId),
    providerCallId: boundedText(input.providerCallId),
    toolVersion: boundedText(input.toolVersion),
    inputSha256: boundedText(input.inputSha256),
    resultSha256: boundedText(input.resultSha256),
    resultBodySha256: boundedText(input.resultBodySha256),
    resultRef: boundedText(input.resultRef),
    resultByteSize: input.resultByteSize,
    classifier: input.classifier,
  };
  const retained = readDurableResearchStepReceipts(appended.metadata);
  return {
    metadata: {
      ...appended.metadata,
      durableStepReceipts: [...retained.slice(0, -1), receipt].slice(-MAX_DURABLE_STEP_RECEIPTS),
    },
    run: appended.run,
    receipt,
  };
}
