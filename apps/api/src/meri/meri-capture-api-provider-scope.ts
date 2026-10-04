import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { case12SetupProviderScopeActive } from './meri-case12-setup-provider-scope.js';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  captureBudgetRequired,
  type CaptureProviderSettlement,
} from './meri-capture-provider-budget.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import { syntheticReadBudgetOwner } from './meri-synthetic-read-budget-owner.js';
import type { ResearchProviderReservationBinding } from './meri-research-tool-budget.js';
import {
  case46ApiProviderScopeActive,
  reserveCase46ApiProviderAttempt,
  settleCase46ApiProviderAttempt,
} from './meri-case46-api-provider-scope.js';
const scope = new AsyncLocalStorage<{
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
}>();
export function captureApiProviderScopeActive(): boolean {
  return !!scope.getStore() || case46ApiProviderScopeActive();
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
      (scope.getStore()!.policy.syntheticReadBudget
        ? plan.requestedDomains.length > 0 &&
          new Set(plan.requestedDomains).size === plan.requestedDomains.length &&
          plan.requestedDomains.every((domain) =>
            ['clients', 'contacts', 'strategies_work', 'institutional_knowledge'].includes(domain),
          )
        : ['01', '12', '14'].includes(scope.getStore()!.policy.caseId ?? '')
          ? plan.requestedDomains.length === 1 &&
            plan.requestedDomains[0] === 'institutional_knowledge'
          : ['20', '72'].includes(scope.getStore()!.policy.caseId ?? '') &&
            plan.requestedDomains.length === 4 &&
            new Set(plan.requestedDomains).size === 4 &&
            plan.requestedDomains.every((domain) =>
              ['clients', 'contacts', 'strategies_work', 'institutional_knowledge'].includes(
                domain,
              ),
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
  if (case12SetupProviderScopeActive())
    throw new Error('meri_case12_setup_provider_capture_overlap');
  const current = scope.getStore();
  if (!current) return reserveCase46ApiProviderAttempt(input);
  if (case46ApiProviderScopeActive()) throw new Error('meri_capture_provider_scope_ambiguous');
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
  const result = await (
    current.policy.syntheticReadBudget ? syntheticReadBudgetOwner : captureProviderBudgetOwner
  )({
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
  if (reservation && 'case46' in reservation) {
    await settleCase46ApiProviderAttempt(reservation, outcome);
    return;
  }
  if (reservation)
    await (
      reservation.policy.syntheticReadBudget ? syntheticReadBudgetOwner : captureProviderBudgetOwner
    )({
      ...reservation,
      operation: {
        kind: 'settle',
        input: { reservationId: reservation.reservationId, binding: reservation.binding, outcome },
      },
    });
}
