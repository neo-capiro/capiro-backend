import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryPromotionClient } from './memory-promotion.client.js';

/**
 * Memory write-back (Phase 3.4): an EXPLICIT, user-triggered promotion of a
 * Workspace artifact's key fact/position into firm institutional memory —
 * separate from approving/exporting the artifact itself (blueprint §6.4: two
 * different decisions). Creates a firm-scope memory_candidate through apps/api's
 * internal endpoint (Phase 1 candidate lifecycle) — it lands 'pending' in the
 * admin review queue, never auto-committed, tagged 'workspace_artifact'.
 */
@Injectable()
export class MemoryPromotionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MemoryPromotionClient,
  ) {}

  async promoteDraft(
    tenantId: string,
    clerkUserId: string,
    draftId: string,
    note?: string,
  ): Promise<{ candidateId: string; status: string }> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      select: { id: true, product: true, docTitle: true, client: true },
    });
    if (!draft) throw new NotFoundException('Draft not found');

    // The user's note is the fact to remember; when omitted, fall back to a
    // lightweight context line so a promotion is never empty. Stable key per
    // draft so re-promoting the same artifact is recorded as a re-save (Phase 1
    // duplicate detection), not a silent double-write.
    const context = [draft.product, draft.docTitle && `"${draft.docTitle}"`]
      .filter(Boolean)
      .join(' ');
    const forClient = draft.client ? ` for client ${draft.client}` : '';
    const value =
      note?.trim() || `Produced ${context}${forClient} (promoted from Workspace as firm memory).`;

    return this.client.promote({
      tenantId,
      clerkUserId,
      key: `workspace-artifact:${draft.id}`,
      value,
      source: 'workspace',
    });
  }
}
