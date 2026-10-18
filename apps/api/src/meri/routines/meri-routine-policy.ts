import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { nativeCanonicalSha256, type NativeIdentity, type NativeRunBinding, type NativeScope } from '../native-approvals/native-approval.contract.js';
import {
  MERI_INBOX_DESTINATION,
  parseRoutineSelection,
  parseSelectionRequest,
  type RoutineScheduleRef,
} from './meri-routines.contract.js';

/**
 * Wire A (DRAFT): the attended selection-policy receipt Meri's
 * `apps/control/schedules/runtime-context.mjs` `policy()` requires.
 *
 * No value here is new policy. The limits are the pinned, approved first-chat
 * allocation budgets (D1: $2 per run; the supported routine profile's zero
 * retries). Meri already takes min(requested, receipt, the routine's own sealed
 * allocation), so the receipt is a ceiling, never a grant. The receipt lasts
 * no longer than the current membership receipt (the native session) and
 * Meri's own 30 s request bound.
 */
export const ROUTINE_POLICY_LIMITS = Object.freeze({ maxCostMicrousd: 2_000_000, maxRuntimeSeconds: 900, retryLimit: 0 });
export const ROUTINE_POLICY_LIMITS_SOURCE = Object.freeze({
  source: 'meri-greenfield 9ce9ecd5 infra/product-preview/first-chat/allocation.json',
  sha256: 'd9cd9a84f59185921d28aa6113e7e40361c6dfa3c60d5c4431ed37ab95796f0e',
  budgets: { maxRuntimeSeconds: 900, maxCostMicroUSD: 2_000_000, maxRecoveryAttempts: 0 },
});
/** Meri's ceiling for one request (`maxRequestMs` ≤ 30000 across its owners). */
export const ROUTINE_RECEIPT_MAX_MS = 30_000;

/** Current application membership facts (ApplicationMembershipService receipt). */
export interface RoutineMembershipFacts {
  tenantId: string;
  actorId: string;
  clientIds: readonly string[];
  expiresAtMs: number;
}

export interface RoutinePolicyReceipt {
  authorized: true;
  selectionSha256: string;
  binding: NativeRunBinding;
  scopes: NativeScope[];
  selectedClientId: string | null;
  destinationResolution: { reference: string; destinationId: typeof MERI_INBOX_DESTINATION } | null;
  limits: { maxCostMicrousd: number; maxRuntimeSeconds: number; retryLimit: number } | null;
  checkedAtMs: number;
  expiresAtMs: number;
}

const denied = (reason: string) => new ForbiddenException(`Routine policy refused: ${reason}`);
const sameJson = (a: unknown, b: unknown) => canonicalizeCoreRetainedJson(a) === canonicalizeCoreRetainedJson(b);

/** Tenant, one policy revision, and client scopes within the member's current clients. */
export function assertRoutineScopes(scopes: readonly NativeScope[], membership: RoutineMembershipFacts): void {
  const clients = new Set(membership.clientIds.map((id) => id.toLowerCase()));
  if (scopes.some((s) => s.tenantId !== membership.tenantId)) throw denied('scope tenant');
  if (new Set(scopes.map((s) => s.policyRevision)).size !== 1) throw denied('scope revision');
  if (scopes.some((s) => s.kind === 'client' && !clients.has(s.resourceId.toLowerCase()))) throw denied('client scope');
}

function sameOwner(ref: RoutineScheduleRef | null, principal: NativeIdentity, scopes: readonly NativeScope[]): boolean {
  return ref === null || (sameJson(ref.owner, principal) && sameJson(ref.scopes, scopes));
}

export function decideRoutinePolicy(input: {
  body: unknown;
  principal: NativeIdentity;
  membership: RoutineMembershipFacts;
  nowMs: number;
}): RoutinePolicyReceipt {
  const { selection: raw, selectionSha256 } = parseSelectionRequest(input.body);
  if (nativeCanonicalSha256(raw) !== selectionSha256) throw new BadRequestException('selectionSha256 mismatch');
  const selection = parseRoutineSelection(raw);
  const { principal, membership, nowMs } = input;
  const { binding, scopes, selectedClientId } = selection.current;
  if (membership.tenantId !== principal.tenantId || membership.actorId !== principal.actorId) throw denied('membership');
  if (binding.tenantId !== principal.tenantId || binding.actorId !== principal.actorId) throw denied('principal');
  assertRoutineScopes(scopes, membership);
  if (selectedClientId !== null && !membership.clientIds.map((id) => id.toLowerCase()).includes(selectedClientId)) throw denied('selected client');
  if (!sameOwner(selection.currentSchedule, principal, scopes) || !sameOwner(selection.proposal, principal, scopes)) throw denied('schedule owner');
  if (selection.request.scheduleId !== null &&
      [selection.currentSchedule, selection.proposal].some((ref) => ref !== null && ref.scheduleId !== selection.request.scheduleId)) {
    throw denied('schedule id');
  }
  const mutation = selection.operation === 'schedule_task' || selection.operation === 'update_scheduled_task';
  if (mutation && selection.request.destinationReference !== MERI_INBOX_DESTINATION) throw denied('destination');
  const expiresAtMs = Math.min(membership.expiresAtMs, nowMs + ROUTINE_RECEIPT_MAX_MS);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) throw denied('expired');
  return {
    authorized: true, selectionSha256, binding, scopes, selectedClientId,
    destinationResolution: mutation ? { reference: selection.request.destinationReference!, destinationId: MERI_INBOX_DESTINATION } : null,
    limits: mutation ? { ...ROUTINE_POLICY_LIMITS } : null,
    checkedAtMs: nowMs, expiresAtMs,
  };
}
