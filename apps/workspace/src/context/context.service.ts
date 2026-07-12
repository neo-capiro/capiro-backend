import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
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
  constructor(private readonly prisma: PrismaService) {}

  private async assertDraft(tenantId: string, draftId: string) {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new NotFoundException('Draft not found');
    return draft;
  }

  async listItems(tenantId: string, draftId: string) {
    await this.assertDraft(tenantId, draftId);
    return this.prisma.wsContextItem.findMany({
      where: { tenantId, draftId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addItem(tenantId: string, draftId: string, dto: AddContextItemDto) {
    await this.assertDraft(tenantId, draftId);
    return this.prisma.wsContextItem.create({
      data: { tenantId, draftId, kind: dto.kind, payload: dto.payload as never },
    });
  }

  async removeItem(
    tenantId: string,
    draftId: string,
    itemId: string,
  ): Promise<{ deleted: boolean }> {
    await this.assertDraft(tenantId, draftId);
    const existing = await this.prisma.wsContextItem.findFirst({
      where: { id: itemId, tenantId, draftId },
    });
    if (!existing) throw new NotFoundException('Context item not found');
    await this.prisma.wsContextItem.delete({ where: { id: itemId } });
    return { deleted: true };
  }
}
