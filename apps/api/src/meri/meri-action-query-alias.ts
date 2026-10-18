import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  assertDelegatedToolSelectors, closed, isUuid,
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

export function assertActionQueryAliasAdmission(
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
  body: unknown,
  grant: MeriReadDelegationGrant | undefined,
  verifiedServiceIdentity: boolean,
): asserts grant is MeriReadDelegationGrant {
  const refuse = (): never => { throw new ForbiddenException('Reserved action read refused'); };
  if (!grant) throw new ForbiddenException('Reserved action read refused');
  if (grant.kind !== 'tool' || grant.operation?.id !== ACTION_QUERY_OPERATION.id ||
      grant.operation.version !== ACTION_QUERY_OPERATION.version ||
      grant.tenantId !== ctx.tenantId || grant.actorId !== ctx.userId ||
      !verifiedServiceIdentity || !isUuid(grant.clientId)) refuse();

  // Meri PR167 emits this bounded query body. Require the exact selected
  // client even though the canonical owner also accepts tenant-wide reads.
  const input = closed(body, ['clientId', 'limit', 'sort'], 'actions.query body',
    ['actionItemId', 'status', 'cursor']);
  assertDelegatedToolSelectors(input, grant, ['clientId']);
  if (input.clientId !== grant.clientId || !isUuid(input.clientId) ||
      !Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 50 ||
      (input.sort !== 'deadline' && input.sort !== 'priority') ||
      (input.status !== undefined && (typeof input.status !== 'string' || !STATUSES.has(input.status))) ||
      (input.actionItemId !== undefined &&
        (typeof input.actionItemId !== 'string' || !input.actionItemId.trim() || input.actionItemId.length > 80)) ||
      (input.cursor !== undefined &&
        (typeof input.cursor !== 'string' || !input.cursor.trim() || input.cursor.length > 4096))) refuse();
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
