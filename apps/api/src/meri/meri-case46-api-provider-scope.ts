import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedArtifactCapturePolicy } from '@capiro/meriv2-core';
import type { Case46AuthorityDependencies } from './meri-case46-authority.js';
import { case46ProviderBudgetOwner } from './meri-case46-provider-budget-owner.js';
import type { Case46ProviderSettlement } from './meri-case46-provider-budget.js';
const scope = new AsyncLocalStorage<{
  deps: Case46AuthorityDependencies;
  ctx: TenantContext;
  policy: MeriGovernedArtifactCapturePolicy;
}>();
export const case46ApiProviderScopeActive = () => !!scope.getStore();
export function withCase46ApiProviderScope<T>(
  deps: Case46AuthorityDependencies,
  ctx: TenantContext,
  policy: MeriGovernedArtifactCapturePolicy,
  fn: () => Promise<T>,
) {
  return scope.run({ deps, ctx, policy }, fn);
}
export async function reserveCase46ApiProviderAttempt(input: {
  kind: 'bedrock_embeddings' | 'nvidia_rerank';
  provider: string;
  model: string;
  inputBytes: number;
}) {
  const current = scope.getStore();
  if (!current) return null;
  const attemptId = randomUUID();
  const binding = {
    ...input,
    logicalOperationId: attemptId,
    attemptId,
    retryOfAttemptId: null,
    phase: 'api_retrieval',
    maxInputTokens: input.inputBytes,
    maxOutputTokens: 0,
  };
  const result = await case46ProviderBudgetOwner(current.deps, {
    ctx: current.ctx,
    policy: current.policy,
    operation: { kind: 'reserve', binding },
  });
  if (
    !('dispatchAllowed' in result) ||
    result.dispatchAllowed !== true ||
    !('reservationId' in result) ||
    typeof result.reservationId !== 'string'
  )
    throw new Error('meri_case46_api_provider_dispatch_denied');
  return { ...current, binding, reservationId: result.reservationId, case46: true as const };
}
export async function settleCase46ApiProviderAttempt(
  reservation: NonNullable<Awaited<ReturnType<typeof reserveCase46ApiProviderAttempt>>>,
  outcome: Case46ProviderSettlement['outcome'],
) {
  await case46ProviderBudgetOwner(reservation.deps, {
    ctx: reservation.ctx,
    policy: reservation.policy,
    operation: {
      kind: 'settle',
      input: { reservationId: reservation.reservationId, binding: reservation.binding, outcome },
    },
  });
}
