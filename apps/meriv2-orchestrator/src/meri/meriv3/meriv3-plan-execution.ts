import {
  validateMeriResearchPlanExecutionEnvelope,
  type MeriResearchPlanExecutionEnvelopeV1,
} from '@capiro/meriv2-core';
import type { MeriContext } from '@capiro/meriv2-core';
import type { MeriV3ChatInput } from './meriv3.types.js';

export class MeriV3ResearchPlanExecutionError extends Error {
  readonly name = 'MeriV3ResearchPlanExecutionError';

  constructor() {
    super('meri_research_plan_execution_envelope_invalid');
  }
}

/**
 * Validates only the authenticated execution projection and its exact turn
 * scope. The controller verifies the governed-context MAC first; this helper
 * never derives authority from model text or recomputes a plan digest.
 */
export function requireMeriV3ResearchPlanExecution(
  dto: MeriV3ChatInput,
  identity: Pick<MeriContext, 'tenantId' | 'userId'>,
): MeriResearchPlanExecutionEnvelopeV1 | null {
  const hasRun = dto.researchRun !== undefined;
  const hasEnvelope = dto.researchPlanExecution !== undefined;
  if (!hasRun && !hasEnvelope) return null;
  if (!hasRun || !hasEnvelope || dto.toolPolicy !== 'read-only') invalid();

  let envelope: MeriResearchPlanExecutionEnvelopeV1;
  try {
    envelope = validateMeriResearchPlanExecutionEnvelope(dto.researchPlanExecution);
  } catch {
    invalid();
  }
  const run = dto.researchRun!;
  const scope = envelope!.scope;
  if (
    scope.sessionId !== run.sessionId ||
    scope.runId !== run.runId ||
    scope.leaseEpoch !== run.leaseEpoch ||
    scope.tenantId !== identity.tenantId ||
    scope.actorId !== identity.userId ||
    scope.clientId !== (dto.clientId ?? null) ||
    scope.conversationId !== (dto.conversationId ?? null)
  )
    invalid();
  return envelope!;
}

export function assertMeriV3ResearchCapability(
  allowed: ReadonlySet<string> | null,
  toolName: string,
): void {
  if (allowed && !allowed.has(toolName)) {
    throw new MeriV3ResearchPlanExecutionError();
  }
}

function invalid(): never {
  throw new MeriV3ResearchPlanExecutionError();
}
