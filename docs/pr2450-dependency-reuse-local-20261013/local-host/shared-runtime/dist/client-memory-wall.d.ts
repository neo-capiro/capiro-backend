/** Minimal transaction interface: callers provide their existing tenant-scoped transaction.
 * SQL text is static and values are bound parameters, including UUIDs. */
export interface ResourceScopeTransaction {
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}
/** Canonical client ethical-wall predicate. Grants are hard-deleted on revocation;
 * no administrator bypass or invented grant expiry/status fields. */
export declare function clientMemoryAllowed(tx: ResourceScopeTransaction, tenantId: string, userId: string | null, clientId: string): Promise<boolean>;
//# sourceMappingURL=client-memory-wall.d.ts.map