import { clientMemoryAllowed, type ResourceScopeTransaction } from './client-memory-wall.js';

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
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalWorkspaceSnapshot(obj[k])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new WorkspaceRevisionUnavailable();
  return serialized;
}

/** Canonical Workspace version owner seam, called only inside an existing
 * tenant-scoped transaction. Locks remain held through the caller's command
 * commit. Core does not add ws_* ORM models or bypass source restrictions.
 * This first distribution slice supports ordinary manually editable drafts;
 * prospect and any receipt-backed Intel source draft remain transfer-ineligible.
 */
export async function workspaceSavedOutreachRevisionWithinTx(
  tx: ResourceScopeTransaction,
  input: {
    tenantId: string;
    clerkUserId: string;
    userId?: string;
    draftId: string;
    versionId: string;
    /** Original algorithm only for an existing staging receipt's exact replay. */
    projectionVersion?: 'workspace-outreach-plaintext-v1' | 'workspace-newsletter-plaintext-v2';
  },
) {
  const unavailable = () => {
    throw new WorkspaceRevisionUnavailable();
  };
  if (
    ![input.tenantId, input.draftId, input.versionId].every((id) => UUID.test(id)) ||
    !input.clerkUserId ||
    input.clerkUserId.length > 200 ||
    (input.userId !== undefined && !UUID.test(input.userId))
  )
    unavailable();
  const [tenant] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM tenants WHERE id=$1::uuid AND status::text='active' FOR SHARE`,
    input.tenantId,
  );
  if (!tenant) unavailable();
  const [member] = await tx.$queryRawUnsafe<Array<{ userId: string }>>(
    `SELECT u.id::text AS "userId" FROM tenant_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.tenant_id=$1::uuid AND m.status::text='active'
       AND m.role::text IN ('standard_user','user_admin','capiro_admin')
       AND u.clerk_user_id=$2 AND ($3::uuid IS NULL OR u.id=$3::uuid) FOR SHARE OF m,u`,
    input.tenantId,
    input.clerkUserId,
    input.userId ?? null,
  );
  if (!member) unavailable();
  await tx.$queryRawUnsafe(`SELECT set_config('app.current_user',$1,true)`, member!.userId);
  const [draft] = await tx.$queryRawUnsafe<
    Array<{
      ownerId: string;
      prospectId: string | null;
      config: unknown;
      client: string | null;
      clientId: string | null;
    }>
  >(
    `SELECT owner_id AS "ownerId",prospect_id::text AS "prospectId",config,client,
       client_id::text AS "clientId" FROM ws_draft
     WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE`,
    input.tenantId,
    input.draftId,
  );
  if (!draft || draft.prospectId) unavailable();
  // Canonical source creation commits this immutable receipt with a NEW draft.
  // The existing app role has SELECT/INSERT only here: a locking SELECT would
  // require an unauthorized UPDATE privilege. No later attachment path exists.
  const sources = await tx.$queryRawUnsafe<Array<{ sourceType: string }>>(
    `SELECT source_type AS "sourceType" FROM ws_source_action
     WHERE tenant_id=$1::uuid AND draft_id=$2::uuid`,
    input.tenantId,
    input.draftId,
  );
  if (sources.length) unavailable();
  let role: string | null = draft!.ownerId === input.clerkUserId ? 'owner' : null;
  if (!role) {
    const [collaborator] = await tx.$queryRawUnsafe<Array<{ role: string }>>(
      `SELECT role::text FROM ws_collaborator WHERE tenant_id=$1::uuid AND draft_id=$2::uuid
       AND subject_id=$3 AND status::text='active' FOR SHARE`,
      input.tenantId,
      input.draftId,
      input.clerkUserId,
    );
    role = collaborator?.role ?? null;
  }
  if (!workspaceCanRead(role)) unavailable();
  const [version] = await tx.$queryRawUnsafe<
    Array<{
      id: string;
      authorId: string;
      authorKind: string;
      createdAt: Date;
      snapshot: unknown;
    }>
  >(
    `SELECT id::text,author_id AS "authorId",author_kind::text AS "authorKind",
       created_at AS "createdAt",snapshot FROM ws_doc_version
     WHERE tenant_id=$1::uuid AND draft_id=$2::uuid AND id=$3::uuid FOR SHARE`,
    input.tenantId,
    input.draftId,
    input.versionId,
  );
  if (!version) unavailable();
  const snapshotJson = canonicalWorkspaceSnapshot(version!.snapshot);
  if (snapshotJson.length > 1_000_000) unavailable();
  const snap = object(version!.snapshot),
    cfg = object(snap.config);
  const clientId = cfg.clientId ?? null;
  const currentClientId = draft!.clientId;
  const configuredClientId = object(draft!.config).clientId ?? null;
  // Declarative context only: Core still checks the live client/wall and exact
  // session sponsor. Free-text draft.client never participates in authority.
  if (clientId !== null && (typeof clientId !== 'string' || !UUID.test(clientId))) unavailable();
  if (
    [currentClientId, configuredClientId].some(
      (id) => id !== null && (typeof id !== 'string' || !UUID.test(id)),
    )
  )
    unavailable();
  if (
    (typeof clientId === 'string' ? clientId.toLowerCase() : null) !==
      (typeof currentClientId === 'string' ? currentClientId.toLowerCase() : null) ||
    (typeof configuredClientId === 'string' ? configuredClientId.toLowerCase() : null) !==
      (typeof currentClientId === 'string' ? currentClientId.toLowerCase() : null)
  )
    unavailable();
  if (
    clientId === null &&
    [cfg, object(draft!.config), { client: draft!.client }].some(hasLegacyClientHints)
  )
    unavailable();
  if (typeof clientId === 'string') {
    const [client] = await tx.$queryRawUnsafe<Array<{ memoryWall: boolean }>>(
      `SELECT memory_wall AS "memoryWall" FROM clients WHERE tenant_id=$1::uuid
       AND id=$2::uuid AND status::text<>'archived' FOR SHARE`,
      input.tenantId,
      clientId,
    );
    if (!client) unavailable();
    if (client!.memoryWall) {
      const grants = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM client_memory_access WHERE tenant_id=$1::uuid AND client_id=$2::uuid
         AND user_id=$3::uuid FOR SHARE`,
        input.tenantId,
        clientId,
        member!.userId,
      );
      if (!grants.length) unavailable();
    }
    if (!(await clientMemoryAllowed(tx, input.tenantId, member!.userId, clientId))) unavailable();
  }
  const documents = snap.documents;
  if (!Array.isArray(documents) || !documents.length || documents.length > 100) unavailable();
  const newsletters = (documents as unknown[]).filter((doc) =>
    Object.prototype.hasOwnProperty.call(object(object(doc).body), 'newsletter'),
  );
  const isNewsletter = cfg.product === 'Newsletter' || newsletters.length > 0;
  const projectionVersion =
    input.projectionVersion ??
    (isNewsletter ? 'workspace-newsletter-plaintext-v2' : 'workspace-outreach-plaintext-v1');
  // v1 remains immutable for historical staging requests. The chooser defaults
  // to v2 for Newsletter and cannot fall back to generic blocks on malformed data.
  const projected =
    projectionVersion === 'workspace-newsletter-plaintext-v2'
      ? newsletterPlainText(newsletters)
      : {
          body: (documents as unknown[])
            .map((raw, index) => {
              const doc = object(raw);
              return workspaceDocumentText(doc.body, index === 0 ? cfg : {});
            })
            .filter(Boolean)
            .join('\n\n'),
          subject: typeof snap.docTitle === 'string' ? snap.docTitle : '',
        };
  const { body, subject } = projected;
  // SET_CONTENT_SKELETON is a literal user-authored projection here. A saved
  // document containing slot syntax cannot silently acquire template semantics.
  if (!body || body.length > 8_000 || subject.length > 400 || /\{\{|\}\}/.test(body + subject))
    unavailable();
  const contentSkeleton = { subject, body, slots: [] };
  return {
    draftId: input.draftId.toLowerCase(),
    versionId: version!.id.toLowerCase(),
    authorId: version!.authorId,
    authorKind: version!.authorKind,
    savedAt: version!.createdAt.toISOString(),
    snapshot: version!.snapshot,
    snapshotJson,
    clientId: typeof clientId === 'string' ? clientId.toLowerCase() : null,
    contentSkeleton,
    projectionVersion,
    // SHA-256 of these UTF-8 canonical bytes is computed by the server caller,
    // just like snapshotJson. Keep Node crypto out of the shared browser barrel.
    projectionJson: canonicalWorkspaceSnapshot({ projectionVersion, contentSkeleton }),
  };
}

/** Basic Newsletter's saved authored fields, never the derived generic blocks.
 * Lengths are UTF-16 code units, as in the existing skeleton contract. Subject
 * trim and CRLF/body trailing-space normalization match that command owner.
 * Images/logos/layout and preview/firm footer metadata are not plaintext blocks.
 */
function newsletterPlainText(documents: unknown[]): { subject: string; body: string } {
  const refuse = (): never => {
    throw new WorkspaceRevisionUnavailable();
  };
  if (documents.length !== 1) refuse();
  const saved = object(object(object(documents[0]).body).newsletter);
  const fields = { subject: 400, preview: 500, firmName: 200, mailingAddress: 500 };
  if (Object.keys(saved).some((key) => ![...Object.keys(fields), 'blocks'].includes(key))) refuse();
  for (const [key, max] of Object.entries(fields)) {
    if (typeof saved[key] !== 'string' || (saved[key] as string).length > max) refuse();
  }
  if (!Array.isArray(saved.blocks) || saved.blocks.length > 100) refuse();
  const ids = new Set<string>();
  const body = (saved.blocks as unknown[])
    .map((raw) => {
      const block = object(raw);
      if (
        Object.keys(block).some((key) => !['id', 'kind', 'text', 'href'].includes(key)) ||
        typeof block.id !== 'string' ||
        !block.id ||
        block.id.length > 64 ||
        ids.has(block.id) ||
        typeof block.kind !== 'string' ||
        ![
          'heading',
          'paragraph',
          'button',
          'divider',
          'spacer',
          'image',
          'social',
          'logo',
          'code',
        ].includes(block.kind) ||
        typeof block.text !== 'string' ||
        block.text.length > 20_000 ||
        (block.href !== undefined && (typeof block.href !== 'string' || block.href.length > 2048))
      )
        refuse();
      ids.add(block.id as string);
      if (['image', 'logo', 'divider', 'spacer'].includes(block.kind as string)) return '';
      return block.kind === 'button' && block.href
        ? `${block.text}: ${block.href}`
        : (block.text as string);
    })
    .filter(Boolean)
    .join('\n\n');
  if (
    body.length > 8_000 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(body + saved.subject)
  )
    refuse();
  const normalized = body.replace(/\r\n?/g, '\n').trimEnd();
  if (!normalized.trim()) refuse();
  return { subject: (saved.subject as string).replace(/\r\n?/g, '\n').trim(), body: normalized };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Existing Workspace import text projection, shared with the staging owner. */
export function workspaceHtmlToPlainText(html: string): string {
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
export function workspaceDocumentText(body: unknown, draftConfig: unknown): string {
  const rawBlocks = object(body).blocks;
  const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];
  const text = blocks
    .map((raw) => {
      const block = object(raw);
      return [block.title, block.content]
        .filter((s): s is string => typeof s === 'string')
        .map(workspaceHtmlToPlainText)
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
  if (text) return text;
  const cfg = object(draftConfig),
    content = object(cfg.sectionContent);
  const sections = Array.isArray(cfg.sections)
    ? cfg.sections.filter((s): s is string => typeof s === 'string')
    : [];
  return (sections.length ? sections : Object.keys(content))
    .map((section) => {
      const text =
        typeof content[section] === 'string'
          ? workspaceHtmlToPlainText(content[section] as string)
          : '';
      return text ? `${section}\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Legacy display/client-person steering never implies a firm-only source. */
function hasLegacyClientHints(config: Record<string, unknown>): boolean {
  return (
    (typeof config.client === 'string' && !!config.client.trim()) ||
    config.clientAssociated === true ||
    (Array.isArray(config.clientPersons) && config.clientPersons.length > 0)
  );
}
