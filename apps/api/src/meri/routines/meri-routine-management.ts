/** Current owner/scope observation and narrow policy for management without a conversation or model run. */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { nativeCanonicalSha256, type NativeIdentity } from '../native-approvals/native-approval.contract.js';
import { ROUTINE_RECEIPT_MAX_MS, type RoutineMembershipFacts } from './meri-routine-policy.js';
import { parseRoutineManagementScope, parseRoutineManagementSelection, parseSelectionRequest, type RoutineManagementCurrent } from './meri-routines.contract.js';

export interface RoutineManagementMembership extends RoutineMembershipFacts { membershipRevision: string }
const same = (a: unknown, b: unknown) => nativeCanonicalSha256(a) === nativeCanonicalSha256(b);
const denied = () => new ForbiddenException('Routine management authority refused');

export function routineManagementCurrent(input: { body: unknown; principal: NativeIdentity; membership: RoutineManagementMembership; nowMs: number }) {
  const selected = parseRoutineManagementScope(input.body), { principal, membership, nowMs } = input;
  if (membership.tenantId !== principal.tenantId || membership.actorId !== principal.actorId ||
      !/^[a-f0-9]{64}$/.test(membership.membershipRevision) ||
      selected.clientId !== null && !membership.clientIds.includes(selected.clientId)) throw denied();
  const scopes = [{ kind: selected.clientId === null ? 'private-user' as const : 'client' as const, tenantId: principal.tenantId,
    resourceId: selected.clientId ?? principal.actorId, policyRevision: selected.policyRevision }];
  const contextRevision = nativeCanonicalSha256({ kind: 'routine-management', principal, scopes, selectedClientId: selected.clientId, membershipRevision: membership.membershipRevision });
  const expiresAtMs = Math.min(membership.expiresAtMs, nowMs + ROUTINE_RECEIPT_MAX_MS);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) throw denied();
  return { kind: 'routine-management' as const, principal, scopes, selectedClientId: selected.clientId,
    membershipRevision: membership.membershipRevision, contextRevision, checkedAtMs: nowMs, expiresAtMs };
}

export function decideRoutineManagementPolicy(input: { body: unknown; principal: NativeIdentity; membership: RoutineManagementMembership; nowMs: number }) {
  const { selection: raw, selectionSha256 } = parseSelectionRequest(input.body);
  if (nativeCanonicalSha256(raw) !== selectionSha256) throw new BadRequestException('selectionSha256 mismatch');
  const selection = parseRoutineManagementSelection(raw), { current } = selection;
  if (current.scopes.length !== 1) throw denied();
  const fresh = routineManagementCurrent({ ...input, body: { clientId: current.selectedClientId, policyRevision: current.scopes[0]!.policyRevision } });
  const { checkedAtMs, expiresAtMs, ...expected } = fresh;
  if (!same(current, expected)) throw denied();
  for (const resource of [selection.currentSchedule, selection.proposal, selection.resource]) {
    if (resource !== null && (!same(resource.owner, input.principal) || !same(resource.scopes, fresh.scopes) ||
        selection.request.scheduleId !== null && resource.scheduleId !== selection.request.scheduleId)) throw denied();
  }
  return { authorized: true as const, selectionSha256, current: expected as RoutineManagementCurrent,
    destinationResolution: null, limits: null, checkedAtMs, expiresAtMs };
}
