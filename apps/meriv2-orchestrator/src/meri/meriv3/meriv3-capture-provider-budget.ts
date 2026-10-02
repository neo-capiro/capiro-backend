import {
  encodeMeriCapturePolicyTransport,
  MERI_CAPTURE_POLICY_HEADER,
  type MeriServerReadonlyCapturePolicy,
  type ToolExecutionControl,
  validateMeriSyntheticReadBudgetGuard,
} from '@capiro/meriv2-core';
import type { MeriDurableProviderAccounting } from './meriv3-run-budget.js';

/** Ordinary Standard/Deep uses the same per-attempt ingress as research. */
export function captureProviderAccounting(args: {
  policy: MeriServerReadonlyCapturePolicy | null;
  apiBaseUrl: string;
  serviceSecret?: string | null;
  bearerToken?: string;
  impersonateTenantId?: string;
  headers?: Record<string, string>;
  control?: ToolExecutionControl;
  fetchImpl?: typeof fetch;
}): MeriDurableProviderAccounting | undefined {
  const policy = args.policy;
  if (!policy || policy.expectedCaptureWrites[3] !== 'provider_budget_ledger') return undefined;
  validateMeriSyntheticReadBudgetGuard(policy);
  if (
    !policy.turnId ||
    (!policy.syntheticReadBudget && (!policy.caseId || !policy.captureRunId)) ||
    !args.serviceSecret ||
    !args.bearerToken
  )
    throw new Error('meri_capture_provider_budget_identity_missing');
  const transport = encodeMeriCapturePolicyTransport(
    policy,
    'provider_budget',
    null,
    args.serviceSecret,
  );
  const request = async (operation: 'reservations' | 'settlements', body: object) => {
    const response = await (args.fetchImpl ?? fetch)(
      `${args.apiBaseUrl}/api/clio/capture-provider-budget/${operation}`,
      {
        method: 'POST',
        signal: args.control?.signal,
        headers: {
          ...args.headers,
          authorization: `Bearer ${args.bearerToken}`,
          'x-internal-service-secret': args.serviceSecret!,
          [MERI_CAPTURE_POLICY_HEADER]: transport,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(args.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': args.impersonateTenantId }
            : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(`meri_capture_provider_budget_${operation}_rejected_http_${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };
  return {
    reserve: async (binding) => {
      const result = await request('reservations', binding);
      if (
        typeof result.reservationId !== 'string' ||
        !result.reservationId.trim() ||
        typeof result.dispatchAllowed !== 'boolean' ||
        typeof result.deadlineAt !== 'string' ||
        !Number.isFinite(Date.parse(result.deadlineAt)) ||
        Date.parse(result.deadlineAt) > policy.expiresAt
      )
        throw new Error('meri_capture_provider_budget_reservation_invalid');
      return {
        reservationId: result.reservationId,
        dispatchAllowed: result.dispatchAllowed,
        deadlineAt: result.deadlineAt,
      };
    },
    settle: async (reservation, outcome) => {
      const { logicalOperationId, attemptId, retryOfAttemptId, kind, phase, provider, model } =
        reservation;
      const result = await request('settlements', {
        reservationId: reservation.reservationId,
        binding: { logicalOperationId, attemptId, retryOfAttemptId, kind, phase, provider, model },
        outcome,
      });
      if (result.settled !== true)
        throw new Error('meri_capture_provider_budget_settlement_invalid');
    },
  };
}
