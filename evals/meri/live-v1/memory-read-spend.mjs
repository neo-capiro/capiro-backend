import { sha256Stable } from './lib/stable.mjs';
import {
  claimCaptureSpendReservation,
  assertCaptureSpendReservation,
  settleMemoryReadSpendReservation,
} from './capture-spend-aggregate.mjs';
import { createMemoryReadServerBudgetReader } from './memory-read-budget-authority.mjs';
/** Root first reserves on the sole journal and installs that exact reservation
 * on the empty owned conversation. This adapter never initializes or resets it. */
export function createMemoryReadSpendAdapter({ reservation, plan, bearer, onCheckpoint }) {
  const expected = {
    caseId: plan.caseId,
    captureRunId: plan.captureRunId,
    maxSpendMicros: plan.maxCostMicros,
    conversationId: plan.conversationId,
    actorUserId: plan.actorUserId,
    clientId: plan.clientId,
    promptSha256: plan.promptSha256,
  };
  const read = createMemoryReadServerBudgetReader({ plan, reservation, bearer });
  let submitted = false,
    finished = false;
  return Object.freeze({
    async beforeSubmit(binding) {
      if (
        submitted ||
        finished ||
        binding.caseId !== plan.caseId ||
        binding.captureRunId !== plan.captureRunId ||
        binding.conversationId !== plan.conversationId ||
        binding.maxCostMicros !== plan.maxCostMicros
      )
        throw new Error('MEMORY_READ_RESERVATION_REBOUND');
      claimCaptureSpendReservation(reservation, expected);
      await read.before();
      assertCaptureSpendReservation(reservation, expected);
      submitted = true;
      return reservation;
    },
    async afterAttempt(value, observation) {
      if (value !== reservation || !submitted || finished)
        throw new Error('MEMORY_READ_RESERVATION_REUSED');
      finished = true;
      // Local observations never settle price. Even a failed HTTP observation can
      // settle only if current server state independently proves a complete turn.
      const authority = await read.terminal();
      assertCaptureSpendReservation(reservation, expected);
      const checkpoint = settleMemoryReadSpendReservation(reservation, authority);
      if (typeof onCheckpoint === 'function')
        await onCheckpoint(checkpoint, { observationSha256: sha256Stable(observation) });
      return checkpoint;
    },
  });
}
