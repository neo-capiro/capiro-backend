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
 */
export async function fetchDeniedClientIds(
  tx: Tx,
  tenantId: string,
  userId: string | null,
): Promise<string[]> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT c.id
       FROM clients c
      WHERE c.tenant_id = $1::uuid
        AND c.memory_wall
        AND ($2::uuid IS NULL OR NOT EXISTS (
              SELECT 1 FROM client_memory_access a
              WHERE a.tenant_id = c.tenant_id
                AND a.client_id = c.id
                AND a.user_id = $2::uuid))`,
    tenantId,
    userId,
  );
  return rows.map((r) => r.id);
}

/**
 * May this user recall this client's memory? true = not walled, or walled
 * with a grant. A client id that does not resolve in this tenant is DENIED
 * (fail-closed — the caller is asking about something it cannot name).
 */
export async function clientMemoryAllowed(
  tx: Tx,
  tenantId: string,
  userId: string | null,
  clientId: string,
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ allowed: boolean }>>(
    `SELECT (NOT c.memory_wall
             OR ($3::uuid IS NOT NULL AND EXISTS (
                   SELECT 1 FROM client_memory_access a
                   WHERE a.tenant_id = c.tenant_id
                     AND a.client_id = c.id
                     AND a.user_id = $3::uuid))) AS allowed
       FROM clients c
      WHERE c.tenant_id = $1::uuid AND c.id = $2::uuid`,
    tenantId,
    clientId,
    userId,
  );
  return rows[0]?.allowed === true;
}
