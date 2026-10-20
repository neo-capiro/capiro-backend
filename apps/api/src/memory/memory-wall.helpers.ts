/**
 * Ethical-wall decision helpers (master plan Phase 1 — client memory as an
 * ACCESS boundary, upgrading G2's relevance-only client scope).
 *
 * Model: Client.memory_wall (default false) + client_memory_access grants.
 * A walled client's memory (clio_memory scope='client', client-linked
 * memory_items, and their context_embeddings rows) is visible only to granted
 * users. Fail-closed: an unknown/absent user is denied every walled client,
 * and a walled client with zero grants is invisible to everyone — admins
 * included (an ethical screen binds seniors too).
 *
 * These are plain functions that run inside the CALLER'S existing
 * withTenant/withTenantUser transaction rather than an injected service, for
 * the same reason memory-recall-source.helpers.ts is pure: every memory read
 * path (MeriService, MeriToolsService, MemoryStoreService, controllers) can
 * apply the wall without new constructor dependencies, and the decision logic
 * unit-tests in isolation. They are the PRIMARY enforcement today: the
 * wall-aware RLS policies (migration 20260719221000) are forward-ready but
 * inert for the live app role until the capiro_app role hardening lands (see
 * that migration's runtime caveat).
 */
import type { Prisma } from '@prisma/client';

/** The transactional client every helper runs on (withTenant/withTenantUser). */
type Tx = Prisma.TransactionClient;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Render a validated Postgres uuid[] literal for inlining into raw SQL.
 * Every id must be a canonical UUID (they come from our own primary keys);
 * anything else throws rather than risking an injectable fragment.
 */
export function toUuidArrayLiteral(ids: readonly string[]): string {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`toUuidArrayLiteral: not a uuid: ${id}`);
  }
  return `'{${ids.join(',')}}'::uuid[]`;
}

/**
 * SQL fragment excluding rows attributed to any denied client, for appending
 * to a memory read's WHERE clause. Empty denied set → empty string (the
 * common, unwalled case pays nothing). The explicit IS NULL arm matters:
 * `col = ANY(...)` on a NULL column is NULL, and NOT NULL is still NULL —
 * without the arm every client-less row would vanish.
 */
export function wallExclusionSql(deniedClientIds: readonly string[], column: string): string {
  if (deniedClientIds.length === 0) return '';
  return ` AND (${column} IS NULL OR NOT (${column} = ANY(${toUuidArrayLiteral(deniedClientIds)})))`;
}

/**
 * Client ids in this tenant whose memory the given user may NOT see: walled
 * clients where the user holds no client_memory_access grant. `userId = null`
 * (a path that never identified its user) denies every walled client —
 * fail-closed by construction. Runs on the caller's transaction so it
 * composes with the read it guards.
 *
 * GRANT LIFECYCLE — read this before "fixing" the predicate.
 * `client_memory_access` (Prisma `ClientMemoryAccess`, the `Client
 * .memoryAccessGrants` relation) has exactly six columns: id, tenant_id,
 * client_id, user_id, granted_by, created_at — see migration
 * 20260719220000_client_memory_walls. It has NO status, expires_at or
 * revoked_at. Revocation is a hard DELETE, performed by
 * `ClientsService.setMemoryAccess()`'s replace-set write, so a revoked grant
 * stops matching this NOT EXISTS the moment that transaction commits. There
 * is no soft-deleted, expired or dead row for this query to miss, and adding
 * a `status`/`expires_at`/`revoked_at` filter here is not a hardening — it
 * does not compile and the columns do not exist.
 *
 * The lifecycle-bearing model with `status` / `expires_at` / `revoked_at` is
 * the DIFFERENT `memory_access_grant` table (Prisma `MemoryAccessGrant`, the
 * `Client.governedMemoryGrants` relation). It grants governed-memory
 * PERMISSIONS (read/propose/approve), not ethical-wall membership, and is
 * read with its own liveness predicate in `MemoryAuthorizationService
 * .evaluateInTx()`. The two are deliberately separate layers: that service
 * calls `clientMemoryAllowed()` below for the wall AND queries
 * memory_access_grant for permissions. Closeout finding A2 attributed
 * memory_access_grant's columns to client_memory_access; they are not the
 * same table.
 */
export async function fetchDeniedClientIds(
  tx: Tx,
  tenantId: string,
  userId: string | null,
  maxRows?: number,
): Promise<string[]> {
  if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 4097)) {
    throw new Error('invalid denied client bound');
  }
  const sql = `SELECT c.id
       FROM clients c
      WHERE c.tenant_id = $1::uuid
        AND c.memory_wall
        AND ($2::uuid IS NULL OR NOT EXISTS (
              SELECT 1 FROM client_memory_access a
              WHERE a.tenant_id = c.tenant_id
                AND a.client_id = c.id
                AND a.user_id = $2::uuid))`;
  // Preserve the existing three-argument query exactly. New bounded callers
  // overfetch one sentinel row and refuse incomplete observations themselves.
  const rows = maxRows === undefined
    ? await tx.$queryRawUnsafe<Array<{ id: string }>>(sql, tenantId, userId)
    : await tx.$queryRawUnsafe<Array<{ id: string }>>(
      sql + ' ORDER BY c.id LIMIT $3::integer', tenantId, userId, maxRows,
    );
  return rows.map((r) => r.id);
}

/**
 * May this user recall this client's memory? true = not walled, or walled
 * with a grant. A client id that does not resolve in this tenant is DENIED
 * (fail-closed — the caller is asking about something it cannot name).
 */
export { clientMemoryAllowed } from '@capiro/shared';

/**
 * Current client scope for a Clerk actor: visible, active client revisions for
 * an actor with active tenant membership. Resolve membership and ethical-wall
 * grants in the same read, and keep Clerk actor resolution inside the tenant
 * query: it is not a database user UUID. Callers recheck this scope after
 * async work before returning cached or provider-derived client content.
 * Revision hashes intentionally retain the dashboard cache contract.
 */
export async function fetchAccessibleClientRevisionsForClerkActor(
  tx: Tx,
  tenantId: string,
  actorId: string,
  maxRows?: number,
): Promise<Array<{ id: string; revision: string }>> {
  // Optional server-owned resource bound; NULL preserves existing full-roster callers.
  if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 4097)) {
    throw new Error('invalid client roster bound');
  }
  return tx.$queryRaw<Array<{ id: string; revision: string }>>`
    SELECT c.id::text, md5(to_jsonb(c)::text) AS revision FROM clients c
    JOIN tenant_memberships m ON m.tenant_id=c.tenant_id AND m.status::text='active'
    JOIN users u ON u.id=m.user_id AND u.clerk_user_id=${actorId}
    WHERE c.tenant_id=${tenantId}::uuid AND c.status::text<>'archived'
    AND (NOT c.memory_wall OR EXISTS (
      SELECT 1 FROM client_memory_access a
      WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=u.id
    )) ORDER BY c.id LIMIT ${maxRows ?? null}::integer`;
}

/**
 * Embed the wall decision in an atomic write predicate. All parameters are SQL
 * identifiers supplied by code, never values; reject anything outside that grammar.
 * The caller still owns tenant/client/archive predicates and bound actor values.
 */
export function clientMemoryAllowedForRowOwnerSql(
  clientAlias: string,
  ownerAlias: string,
  ownerColumn: string,
): string {
  for (const identifier of [clientAlias, ownerAlias, ownerColumn]) {
    if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new Error('invalid wall SQL identifier');
  }
  return `NOT ${clientAlias}.memory_wall OR EXISTS (
    SELECT 1 FROM client_memory_access wall_grant
    WHERE wall_grant.tenant_id = ${clientAlias}.tenant_id
      AND wall_grant.client_id = ${clientAlias}.id
      AND wall_grant.user_id = ${ownerAlias}.${ownerColumn}
  )`;
}
