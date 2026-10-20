import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  assertDelegatedToolSelectors, canonicalSha256, closed, isSha, isUuid,
} from '../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../auth/read-delegation/read-delegation-request.js';

/** The reserved operation is not a model tool. Its only Core implementation
 * is a selected-client call into the existing query_action_items read owner. */
export const ACTION_QUERY_OPERATION = Object.freeze({ id: 'actions.query', version: '0.2.0' });
export const ACTION_QUERY_OWNER = 'query_action_items';

const STATUSES = new Set([
  'new', 'triaged', 'assigned', 'drafting', 'ready_for_review',
  'sent_to_client', 'outreach_completed', 'monitoring', 'dismissed', 'archived',
]);

export function admitActionQueryAlias(
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
  protocol: unknown,
  grant: MeriReadDelegationGrant | undefined,
  verifiedServiceIdentity: boolean,
  authenticatedCorrelation: unknown,
  nowMs: number,
): { grant: MeriReadDelegationGrant; ownerBody: Record<string, unknown> } {
  const refuse = (): never => { throw new ForbiddenException('Reserved action read refused'); };
  if (!grant) throw new ForbiddenException('Reserved action read refused');
  if (grant.kind !== 'tool' || grant.operation?.id !== ACTION_QUERY_OPERATION.id ||
      grant.operation.version !== ACTION_QUERY_OPERATION.version ||
      grant.tenantId !== ctx.tenantId || grant.actorId !== ctx.userId ||
      !verifiedServiceIdentity || !isUuid(grant.clientId) ||
      !Number.isSafeInteger(nowMs) || nowMs >= grant.hardExpiryMs) refuse();

  // The middleware already authenticated the canonical header against the
  // signed token before consuming it. Recheck its task and selected subject
  // here so the route never treats a bare wrapper as authority.
  const correlation = closed(authenticatedCorrelation,
    ['binding', 'subject', 'policyRevision', 'normalizationContext'], 'actions.query correlation');
  if (!isSha(grant.correlationSha256) || canonicalSha256(correlation) !== grant.correlationSha256 ||
      correlation.normalizationContext !== null || correlation.policyRevision !== grant.policyRevision) refuse();
  const binding = closed(correlation.binding,
    ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence'],
    'actions.query binding');
  if (canonicalSha256(binding) !== canonicalSha256(grant.admittedBinding) ||
      binding.tenantId !== grant.tenantId || binding.actorId !== grant.actorId ||
      binding.conversationId !== grant.conversationId || binding.runId !== grant.runId ||
      binding.attemptId !== grant.binding.attemptId) refuse();
  const subject = closed(correlation.subject,
    ['kind', 'entityType', 'entityIds', 'tenantId', 'actorId', 'authorizationDecisionId',
      'policyRevision', 'scopes', 'rosterVersionId'], 'actions.query subject');
  if (subject.kind !== 'client' || subject.entityType !== 'client' ||
      !Array.isArray(subject.entityIds) || subject.entityIds.length !== 1 ||
      subject.entityIds[0] !== grant.clientId || subject.tenantId !== grant.tenantId ||
      subject.actorId !== grant.actorId || !isUuid(subject.authorizationDecisionId) ||
      subject.policyRevision !== grant.policyRevision || subject.rosterVersionId !== null) refuse();
  // PR171's action task port requires one selected-client task scope and
  // proves the emitted subject scopes equal that task scope.
  const scopes = subject.scopes;
  if (!Array.isArray(scopes) || scopes.length !== 1) throw new ForbiddenException('Reserved action read refused');
  const scope = closed(scopes[0], ['tenantId', 'kind', 'resourceId', 'policyRevision'], 'actions.query scope');
  if (scope.kind !== 'client' || scope.tenantId !== grant.tenantId ||
      scope.resourceId !== grant.clientId || scope.policyRevision !== grant.policyRevision) refuse();

  // PR171 emits the normalized client-scoped input, not the legacy flat owner
  // body. The original reservation binds the complete normalized input SHA.
  const wire = closed(protocol, ['input', 'metadata'], 'actions.query body');
  if (wire.metadata !== null) refuse();
  const input = closed(wire.input, ['mode', 'selection', 'cursor'], 'actions.query input');
  const selection = closed(input.selection,
    ['clientId', 'actionItemId', 'status', 'sort', 'page', 'limit', 'cursorApplied'],
    'actions.query selection');
  assertDelegatedToolSelectors(selection, grant, ['clientId']);
  const cursor = input.cursor;
  if (input.mode !== 'client_scoped' || selection.clientId !== grant.clientId ||
      !isUuid(selection.clientId) ||
      !(cursor === null || typeof cursor === 'string' && cursor.length > 0 &&
        cursor.length <= 4096 && cursor.trim() === cursor) ||
      (cursor === null ? selection.page !== 1 || selection.cursorApplied !== false
        : selection.page !== null || selection.cursorApplied !== true) ||
      !Number.isSafeInteger(selection.limit) || Number(selection.limit) < 1 || Number(selection.limit) > 50 ||
      (selection.sort !== 'deadline' && selection.sort !== 'priority') ||
      !(selection.status === null || typeof selection.status === 'string' && STATUSES.has(selection.status)) ||
      !(selection.actionItemId === null || typeof selection.actionItemId === 'string' &&
        selection.actionItemId.length > 0 && selection.actionItemId.length <= 80 &&
        selection.actionItemId.trim() === selection.actionItemId) ||
      !isSha(grant.argumentsSha256) || canonicalSha256(input) !== grant.argumentsSha256) refuse();
  const ownerBody: Record<string, unknown> = {
    clientId: grant.clientId, limit: selection.limit, sort: selection.sort,
    ...(selection.actionItemId === null ? {} : { actionItemId: selection.actionItemId }),
    ...(selection.status === null ? {} : { status: selection.status }),
    ...(cursor === null ? {} : { cursor }),
  };
  return { grant, ownerBody };
}

/** Defense in depth after the canonical owner has checked every returned row. */
export function assertActionQueryAliasResult(result: unknown, clientId: string): void {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) ||
      r.tool !== ACTION_QUERY_OWNER || r.clientId !== clientId ||
      !Array.isArray(r.actions) ||
      r.actions.some((row) => !row || typeof row !== 'object' || row.clientId !== clientId) ||
      !r.coverage || typeof r.coverage !== 'object' || Array.isArray(r.coverage)) {
    throw new ForbiddenException('Reserved action read refused');
  }
}
