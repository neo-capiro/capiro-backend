import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { isUuid } from '../auth/read-delegation/read-delegation.contract.js';
import { parseRetainedReadContext, retainedReadObject, retainedReadSnapshot, assertRetainedReadSelectors } from './retained-read-context.js';

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
  verifiedServiceIdentity: boolean,
  correlation: unknown,
  deadlineMs: number,
  nowMs: number,
): { clientId: string; ownerBody: Record<string, unknown> } {
  const refuse = (): never => { throw new ForbiddenException('Reserved action read refused'); };
  const context = parseRetainedReadContext(ctx, correlation, verifiedServiceIdentity);
  const clientId = context.subject.kind === 'client' ? context.subject.entityIds[0] : null;
  if (!clientId || context.normalizationContext !== null || !Number.isSafeInteger(nowMs) ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs <= nowMs) refuse();
  const wire = retainedReadSnapshot(retainedReadObject(protocol, ['input', 'metadata']), 16_384);
  if (wire.metadata !== null) refuse();
  const input = retainedReadObject(wire.input, ['mode', 'selection', 'cursor']);
  const selection = retainedReadObject(input.selection,
    ['clientId', 'actionItemId', 'status', 'sort', 'page', 'limit', 'cursorApplied']);
  assertRetainedReadSelectors(selection, context);
  const cursor = input.cursor;
  if (input.mode !== 'client_scoped' || selection.clientId !== clientId ||
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
        selection.actionItemId.trim() === selection.actionItemId)) refuse();
  const ownerBody: Record<string, unknown> = {
    clientId, limit: selection.limit, sort: selection.sort,
    ...(selection.actionItemId === null ? {} : { actionItemId: selection.actionItemId }),
    ...(selection.status === null ? {} : { status: selection.status }),
    ...(cursor === null ? {} : { cursor }),
  };
  return { clientId: clientId!, ownerBody };
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
