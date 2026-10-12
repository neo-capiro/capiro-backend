/** Minimal transaction interface: callers provide their existing tenant-scoped transaction.
 * SQL text is static and values are bound parameters, including UUIDs. */
export interface ResourceScopeTransaction {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** Canonical client ethical-wall predicate. Grants are hard-deleted on revocation;
 * no administrator bypass or invented grant expiry/status fields. */
export async function clientMemoryAllowed(
  tx: ResourceScopeTransaction,
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
