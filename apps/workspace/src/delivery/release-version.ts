import { ConflictException, NotFoundException } from '@nestjs/common';
import { canonicalWorkspaceSnapshot } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertDraftClientReleaseAllowed } from '../drafts/draft-client-access.js';

/** Release decisions always refer to one saved revision, never the live draft. */
export async function releaseVersion(prisma: Pick<PrismaService, 'wsDraft' | 'wsDocVersion'>, tenantId: string, draftId: string, versionId: string | null | undefined, current = true) {
  if (!versionId) throw new ConflictException('Save and select a revision before sharing');
  const draft = await prisma.wsDraft.findFirst({ where: { id: draftId, tenantId, prospectId: null }, include: { documents: { orderBy: { ordinal: 'asc' } } } });
  const version = await prisma.wsDocVersion.findFirst({ where: { id: versionId, tenantId, draftId } });
  if (!draft || !version) throw new NotFoundException('Saved revision not found');
  assertDraftClientReleaseAllowed(draft);
  const snapshot = version.snapshot as Record<string, unknown>;
  if (!snapshot || typeof snapshot !== 'object') throw new ConflictException('Saved revision is invalid');
  if (current) {
    const live = { docTitle: draft.docTitle, config: draft.config, ask: draft.ask,
      documents: draft.documents.map(d => ({ id: d.id, name: d.name, ordinal: d.ordinal, body: d.body })) };
    if (canonicalWorkspaceSnapshot(snapshot) !== canonicalWorkspaceSnapshot(live))
      throw new ConflictException('The document changed. Save and review its current revision');
  }
  return { draft, version };
}
