import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  captureBudgetRequired,
  type CaptureProviderSettlement,
} from './meri-capture-provider-budget.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import type { ResearchProviderReservationBinding } from './meri-research-tool-budget.js';
const scope = new AsyncLocalStorage<{
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
}>();
export function captureApiProviderScopeActive(): boolean {
  return !!scope.getStore();
}
export function withCaptureApiProviderScope<T>(
  prisma: PrismaService,
  ctx: TenantContext,
  policy: MeriServerReadonlyCapturePolicy | null,
  fn: () => Promise<T>,
): Promise<T> {
  return policy && captureBudgetRequired(policy) ? scope.run({ prisma, ctx, policy }, fn) : fn();
}
export function assertCaptureApiRetrievalPlan(plan: {
  subjectScope: string;
  requestedDomains: readonly string[];
}): void {
  if (
    scope.getStore() &&
    !(
      plan.subjectScope === 'client' &&
      (['01','14'].includes(scope.getStore()!.policy.caseId ?? '')
        ? plan.requestedDomains.length === 1 &&
          plan.requestedDomains[0] === 'institutional_knowledge'
        : ['20', '72'].includes(scope.getStore()!.policy.caseId ?? '') &&
          plan.requestedDomains.length === 4 &&
          new Set(plan.requestedDomains).size === 4 &&
          plan.requestedDomains.every((domain) =>
            ['clients', 'contacts', 'strategies_work', 'institutional_knowledge'].includes(domain),
          ))
    )
  )
    throw new Error('meri_capture_provider_budget_unqualified_retrieval_plan');
}
export async function reserveCaptureApiProviderAttempt(input: {
  kind: 'bedrock_embeddings' | 'nvidia_rerank';
  provider: string;
  model: string;
  inputBytes: number;
}) {
  const current = scope.getStore();
  if (!current) return null;
  const attemptId = randomUUID();
  const binding: ResearchProviderReservationBinding = {
    ...input,
    logicalOperationId: attemptId,
    attemptId,
    retryOfAttemptId: null,
    phase: 'api_retrieval',
    maxInputTokens: input.inputBytes,
    maxOutputTokens: 0,
  };
  const result = await captureProviderBudgetOwner({
    ...current,
    operation: { kind: 'reserve', binding },
  });
  if (
    !('dispatchAllowed' in result) ||
    result.dispatchAllowed !== true ||
    !('reservationId' in result) ||
    typeof result.reservationId !== 'string'
  )
    throw new Error('meri_capture_provider_budget_api_dispatch_denied');
  return { ...current, binding, reservationId: result.reservationId };
}
export async function settleCaptureApiProviderAttempt(
  reservation: Awaited<ReturnType<typeof reserveCaptureApiProviderAttempt>>,
  outcome: CaptureProviderSettlement['outcome'],
): Promise<void> {
  if (reservation)
    await captureProviderBudgetOwner({
      ...reservation,
      operation: {
        kind: 'settle',
        input: { reservationId: reservation.reservationId, binding: reservation.binding, outcome },
      },
    });
}
