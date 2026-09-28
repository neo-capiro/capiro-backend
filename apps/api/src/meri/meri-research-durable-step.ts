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
  version: 1;
  receiptId: string;
  runId: string;
  leaseEpoch: number;
  sequence: number;
  effectClass: 'safe_read';
  tool: string;
  label: string;
  status: DurableResearchStepStatus;
  summary: string;
  completedAt: string;
}

export interface DurableResearchStepInput {
  receiptId: string;
  tool: string;
  label: string;
  status: DurableResearchStepStatus;
  summary: string;
  completedAt: string;
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
      row.version !== 1 ||
      typeof row.receiptId !== 'string' ||
      typeof row.runId !== 'string' ||
      !nonNegativeInteger(row.leaseEpoch) ||
      !nonNegativeInteger(row.sequence) ||
      row.effectClass !== 'safe_read' ||
      typeof row.tool !== 'string' ||
      typeof row.label !== 'string' ||
      !['complete', 'failed'].includes(String(row.status)) ||
      typeof row.summary !== 'string' ||
      typeof row.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(row.completedAt))
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
