import type { Prisma } from '@prisma/client';

/**
 * Unmounted local-fact leaf for a Core/Meri saved-history release decision.
 * The caller owns a single tenant-scoped REPEATABLE READ transaction, checks
 * current membership in that same transaction, and makes a fresh online Clerk
 * observation while these locks are held. This leaf must never open its own
 * transaction or turn the caller's scope labels into authority.
 */
export type HistoryReleaseSelectedClientTx = Pick<Prisma.TransactionClient, '$queryRaw'>;
export interface HistoryReleaseSelectedClientPrincipal {
  tenantId: string;
  actorId: string;
}
export interface HistoryReleaseSelectedClientSubject {
  conversationId: string;
  clientId: string | null;
  scopes: readonly {
    tenantId: string;
    kind: string;
    resourceId: string;
    policyRevision: string;
  }[];
}

export class HistoryReleaseSelectedClientUnavailable extends Error {
  constructor() {
    super('Application authority unavailable');
    this.name = 'HistoryReleaseSelectedClientUnavailable';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = (): never => { throw new HistoryReleaseSelectedClientUnavailable(); };
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

interface LockedClient {
  id: string;
  tenantId: string;
  status: string;
  memoryWall: boolean;
}
interface LockedGrant { id: string; }
interface LockedConversation {
  id: string;
  tenantId: string;
  userId: string;
  clientId: string | null;
  status: string;
  archivedAt: Date | null;
  metadata: unknown;
}

function exactlyOne<T>(rows: T[]): T {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]) return unavailable();
  return rows[0];
}

/**
 * Returns no receipt and no partial result. All subjects pass against locked
 * Core facts, or the caller's entire release transaction must abort. This
 * deliberately supports exactly one selected-client scope per conversation.
 * Other scopes require transaction-aware prospect/RP/mailbox owners first.
 * `policyRevision` is a Meri-owned opaque label, not a Core grant or a Core
 * policy fact; the Meri release owner remains responsible for its validity.
 */
export async function assertSelectedClientHistoryReleaseWithinTx(
  tx: HistoryReleaseSelectedClientTx,
  principal: HistoryReleaseSelectedClientPrincipal,
  route: 'list' | 'transcript',
  subjects: readonly HistoryReleaseSelectedClientSubject[],
): Promise<void> {
  if (!tx || typeof tx.$queryRaw !== 'function' || !isUuid(principal?.tenantId) ||
      !isUuid(principal?.actorId) || (route !== 'list' && route !== 'transcript') ||
      !Array.isArray(subjects) || subjects.length > 100 ||
      (route === 'transcript' && subjects.length !== 1)) return unavailable();

  const byConversation = new Set<string>();
  const clients = new Set<string>();
  for (const subject of subjects) {
    if (!subject || !isUuid(subject.conversationId) || !isUuid(subject.clientId) ||
        byConversation.has(subject.conversationId) || !Array.isArray(subject.scopes) ||
        subject.scopes.length !== 1) return unavailable();
    const scope = subject.scopes[0];
    if (!scope || scope.kind !== 'client' || scope.tenantId !== principal.tenantId ||
        scope.resourceId !== subject.clientId || typeof scope.policyRevision !== 'string' ||
        scope.policyRevision.length === 0 || scope.policyRevision.length > 256) return unavailable();
    byConversation.add(subject.conversationId);
    clients.add(subject.clientId);
  }

  // All calls to this leaf take the same lock order, independent of response
  // order. The explicit tenant/actor predicates are mandatory: raw SQL does
  // not inherit Prisma's tenant-scope query extension on this runtime role.
  const requested = new Map(subjects.map((subject) => [subject.conversationId, subject.clientId]));
  for (const conversationId of [...byConversation].sort()) {
    const conversation = exactlyOne(await tx.$queryRaw<LockedConversation[]>`
      SELECT id::text AS "id", tenant_id::text AS "tenantId",
             user_id::text AS "userId", client_id::text AS "clientId",
             status, archived_at AS "archivedAt", metadata_jsonb AS "metadata"
        FROM clio_conversations
       WHERE tenant_id = ${principal.tenantId}::uuid
         AND user_id = ${principal.actorId}::uuid
         AND id = ${conversationId}::uuid
       FOR SHARE
    `);
    if (conversation.id !== conversationId || conversation.tenantId !== principal.tenantId ||
        conversation.userId !== principal.actorId ||
        conversation.clientId !== requested.get(conversationId) ||
        conversation.status !== 'active' || conversation.archivedAt !== null) return unavailable();

    // These existing conversation owners have additional mutable authority
    // facts. Do not silently treat a client scope as covering either one.
    const metadata = conversation.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        Object.hasOwn(metadata, 'bizdevProspectScope') ||
        Object.hasOwn(metadata, 'researchPortfolioScope')) return unavailable();
  }

  // Only after the owned conversation set is established do we lock the
  // selected clients. An arbitrary client ID in a mismatched subject cannot
  // make this leaf hold an unrelated client's row lock.
  for (const clientId of [...clients].sort()) {
    const client = exactlyOne(await tx.$queryRaw<LockedClient[]>`
      SELECT id::text AS "id", tenant_id::text AS "tenantId", status,
             memory_wall AS "memoryWall"
        FROM clients
       WHERE tenant_id = ${principal.tenantId}::uuid AND id = ${clientId}::uuid
       FOR SHARE
    `);
    if (client.id !== clientId || client.tenantId !== principal.tenantId ||
        client.status === 'archived' || typeof client.status !== 'string' ||
        typeof client.memoryWall !== 'boolean') return unavailable();
    if (client.memoryWall) {
      // A wall toggle is blocked by the client lock; an existing actor grant
      // cannot be revoked or deleted while its row lock is held. A missing
      // grant never confers authority and is refused immediately.
      const grant = exactlyOne(await tx.$queryRaw<LockedGrant[]>`
        SELECT id::text AS "id" FROM client_memory_access
         WHERE tenant_id = ${principal.tenantId}::uuid
           AND client_id = ${clientId}::uuid
           AND user_id = ${principal.actorId}::uuid
         FOR SHARE
      `);
      if (!isUuid(grant.id)) return unavailable();
    }
  }
}
