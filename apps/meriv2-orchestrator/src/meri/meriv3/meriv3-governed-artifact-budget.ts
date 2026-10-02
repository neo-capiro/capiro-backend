import {
  encodeMeriGovernedArtifactTransport,
  validateMeriGovernedArtifactPolicy,
  MERI_GOVERNED_ARTIFACT_HEADER,
  MERI_CAPTURE_POLICY_HEADER,
  type MeriGovernedArtifactCapturePolicy,
  type ToolExecutionControl,
} from '@capiro/meriv2-core';
import type { MeriDurableProviderAccounting } from './meriv3-run-budget.js';

/** Same reservation arithmetic/ingress, distinct signed current authority. */
export function governedArtifactProviderAccounting(args: {
  policy: MeriGovernedArtifactCapturePolicy | null;
  apiBaseUrl: string;
  serviceSecret?: string | null;
  bearerToken?: string;
  impersonateTenantId?: string;
  headers?: Record<string, string>;
  control?: ToolExecutionControl;
  fetchImpl?: typeof fetch;
}): MeriDurableProviderAccounting | undefined {
  if (!args.policy) return undefined;
  const policy = validateMeriGovernedArtifactPolicy(args.policy, args.policy);
  if (
    !policy.turnId ||
    !args.serviceSecret?.trim() ||
    !args.bearerToken?.trim() ||
    args.impersonateTenantId
  )
    throw new Error('meri_governed_artifact_provider_identity_missing');
  const reservedHeaders = [
    MERI_CAPTURE_POLICY_HEADER,
    MERI_GOVERNED_ARTIFACT_HEADER,
    'authorization',
    'x-internal-service-secret',
    'x-capiro-impersonate-tenant',
  ];
  if (Object.keys(args.headers ?? {}).some((name) => reservedHeaders.includes(name.toLowerCase())))
    throw new Error('meri_governed_artifact_provider_header_override');
  const transport = encodeMeriGovernedArtifactTransport(
    policy,
    'provider_budget',
    args.serviceSecret,
  );
  const request = async (operation: 'reservations' | 'settlements', body: object) => {
    const remaining = policy.expiresAt - Date.now();
    if (remaining <= 0) throw new Error('meri_governed_artifact_provider_expired');
    const timeout = AbortSignal.timeout(Math.min(30_000, remaining));
    const response = await (args.fetchImpl ?? fetch)(
      `${args.apiBaseUrl.replace(/\/+$/, '')}/api/clio/capture-provider-budget/${operation}`,
      {
        method: 'POST',
        redirect: 'error',
        signal: args.control?.signal ? AbortSignal.any([args.control.signal, timeout]) : timeout,
        headers: {
          ...args.headers,
          authorization: `Bearer ${args.bearerToken}`,
          'x-internal-service-secret': args.serviceSecret!,
          [MERI_GOVERNED_ARTIFACT_HEADER]: transport,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(
        `meri_governed_artifact_provider_${operation}_rejected_http_${response.status}`,
      );
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
        Date.parse(result.deadlineAt) > policy.expiresAt ||
        Date.parse(result.deadlineAt) <= Date.now()
      )
        throw new Error('meri_governed_artifact_provider_reservation_invalid');
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
        throw new Error('meri_governed_artifact_provider_settlement_invalid');
    },
  };
}
