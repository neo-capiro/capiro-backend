import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit, canRead, type ResolvedRole } from '../collaborators/role-policy.js';
import type { AddContextItemDto } from './dto/context.dto.js';

/**
 * Build Context (Phase 3, AC-3.6). Per-draft free-text / structured grounding
 * items (ws_context_item) the user attaches for Meri generation.
 *
 * NOTE (Phase 3 cleanup, 2026-07-12): the old client/office-scoped `sources()`
 * and `news()` catalog stubs (flagged `mock: true`) were removed — they were
 * never wired to real data and the Context Builder UI sources real client data
 * from the main api directly (see apps/web/src/pages/workspace/api.ts), so
 * nothing consumed them. Only the draft-scoped item CRUD below remains.
 */
@Injectable()
export class ContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
  ) {}

  /**
   * Tenant-scope the draft, then — when the controller supplies actorId —
   * enforce the private-draft ACL (GAI-31): tenant scope alone is NOT object
   * authorization. `predicate` is canRead for listing, canEdit for mutations
   * (adding context poisons the model prompt; removing it alters generation
   * input). Internal callers omit actorId.
   */
  private async assertDraft(
    tenantId: string,
    draftId: string,
    actorId?: string,
    predicate: (role: ResolvedRole) => boolean = canRead,
  ) {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new NotFoundException('Draft not found');
    if (actorId) {
      await this.collaborators.assertCan(
        tenantId,
        draftId,
        actorId,
        predicate,
        'You do not have permission to access this document',
      );
    }
    return draft;
  }

  async listItems(tenantId: string, draftId: string, actorId?: string) {
    await this.assertDraft(tenantId, draftId, actorId, canRead);
    return this.prisma.wsContextItem.findMany({
      where: { tenantId, draftId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addItem(tenantId: string, draftId: string, dto: AddContextItemDto, actorId?: string) {
    await this.assertDraft(tenantId, draftId, actorId, canEdit);
    return this.prisma.wsContextItem.create({
      data: { tenantId, draftId, kind: dto.kind, payload: dto.payload as never },
    });
  }

  async removeItem(
    tenantId: string,
    draftId: string,
    itemId: string,
    actorId?: string,
  ): Promise<{ deleted: boolean }> {
    await this.assertDraft(tenantId, draftId, actorId, canEdit);
    const existing = await this.prisma.wsContextItem.findFirst({
      where: { id: itemId, tenantId, draftId },
    });
    if (!existing) throw new NotFoundException('Context item not found');
    await this.prisma.wsContextItem.delete({ where: { id: itemId } });
    return { deleted: true };
  }
}
