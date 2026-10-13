"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clientMemoryAllowed = clientMemoryAllowed;
/** Canonical client ethical-wall predicate. Grants are hard-deleted on revocation;
 * no administrator bypass or invented grant expiry/status fields. */
async function clientMemoryAllowed(tx, tenantId, userId, clientId) {
    const rows = await tx.$queryRawUnsafe(`SELECT (NOT c.memory_wall
             OR ($3::uuid IS NOT NULL AND EXISTS (
                   SELECT 1 FROM client_memory_access a
                   WHERE a.tenant_id = c.tenant_id
                     AND a.client_id = c.id
                     AND a.user_id = $3::uuid))) AS allowed
       FROM clients c
      WHERE c.tenant_id = $1::uuid AND c.id = $2::uuid`, tenantId, clientId, userId);
    return rows[0]?.allowed === true;
}
//# sourceMappingURL=client-memory-wall.js.map