import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { OperationRef, ReadTokenKind } from './read-delegation.contract.js';

const refused = () => new ForbiddenException('General read delegation refused');
export function generalRunScope(scopes: unknown, tenantId: string, actorId: string, policyRevision: string) {
  if (!Array.isArray(scopes) || scopes.length !== 1) return false;
  const s = scopes[0];
  return s && typeof s === 'object' && Object.keys(s).sort().join() === 'kind,policyRevision,resourceId,tenantId' &&
    s.kind === 'private-user' && s.tenantId === tenantId && s.resourceId === actorId && s.policyRevision === policyRevision;
}
/** Existing stored government projections; never an unscoped client-data read. */
export const GENERAL_PUBLIC_READ_INPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  search_cbo_cost_estimates: Object.freeze(['billId', 'query', 'congress', 'limit']),
  search_gao_reports: Object.freeze(['query', 'reportType', 'limit']),
  search_crs_reports: Object.freeze(['query', 'limit']),
  search_state_bills: Object.freeze(['query', 'state', 'session', 'status', 'limit']),
  get_state_legislator: Object.freeze(['query', 'state', 'limit']),
});
export function isGeneralPublicRead(operation: OperationRef | null): boolean {
  return operation?.version === '0.2.0' && Object.hasOwn(GENERAL_PUBLIC_READ_INPUTS, operation.id);
}
/** Keep caller fields within these owners' existing public request contracts. */
export function assertGeneralPublicReadInput(operation: OperationRef | null, body: unknown): void {
  if (!isGeneralPublicRead(operation) || !body || typeof body !== 'object' || Array.isArray(body)) throw refused();
  const keys = GENERAL_PUBLIC_READ_INPUTS[operation!.id]!;
  if (Object.entries(body).some(([key, value]) => !keys.includes(key) ||
      (typeof value !== 'string' && typeof value !== 'number'))) throw refused();
}
/** This attribution boundary supplements the existing canonical output validators
 * in Meri. It does not recast the stored public projection as personal/client data. */
export function assertGeneralPublicReadResult(operation: OperationRef | null, result: unknown): void {
  if (!isGeneralPublicRead(operation) || !result || typeof result !== 'object' || Array.isArray(result) ||
      (result as { tool?: unknown }).tool !== operation!.id) throw refused();
  const forbidden = /^(client_?ids?|clientRef|client|selectedClientId|tenant_?id|actor_?id|user_?id|ownerActorId|scope|scopes|scopeKind|subject)$/i;
  const visit = (value: unknown, depth: number) => {
    if (depth > 12) throw refused();
    if (!value || typeof value !== 'object' || value instanceof Date) return;
    if (Array.isArray(value)) { value.forEach(child => visit(child, depth + 1)); return; }
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.test(key)) throw refused();
      visit(child, depth + 1);
    }
  };
  visit(result, 0);
}
/** Matches Meri's source-supported General native readers, not an installation grant.
 * Other retained/source families remain client-chat-only until their General path is qualified. */
const GENERAL_CLIENT_READS: ReadonlySet<string> = new Set([
  'get_representation', 'get_district_nexus_context', 'get_district_nexus_changes',
  'search_tracked_bills', 'query_outreach', 'get_business_development_context',
  'get_business_development_recent_changes',
]);
/** Null is restricted to current checks, personal/firm memory, and exact public reads. */
export function assertGeneralReadTarget(kind: ReadTokenKind, operation: OperationRef | null, target: string | null | undefined) {
  if (target === undefined) throw refused();
  if (operation?.id === 'memory.list_own_proposals' || operation?.id === 'list_memory_proposals') throw refused();
  if (operation?.id === 'search_memory' && (kind !== 'tool' || operation.version !== '0.2.0' || target !== null)) throw refused();
  if (target !== null) {
    if ((kind === 'current' || kind === 'reference') && operation === null) return;
    if ((kind === 'tool' || kind === 'mode') && operation?.version === '0.2.0' && GENERAL_CLIENT_READS.has(operation.id)) return;
    throw refused();
  }
  if (kind === 'current' && operation === null) return;
  if (kind === 'tool' && operation?.version === '0.2.0' && operation.id === 'search_memory') return;
  if (kind === 'tool' && isGeneralPublicRead(operation)) return;
  throw refused();
}
/** Repeated at issue/use/release; legacy null and deleted-client chats never qualify. */
export async function assertGeneralOrigin(tx: Prisma.TransactionClient, scope: { tenantId: string; actorId: string; conversationId: string }) {
  const row = await tx.clioConversation.findFirst({ where: { id: scope.conversationId, tenantId: scope.tenantId,
    userId: scope.actorId, clientId: null, status: 'active', archivedAt: null }, include: { bootstrapReceipt: true } });
  const b = row?.bootstrapReceipt;
  if (!b || b.tenantId !== scope.tenantId || b.actorUserId !== scope.actorId || b.conversationId !== scope.conversationId ||
      b.scopeKind !== 'general' || b.clientId !== null) throw refused();
}
