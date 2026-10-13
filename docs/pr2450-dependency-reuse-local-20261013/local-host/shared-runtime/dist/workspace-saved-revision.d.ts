import { type ResourceScopeTransaction } from './client-memory-wall.js';
/** Workspace's bounded read/export ACL. Pending and unknown roles never grant access. */
export declare function workspaceCanRead(role: string | null): boolean;
export declare class WorkspaceRevisionUnavailable extends Error {
}
export declare function canonicalWorkspaceSnapshot(value: unknown): string;
/** Canonical Workspace version owner seam, called only inside an existing
 * tenant-scoped transaction. Locks remain held through the caller's command
 * commit. Core does not add ws_* ORM models or bypass source restrictions.
 * This first distribution slice supports ordinary manually editable drafts;
 * prospect and any receipt-backed Intel source draft remain transfer-ineligible.
 */
export declare function workspaceSavedOutreachRevisionWithinTx(tx: ResourceScopeTransaction, input: {
    tenantId: string;
    clerkUserId: string;
    userId?: string;
    draftId: string;
    versionId: string;
}): Promise<{
    draftId: string;
    versionId: string;
    authorId: string;
    authorKind: string;
    savedAt: string;
    snapshot: unknown;
    snapshotJson: string;
    clientId: string | null;
    contentSkeleton: {
        subject: string;
        body: string;
        slots: never[];
    };
}>;
/** Existing Workspace import text projection, shared with the staging owner. */
export declare function workspaceHtmlToPlainText(html: string): string;
export declare function workspaceDocumentText(body: unknown, draftConfig: unknown): string;
//# sourceMappingURL=workspace-saved-revision.d.ts.map