import type { ResourceScopeTransaction } from './client-memory-wall.js';

/** Workspace's bounded read/export ACL. Pending and unknown roles never grant access. */
export function workspaceCanRead(role: string | null): boolean {
  return role !== null && ['owner', 'editor', 'reviewer', 'commenter', 'viewer'].includes(role);
}

export class WorkspaceRevisionUnavailable extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function canonicalWorkspaceSnapshot(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalWorkspaceSnapshot).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalWorkspaceSnapshot(obj[k])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new WorkspaceRevisionUnavailable();
  return serialized;
}

/** Canonical Workspace version owner seam, called only inside an existing
 * tenant-scoped transaction. Locks remain held through the caller's command
 * commit. Core does not add ws_* ORM models or bypass source restrictions.
 * This first distribution slice supports ordinary manually editable drafts;
 * prospect and private Intel source drafts remain transfer-ineligible.
 */
export async function workspaceSavedOutreachRevisionWithinTx(
  tx: ResourceScopeTransaction,
  input: { tenantId: string; clerkUserId: string; userId?: string; draftId: string; versionId: string },
) {
  const unavailable = () => { throw new WorkspaceRevisionUnavailable(); };
  if (![input.tenantId, input.draftId, input.versionId].every((id) => UUID.test(id)) ||
      !input.clerkUserId || input.clerkUserId.length > 200 ||
      (input.userId !== undefined && !UUID.test(input.userId))) unavailable();
  const [tenant] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM tenants WHERE id=$1::uuid AND status::text='active' FOR SHARE`, input.tenantId,
  );
  if (!tenant) unavailable();
  const [member] = await tx.$queryRawUnsafe<Array<{ userId: string }>>(
    `SELECT u.id::text AS "userId" FROM tenant_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.tenant_id=$1::uuid AND m.status::text='active'
       AND m.role::text IN ('standard_user','user_admin','capiro_admin')
       AND u.clerk_user_id=$2 AND ($3::uuid IS NULL OR u.id=$3::uuid) FOR SHARE OF m,u`,
    input.tenantId, input.clerkUserId, input.userId ?? null,
  );
  if (!member) unavailable();
  const [draft] = await tx.$queryRawUnsafe<Array<{ ownerId: string; prospectId: string | null; config: unknown }>>(
    `SELECT owner_id AS "ownerId",prospect_id::text AS "prospectId",config FROM ws_draft
     WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE`, input.tenantId, input.draftId,
  );
  if (!draft || draft.prospectId) unavailable();
  // Canonical source creation commits this immutable receipt with a NEW draft.
  // The existing app role has SELECT/INSERT only here: a locking SELECT would
  // require an unauthorized UPDATE privilege. No later attachment path exists.
  const sources = await tx.$queryRawUnsafe<Array<{ sourceType: string }>>(
    `SELECT source_type AS "sourceType" FROM ws_source_action
     WHERE tenant_id=$1::uuid AND draft_id=$2::uuid
       AND source_type IN ('legiwatch_research','legiwatch_editorial')`,
    input.tenantId, input.draftId,
  );
  if (sources.length) unavailable();
  let role: string | null = draft!.ownerId === input.clerkUserId ? 'owner' : null;
  if (!role) {
    const [collaborator] = await tx.$queryRawUnsafe<Array<{ role: string }>>(
      `SELECT role::text FROM ws_collaborator WHERE tenant_id=$1::uuid AND draft_id=$2::uuid
       AND subject_id=$3 AND status::text='active' FOR SHARE`,
      input.tenantId, input.draftId, input.clerkUserId,
    );
    role = collaborator?.role ?? null;
  }
  if (!workspaceCanRead(role)) unavailable();
  const [version] = await tx.$queryRawUnsafe<Array<{
    id: string; authorId: string; authorKind: string; createdAt: Date; snapshot: unknown;
  }>>(
    `SELECT id::text,author_id AS "authorId",author_kind::text AS "authorKind",
       created_at AS "createdAt",snapshot FROM ws_doc_version
     WHERE tenant_id=$1::uuid AND draft_id=$2::uuid AND id=$3::uuid FOR SHARE`,
    input.tenantId, input.draftId, input.versionId,
  );
  if (!version) unavailable();
  const snapshotJson = canonicalWorkspaceSnapshot(version!.snapshot);
  if (snapshotJson.length > 1_000_000) unavailable();
  const snap = object(version!.snapshot), cfg = object(snap.config);
  const clientId = cfg.clientId ?? null;
  const currentClientId = object(draft!.config).clientId ?? null;
  // Declarative context only: Core still checks the live client/wall and exact
  // session sponsor. Free-text draft.client never participates in authority.
  if (clientId !== null && (typeof clientId !== 'string' || !UUID.test(clientId))) unavailable();
  if (currentClientId !== null && (typeof currentClientId !== 'string' || !UUID.test(currentClientId))) unavailable();
  if ((typeof clientId === 'string' ? clientId.toLowerCase() : null) !==
      (typeof currentClientId === 'string' ? currentClientId.toLowerCase() : null)) unavailable();
  const documents = snap.documents;
  if (!Array.isArray(documents) || !documents.length || documents.length > 100) unavailable();
  const body = (documents as unknown[]).map((raw, index) => {
    const doc = object(raw);
    return workspaceDocumentText(doc.body, index === 0 ? cfg : {});
  }).filter(Boolean).join('\n\n');
  const subject = typeof snap.docTitle === 'string' ? snap.docTitle : '';
  // SET_CONTENT_SKELETON is a literal user-authored projection here. A saved
  // document containing slot syntax cannot silently acquire template semantics.
  if (!body || body.length > 8_000 || subject.length > 400 || /\{\{|\}\}/.test(body + subject)) unavailable();
  return {
    draftId: input.draftId.toLowerCase(), versionId: version!.id.toLowerCase(),
    authorId: version!.authorId, authorKind: version!.authorKind,
    savedAt: version!.createdAt.toISOString(), snapshot: version!.snapshot, snapshotJson,
    clientId: typeof clientId === 'string' ? clientId.toLowerCase() : null,
    contentSkeleton: { subject, body, slots: [] },
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Existing Workspace import text projection, shared with the staging owner. */
export function workspaceHtmlToPlainText(html: string): string {
  return html.replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|section)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[^\S\n]+/g, ' ').replace(/[^\S\n]?\n[^\S\n]?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function workspaceDocumentText(body: unknown, draftConfig: unknown): string {
  const rawBlocks = object(body).blocks;
  const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];
  const text = blocks.map((raw) => {
    const block = object(raw);
    return [block.title, block.content].filter((s): s is string => typeof s === 'string')
      .map(workspaceHtmlToPlainText).filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
  if (text) return text;
  const cfg = object(draftConfig), content = object(cfg.sectionContent);
  const sections = Array.isArray(cfg.sections) ? cfg.sections.filter((s): s is string => typeof s === 'string') : [];
  return (sections.length ? sections : Object.keys(content)).map((section) => {
    const text = typeof content[section] === 'string' ? workspaceHtmlToPlainText(content[section] as string) : '';
    return text ? `${section}\n${text}` : '';
  }).filter(Boolean).join('\n\n');
}
