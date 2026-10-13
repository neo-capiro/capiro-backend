import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  prospectResourceScope,
  prospectBriefVersionIdentity,
  prospectBriefSourceWithinTx,
  ProspectBriefSourceUnavailable,
  MAX_PROSPECT_BRIEF_COPIES,
  canonicalWorkspaceSnapshot,
} from '@capiro/shared';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { canRead, type ResolvedRole } from '../collaborators/role-policy.js';

type DraftOrigin = { id: string; tenantId: string; prospectId?: string | null };
type Policy = (role: ResolvedRole) => boolean;

/** Core owns identity/conversion/client walls; Workspace owns draft/collaborator ACL.
 * No cross-Core ORM model, RLS bypass, external share or implicit collaborator grant.
 */
export async function requireProspectDraftScopeInTx(
  tx: Prisma.TransactionClient,
  draft: DraftOrigin,
  actorId: string | undefined,
  policy: Policy = canRead,
  mode: 'read' | 'write' = 'read',
) {
  if (!draft.prospectId) return;
  if (!actorId) throw new NotFoundException('Draft not found');
  await tx.$executeRaw`SELECT set_config('app.current_tenant',${draft.tenantId},true)`;
  const scope = await prospectResourceScope(
    tx,
    draft.tenantId,
    { clerkUserId: actorId },
    draft.prospectId,
    mode,
  );
  if (!scope) throw new NotFoundException('Draft not found');
  const rows = await tx.$queryRaw<Array<{ ownerId: string; prospectId: string }>>`
    SELECT owner_id AS "ownerId",prospect_id::text AS "prospectId" FROM ws_draft
    WHERE tenant_id=${draft.tenantId}::uuid AND id=${draft.id}::uuid FOR UPDATE`;
  if (!rows[0] || rows[0].prospectId !== draft.prospectId)
    throw new NotFoundException('Draft not found');
  let role: ResolvedRole = rows[0].ownerId === actorId ? 'owner' : null;
  if (!role) {
    const collaborators = await tx.$queryRaw<
      Array<{ role: Exclude<ResolvedRole, 'owner' | null> }>
    >`
      SELECT role::text FROM ws_collaborator WHERE tenant_id=${draft.tenantId}::uuid
      AND draft_id=${draft.id}::uuid AND subject_id=${actorId} AND status::text='active' FOR SHARE`;
    role = collaborators[0]?.role ?? null;
  }
  if (!policy(role)) throw new NotFoundException('Draft not found');
  // Copied brief content retains the Core brief flag and exact saved-source
  // authority on every existing Workspace read/write, not only the copy route.
  const copies = await tx.$queryRaw<Array<{ sourceBriefVersion: unknown }>>`
    SELECT source_brief_version AS "sourceBriefVersion" FROM ws_document
    WHERE tenant_id=${draft.tenantId}::uuid AND draft_id=${draft.id}::uuid
      AND source_brief_version IS NOT NULL ORDER BY id LIMIT ${MAX_PROSPECT_BRIEF_COPIES + 1}`;
  try {
    if (copies.length > MAX_PROSPECT_BRIEF_COPIES) throw new ProspectBriefSourceUnavailable();
    const unique = new Map(
      copies.map((copy) => [canonicalWorkspaceSnapshot(copy.sourceBriefVersion), copy]),
    );
    for (const copy of unique.values())
      await prospectBriefSourceWithinTx(
        tx,
        scope,
        prospectBriefVersionIdentity(copy.sourceBriefVersion),
      );
  } catch (error) {
    if (error instanceof ProspectBriefSourceUnavailable)
      throw new NotFoundException('Draft not found');
    throw error;
  }
  return scope;
}

/** Preserve the existing void-return contract for all established callers. */
export async function requireProspectDraftInTx(
  tx: Prisma.TransactionClient,
  draft: DraftOrigin,
  actorId: string | undefined,
  policy: Policy = canRead,
  mode: 'read' | 'write' = 'read',
): Promise<void> {
  await requireProspectDraftScopeInTx(tx, draft, actorId, policy, mode);
}

/** The callback performs the existing operation; prospect authorization and its
 * mutation/read commit together. Legacy drafts retain their existing path. */
export async function withProspectDraft<T>(
  prisma: PrismaService,
  draft: DraftOrigin,
  actorId: string | undefined,
  policy: Policy,
  mode: 'read' | 'write',
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!draft.prospectId) return operation(prisma);
  return prisma.$transaction(async (tx) => {
    await requireProspectDraftInTx(tx, draft, actorId, policy, mode);
    return operation(tx);
  });
}

export async function assertProspectDraft(
  prisma: PrismaService,
  draft: DraftOrigin,
  actorId?: string,
  policy: Policy = canRead,
) {
  await withProspectDraft(prisma, draft, actorId, policy, 'read', async () => undefined);
}

/** Legacy body mutation/restore cannot bypass the copy's atomic save receipt.
 * Check inside the existing parent lock; a pre-lock read can miss a new copy. */
export async function assertNoBoundBriefCopy(
  tx: Prisma.TransactionClient,
  tenantId: string,
  draftId: string,
  documentId?: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM ws_document WHERE tenant_id=${tenantId}::uuid AND draft_id=${draftId}::uuid
      AND source_brief_version IS NOT NULL
      AND (${documentId ?? null}::text IS NULL OR id::text=lower(${documentId ?? null}::text)) LIMIT 1`;
  if (rows.length)
    throw new ConflictException({
      code: 'WORKSPACE_BRIEF_ATOMIC_SAVE_REQUIRED',
    });
}

/** Source access is an AND with existing owner/collaborator resolution, but is
 * also used for invitation eligibility before an active collaborator exists. */
export async function prospectDraftSourceAccess(
  prisma: PrismaService,
  draft: DraftOrigin,
  actorId: string,
) {
  if (!draft.prospectId) return true;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant',${draft.tenantId},true)`;
    return Boolean(
      await prospectResourceScope(tx, draft.tenantId, { clerkUserId: actorId }, draft.prospectId!),
    );
  });
}

export function denyProspectTransfer(
  draft: { prospectId?: string | null } | null | undefined,
): void {
  if (draft?.prospectId)
    throw new ForbiddenException({ code: 'PROSPECT_RESOURCE_TRANSFER_UNSUPPORTED' });
}

export function assertImmutableProspectInput(dto: unknown): void {
  if (dto && typeof dto === 'object' && Object.prototype.hasOwnProperty.call(dto, 'prospectId'))
    throw new ConflictException({ code: 'PROSPECT_ORIGIN_IMMUTABLE' });
}

/** Pending invitations have a separate acceptance boundary: current Core scope
 * and the exact addressed invitation; no implicit document-read entitlement. */
export async function withProspectInvitation<T>(
  prisma: PrismaService,
  draft: DraftOrigin,
  actorId: string,
  collaboratorId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!draft.prospectId) return operation(prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant',${draft.tenantId},true)`;
    if (
      !(await prospectResourceScope(
        tx,
        draft.tenantId,
        { clerkUserId: actorId },
        draft.prospectId!,
      ))
    )
      throw new NotFoundException('Invitation not found');
    const origins = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ws_draft WHERE tenant_id=${draft.tenantId}::uuid AND id=${draft.id}::uuid
      AND prospect_id=${draft.prospectId}::uuid FOR UPDATE`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ws_collaborator WHERE tenant_id=${draft.tenantId}::uuid AND draft_id=${draft.id}::uuid
      AND id=${collaboratorId}::uuid AND subject_id=${actorId} AND status::text IN ('pending','active') FOR UPDATE`;
    if (!origins.length || !rows.length) throw new NotFoundException('Invitation not found');
    return operation(tx);
  });
}

export async function requireProspectInvitee(
  tx: Prisma.TransactionClient,
  draft: DraftOrigin,
  subjectId: string | null,
) {
  if (!draft.prospectId) return;
  if (
    !subjectId ||
    !(await prospectResourceScope(tx, draft.tenantId, { clerkUserId: subjectId }, draft.prospectId))
  )
    throw new NotFoundException('Eligible teammate not found');
}
