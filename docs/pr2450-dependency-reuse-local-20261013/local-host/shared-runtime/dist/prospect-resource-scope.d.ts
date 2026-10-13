import { type ResourceScopeTransaction } from './client-memory-wall.js';
export type ProspectResourceActor = {
    userId: string;
} | {
    clerkUserId: string;
};
export interface ProspectResourceScope {
    tenantId: string;
    prospectId: string;
    userId: string;
    clerkUserId: string;
    linkedClientId: string | null;
}
/** Additional resource restriction, never a substitute for a file/draft ACL.
 * The caller MUST supply a tenant-scoped transaction. SHARE locks keep current
 * identity, entitlement, conversion and grant decisions valid through a write.
 * Read-only callers also use short transactions; never hold them over providers.
 * Dismissed/archived history can be read, but cannot acquire new content/edits.
 */
export declare function prospectResourceScope(tx: ResourceScopeTransaction, tenantId: string, actor: ProspectResourceActor, prospectId: string, mode?: 'read' | 'write'): Promise<ProspectResourceScope | null>;
//# sourceMappingURL=prospect-resource-scope.d.ts.map