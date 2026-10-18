import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
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
 * No value here is new policy. The limits are CONFIGURED platform maxima
 * (D016-A item 3; dot #121 6247742665: never a hard-coded universal ceiling):
 * `MERI_ROUTINE_MAX_COST_MICROUSD`, `MERI_ROUTINE_MAX_RUNTIME_SECONDS` and
 * `MERI_ROUTINE_RETRY_LIMIT` (default 0, the supported profile's no-retry
 * bound). The D016 default integration profile ($2, 900 s) is set in the
 * deployment template. Meri already takes min(requested, receipt, the routine's
 * own sealed allocation), so the receipt is a ceiling, never a grant. A create
 * or update without configured maxima answers 503. The receipt lasts no longer
 * than the current membership receipt (the native session) and Meri's own
 * 30 s request bound.
 */
export interface RoutineLimits { maxCostMicrousd: number; maxRuntimeSeconds: number; retryLimit: number }

export function readRoutinePolicyLimits(env: NodeJS.ProcessEnv): RoutineLimits | null {
  const read = (name: string) => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return undefined;
    if (!/^(0|[1-9][0-9]{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${name} must be a non-negative integer`);
    return Number(raw);
  };
  const maxCostMicrousd = read('MERI_ROUTINE_MAX_COST_MICROUSD');
  const maxRuntimeSeconds = read('MERI_ROUTINE_MAX_RUNTIME_SECONDS');
  const retryLimit = read('MERI_ROUTINE_RETRY_LIMIT') ?? 0;
  if (maxCostMicrousd === undefined && maxRuntimeSeconds === undefined) return null;
  if (!maxCostMicrousd || !maxRuntimeSeconds) throw new Error('MERI_ROUTINE_MAX_COST_MICROUSD and MERI_ROUTINE_MAX_RUNTIME_SECONDS are required together and positive');
  return { maxCostMicrousd, maxRuntimeSeconds, retryLimit };
}
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
  /** Configured maxima (`readRoutinePolicyLimits`); null answers 503 for a create or update. */
  limits: RoutineLimits | null;
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
  if (mutation && !input.limits) throw new ServiceUnavailableException('Routine limits are not configured');
  const expiresAtMs = Math.min(membership.expiresAtMs, nowMs + ROUTINE_RECEIPT_MAX_MS);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) throw denied('expired');
  return {
    authorized: true, selectionSha256, binding, scopes, selectedClientId,
    destinationResolution: mutation ? { reference: selection.request.destinationReference!, destinationId: MERI_INBOX_DESTINATION } : null,
    limits: mutation ? { ...input.limits! } : null,
    checkedAtMs: nowMs, expiresAtMs,
  };
}
