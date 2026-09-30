import type { MeriTelemetryEventInput } from '@capiro/meriv2-core';
import type { ResearchRunState } from './meri-research-run-state.js';
import type { DurableResearchStepReceipt } from './meri-research-durable-step.js';
import type { ResearchProviderBudgetV1 } from './meri-research-tool-budget.js';

/** Call only after the existing owner has admitted this persisted run. */
export function admittedResearchTelemetry(
  sessionId: string,
  run: Pick<ResearchRunState, 'id' | 'leaseEpoch' | 'eventSequence'>,
  conversationId?: string | null,
  goalRevision?: number,
): Partial<MeriTelemetryEventInput> {
  return {
    researchSessionId: sessionId,
    durableRunId: run.id,
    leaseEpoch: run.leaseEpoch,
    checkpointSequence: run.eventSequence,
    ...(conversationId ? { authorizedConversationId: conversationId } : {}),
    ...(goalRevision !== undefined ? { goalRevision } : {}),
  };
}

/** Limits and charges are from the successful persisted budget result, not request estimates. */
export function remainingResearchTelemetryBudget(
  budget: ResearchProviderBudgetV1,
  now = Date.now(),
): MeriTelemetryEventInput['remainingBudget'] {
  return {
    attempts: Math.max(0, budget.limits.maxAttempts - budget.chargedAttempts),
    tokens: Math.max(0, budget.limits.maxTokens - budget.chargedTokens),
    costMicros: Math.max(0, budget.limits.maxCostMicros - budget.chargedCostMicros),
    timeMs: Math.max(0, Date.parse(budget.limits.deadlineAt) - now),
  };
}

/** Publish only after receipt publication authorization. No label, summary, input, or result bytes. */
export function admittedResearchReceiptTelemetry(
  sessionId: string,
  receipt: DurableResearchStepReceipt,
): Partial<MeriTelemetryEventInput> {
  return {
    researchSessionId: sessionId,
    durableRunId: receipt.runId,
    leaseEpoch: receipt.leaseEpoch,
    checkpointSequence: receipt.sequence,
    stepId: receipt.receiptId,
    operationId: receipt.executionId,
    invokedTools: [receipt.tool],
    toolVersion: receipt.toolVersion,
    // A completed saved result is not proof that the upstream source was fully
    // enumerated. This receipt does not retain an authoritative coverage claim.
    sourceCoverage: 'unknown',
    // This is the saved result reference/hash, not an invented upstream source
    // version. The receipt has no independent upstream version to export.
    ...(receipt.resultRef
      ? {
          sourceRefs: [
            { sourceId: receipt.resultRef, hash: receipt.resultSha256, tool: receipt.tool },
          ],
        }
      : {}),
  };
}
