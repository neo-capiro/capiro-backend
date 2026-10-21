import { ConflictException, NotFoundException } from '@nestjs/common';
import { canonicalWorkspaceSnapshot } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { readAgentState } from '../document-agent/document-agent-state.js';

/** Release decisions always refer to one saved revision, never the live draft. */
export async function releaseVersion(prisma: PrismaService, tenantId: string, draftId: string, versionId: string | null | undefined, current = true) {
  if (!versionId) throw new ConflictException('Save and select a revision before requesting approval or sharing');
  const draft = await prisma.wsDraft.findFirst({ where: { id: draftId, tenantId, prospectId: null }, include: { documents: { orderBy: { ordinal: 'asc' } } } });
  const version = await prisma.wsDocVersion.findFirst({ where: { id: versionId, tenantId, draftId } });
  if (!draft || !version) throw new NotFoundException('Saved revision not found');
  const snapshot = version.snapshot as Record<string, unknown>;
  if (!snapshot || typeof snapshot !== 'object') throw new ConflictException('Saved revision is invalid');
  if (current) {
    const live = { docTitle: draft.docTitle, config: draft.config, ask: draft.ask,
      documents: draft.documents.map(d => ({ id: d.id, name: d.name, ordinal: d.ordinal, body: d.body })) };
    if (canonicalWorkspaceSnapshot(snapshot) !== canonicalWorkspaceSnapshot(live))
      throw new ConflictException('The document changed. Save and review its current revision');
  }
  const state = readAgentState((snapshot.config ?? {}) as Record<string, unknown>);
  let policy = { clientFacingApprovalRequired: false, permittedApproverRoles: [] as string[] };
  if (state.blueprintPin) {
    const blueprint = await prisma.wsBlueprintVersion.findFirst({ where: { id: state.blueprintPin.versionId, tenantId } });
    if (!blueprint) throw new ConflictException('Pinned approval policy is unavailable');
    const definition = blueprint.definition as { approvalPolicy?: typeof policy };
    if (definition.approvalPolicy) policy = definition.approvalPolicy;
  }
  return { draft, version, policy };
}

export async function requireReleasedApproval(prisma: PrismaService, tenantId: string, draftId: string, versionId: string, policy: { clientFacingApprovalRequired: boolean }) {
  if (!policy.clientFacingApprovalRequired) return;
  const approval = await prisma.wsApprovalRequest.findFirst({ where: { tenantId, draftId, versionId, status: 'approved' } });
  if (!approval) throw new ConflictException('This exact saved revision requires approval before sharing');
}
