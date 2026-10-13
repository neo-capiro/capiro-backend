"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceRevisionUnavailable = void 0;
exports.workspaceCanRead = workspaceCanRead;
exports.canonicalWorkspaceSnapshot = canonicalWorkspaceSnapshot;
exports.workspaceSavedOutreachRevisionWithinTx = workspaceSavedOutreachRevisionWithinTx;
exports.workspaceHtmlToPlainText = workspaceHtmlToPlainText;
exports.workspaceDocumentText = workspaceDocumentText;
const client_memory_wall_js_1 = require("./client-memory-wall.js");
/** Workspace's bounded read/export ACL. Pending and unknown roles never grant access. */
function workspaceCanRead(role) {
    return role !== null && ['owner', 'editor', 'reviewer', 'commenter', 'viewer'].includes(role);
}
class WorkspaceRevisionUnavailable extends Error {
}
exports.WorkspaceRevisionUnavailable = WorkspaceRevisionUnavailable;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonicalWorkspaceSnapshot(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalWorkspaceSnapshot).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const obj = value;
        return `{${Object.keys(obj)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalWorkspaceSnapshot(obj[k])}`)
            .join(',')}}`;
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
        throw new WorkspaceRevisionUnavailable();
    return serialized;
}
/** Canonical Workspace version owner seam, called only inside an existing
 * tenant-scoped transaction. Locks remain held through the caller's command
 * commit. Core does not add ws_* ORM models or bypass source restrictions.
 * This first distribution slice supports ordinary manually editable drafts;
 * prospect and any receipt-backed Intel source draft remain transfer-ineligible.
 */
async function workspaceSavedOutreachRevisionWithinTx(tx, input) {
    const unavailable = () => {
        throw new WorkspaceRevisionUnavailable();
    };
    if (![input.tenantId, input.draftId, input.versionId].every((id) => UUID.test(id)) ||
        !input.clerkUserId ||
        input.clerkUserId.length > 200 ||
        (input.userId !== undefined && !UUID.test(input.userId)))
        unavailable();
    const [tenant] = await tx.$queryRawUnsafe(`SELECT id FROM tenants WHERE id=$1::uuid AND status::text='active' FOR SHARE`, input.tenantId);
    if (!tenant)
        unavailable();
    const [member] = await tx.$queryRawUnsafe(`SELECT u.id::text AS "userId" FROM tenant_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.tenant_id=$1::uuid AND m.status::text='active'
       AND m.role::text IN ('standard_user','user_admin','capiro_admin')
       AND u.clerk_user_id=$2 AND ($3::uuid IS NULL OR u.id=$3::uuid) FOR SHARE OF m,u`, input.tenantId, input.clerkUserId, input.userId ?? null);
    if (!member)
        unavailable();
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_user',$1,true)`, member.userId);
    const [draft] = await tx.$queryRawUnsafe(`SELECT owner_id AS "ownerId",prospect_id::text AS "prospectId",config,client FROM ws_draft
     WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE`, input.tenantId, input.draftId);
    if (!draft || draft.prospectId)
        unavailable();
    // Canonical source creation commits this immutable receipt with a NEW draft.
    // The existing app role has SELECT/INSERT only here: a locking SELECT would
    // require an unauthorized UPDATE privilege. No later attachment path exists.
    const sources = await tx.$queryRawUnsafe(`SELECT source_type AS "sourceType" FROM ws_source_action
     WHERE tenant_id=$1::uuid AND draft_id=$2::uuid`, input.tenantId, input.draftId);
    if (sources.length)
        unavailable();
    let role = draft.ownerId === input.clerkUserId ? 'owner' : null;
    if (!role) {
        const [collaborator] = await tx.$queryRawUnsafe(`SELECT role::text FROM ws_collaborator WHERE tenant_id=$1::uuid AND draft_id=$2::uuid
       AND subject_id=$3 AND status::text='active' FOR SHARE`, input.tenantId, input.draftId, input.clerkUserId);
        role = collaborator?.role ?? null;
    }
    if (!workspaceCanRead(role))
        unavailable();
    const [version] = await tx.$queryRawUnsafe(`SELECT id::text,author_id AS "authorId",author_kind::text AS "authorKind",
       created_at AS "createdAt",snapshot FROM ws_doc_version
     WHERE tenant_id=$1::uuid AND draft_id=$2::uuid AND id=$3::uuid FOR SHARE`, input.tenantId, input.draftId, input.versionId);
    if (!version)
        unavailable();
    const snapshotJson = canonicalWorkspaceSnapshot(version.snapshot);
    if (snapshotJson.length > 1_000_000)
        unavailable();
    const snap = object(version.snapshot), cfg = object(snap.config);
    const clientId = cfg.clientId ?? null;
    const currentClientId = object(draft.config).clientId ?? null;
    // Declarative context only: Core still checks the live client/wall and exact
    // session sponsor. Free-text draft.client never participates in authority.
    if (clientId !== null && (typeof clientId !== 'string' || !UUID.test(clientId)))
        unavailable();
    if (currentClientId !== null &&
        (typeof currentClientId !== 'string' || !UUID.test(currentClientId)))
        unavailable();
    if ((typeof clientId === 'string' ? clientId.toLowerCase() : null) !==
        (typeof currentClientId === 'string' ? currentClientId.toLowerCase() : null))
        unavailable();
    if (clientId === null &&
        [cfg, object(draft.config), { client: draft.client }].some(hasLegacyClientHints))
        unavailable();
    if (typeof clientId === 'string') {
        const [client] = await tx.$queryRawUnsafe(`SELECT memory_wall AS "memoryWall" FROM clients WHERE tenant_id=$1::uuid
       AND id=$2::uuid AND status::text<>'archived' FOR SHARE`, input.tenantId, clientId);
        if (!client)
            unavailable();
        if (client.memoryWall) {
            const grants = await tx.$queryRawUnsafe(`SELECT id FROM client_memory_access WHERE tenant_id=$1::uuid AND client_id=$2::uuid
         AND user_id=$3::uuid FOR SHARE`, input.tenantId, clientId, member.userId);
            if (!grants.length)
                unavailable();
        }
        if (!(await (0, client_memory_wall_js_1.clientMemoryAllowed)(tx, input.tenantId, member.userId, clientId)))
            unavailable();
    }
    const documents = snap.documents;
    if (!Array.isArray(documents) || !documents.length || documents.length > 100)
        unavailable();
    const body = documents
        .map((raw, index) => {
        const doc = object(raw);
        return workspaceDocumentText(doc.body, index === 0 ? cfg : {});
    })
        .filter(Boolean)
        .join('\n\n');
    const subject = typeof snap.docTitle === 'string' ? snap.docTitle : '';
    // SET_CONTENT_SKELETON is a literal user-authored projection here. A saved
    // document containing slot syntax cannot silently acquire template semantics.
    if (!body || body.length > 8_000 || subject.length > 400 || /\{\{|\}\}/.test(body + subject))
        unavailable();
    return {
        draftId: input.draftId.toLowerCase(),
        versionId: version.id.toLowerCase(),
        authorId: version.authorId,
        authorKind: version.authorKind,
        savedAt: version.createdAt.toISOString(),
        snapshot: version.snapshot,
        snapshotJson,
        clientId: typeof clientId === 'string' ? clientId.toLowerCase() : null,
        contentSkeleton: { subject, body, slots: [] },
    };
}
function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
/** Existing Workspace import text projection, shared with the staging owner. */
function workspaceHtmlToPlainText(html) {
    return html
        .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|section)\s*>|<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/[^\S\n]?\n[^\S\n]?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function workspaceDocumentText(body, draftConfig) {
    const rawBlocks = object(body).blocks;
    const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];
    const text = blocks
        .map((raw) => {
        const block = object(raw);
        return [block.title, block.content]
            .filter((s) => typeof s === 'string')
            .map(workspaceHtmlToPlainText)
            .filter(Boolean)
            .join('\n');
    })
        .filter(Boolean)
        .join('\n\n');
    if (text)
        return text;
    const cfg = object(draftConfig), content = object(cfg.sectionContent);
    const sections = Array.isArray(cfg.sections)
        ? cfg.sections.filter((s) => typeof s === 'string')
        : [];
    return (sections.length ? sections : Object.keys(content))
        .map((section) => {
        const text = typeof content[section] === 'string'
            ? workspaceHtmlToPlainText(content[section])
            : '';
        return text ? `${section}\n${text}` : '';
    })
        .filter(Boolean)
        .join('\n\n');
}
/** Legacy display/client-person steering never implies a firm-only source. */
function hasLegacyClientHints(config) {
    return ((typeof config.client === 'string' && !!config.client.trim()) ||
        config.clientAssociated === true ||
        (Array.isArray(config.clientPersons) && config.clientPersons.length > 0));
}
//# sourceMappingURL=workspace-saved-revision.js.map