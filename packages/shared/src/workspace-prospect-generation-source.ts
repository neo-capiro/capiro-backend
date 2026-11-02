/** Server-only source owner shared by Workspace generation and Core authority.
 * Existing draft ACLs, prospect restrictions and immutable versions remain the
 * authority. This module never grants transfer or creates a client association. */
import { createHash } from 'node:crypto';
import type { ResourceScopeTransaction } from './client-memory-wall.js';
import { prospectResourceScope, type ProspectResourceActor } from './prospect-resource-scope.js';
import { canonicalWorkspaceSnapshot, workspaceCanRead, WorkspaceRevisionUnavailable } from './workspace-saved-revision.js';

export const WORKSPACE_PROSPECT_GENERATION = 'workspaceProspectGeneration' as const;
export interface WorkspaceProspectGenerationSource {
  schemaVersion: 1;
  requestId: string;
  draftId: string;
  prospectId: string;
  sourceVersionId: string;
  sourceSnapshotHash: string;
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const unavailable = (): never => { throw new WorkspaceRevisionUnavailable(); };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: unknown) => createHash('sha256').update(canonicalWorkspaceSnapshot(value)).digest('hex');

export function parseWorkspaceProspectGenerationSource(value: unknown): WorkspaceProspectGenerationSource {
  const source = object(value);
  if (Object.keys(source).sort().join() !== 'draftId,prospectId,requestId,schemaVersion,sourceSnapshotHash,sourceVersionId' ||
      source.schemaVersion !== 1 || typeof source.requestId !== 'string' || !/^wsgen:[a-f0-9]{64}$/.test(source.requestId) ||
      !['draftId', 'prospectId', 'sourceVersionId'].every(key => typeof source[key] === 'string' && uuid.test(source[key] as string)) ||
      typeof source.sourceSnapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceSnapshotHash)) unavailable();
  return source as unknown as WorkspaceProspectGenerationSource;
}

/** Frozen private wire identity; parity is exercised against the native leaf. */
export function workspaceGenerationConversationId(requestId: string): string {
  const hex = /^wsgen:([a-f0-9]{64})$/.exec(requestId)?.[1];
  if (!hex) return unavailable();
  const digest = createHash('sha256').update(`meri.workspace-generation.conversation.v1\0${hex}`).digest('hex');
  const variant = ((parseInt(digest[16]!, 16) & 3) | 8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Caller supplies its existing tenant transaction. Read-only authority probes
 * opt out of row locks; commands keep them through their local commit. Only
 * atomic prospect saves qualify: generic versions and publications cannot be
 * reinterpreted as source saves, including versions of copied brief documents. */
export async function workspaceProspectGenerationSourceWithinTx(
  tx: ResourceScopeTransaction,
  tenantId: string,
  actor: ProspectResourceActor,
  raw: unknown,
  options: { lock?: boolean; edit?: boolean } = {},
) {
  const source = parseWorkspaceProspectGenerationSource(raw);
  if (!uuid.test(tenantId)) return unavailable();
  const scope = await prospectResourceScope(tx, tenantId, actor, source.prospectId, 'write', options);
  if (!scope) return unavailable();
  const share = options.lock === false ? '' : ' FOR SHARE';
  const [draft] = await tx.$queryRawUnsafe<Array<{ ownerId: string; prospectId: string | null; clientId: string | null }>>(
    `SELECT owner_id AS "ownerId",prospect_id::text AS "prospectId",client_id::text AS "clientId"
     FROM ws_draft WHERE tenant_id=$1::uuid AND id=$2::uuid${share}`, tenantId, source.draftId);
  if (!draft || draft.prospectId !== source.prospectId || draft.clientId !== null) return unavailable();
  let role: string | null = draft.ownerId === scope.clerkUserId ? 'owner' : null;
  if (!role) {
    const [collaborator] = await tx.$queryRawUnsafe<Array<{ role: string }>>(
      `SELECT role::text FROM ws_collaborator WHERE tenant_id=$1::uuid AND draft_id=$2::uuid
       AND subject_id=$3 AND status::text='active'${share}`, tenantId, source.draftId, scope.clerkUserId);
    role = collaborator?.role ?? null;
  }
  if (!workspaceCanRead(role) || (options.edit && role !== 'owner' && role !== 'editor')) return unavailable();
  const [version] = await tx.$queryRawUnsafe<Array<{ snapshot: unknown }>>(
    `SELECT snapshot FROM ws_doc_version WHERE tenant_id=$1::uuid AND draft_id=$2::uuid AND id=$3::uuid`,
    tenantId, source.draftId, source.sourceVersionId);
  if (!version) return unavailable();
  const saved = object(version.snapshot), { atomicSave, ...content } = saved, receipt = object(atomicSave);
  if (Buffer.byteLength(canonicalWorkspaceSnapshot(saved)) > 1_000_000 ||
      hash(saved) !== source.sourceSnapshotHash || saved.prospectPublication !== undefined ||
      receipt.operation !== 'save_prospect_draft' || receipt.tenantId !== tenantId || receipt.draftId !== source.draftId ||
      receipt.prospectId !== source.prospectId || receipt.requestId !== source.sourceVersionId || receipt.clientId !== null ||
      content.prospectId !== source.prospectId || content.clientId !== null || hash(content) !== receipt.stateHash) return unavailable();
  return { source, scope, role, snapshot: saved, content, stateHash: receipt.stateHash as string };
}
