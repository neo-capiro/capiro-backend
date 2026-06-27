import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit } from '../collaborators/role-policy.js';
import type { CreateDocumentDto, UpdateDocumentDto } from './dto/document.dto.js';

/**
 * Packet document tabs (Phase 3, AC-3.4 / handoff §12.12). Each tab is a
 * first-class WsDocument. Adding a 2nd+ tab flips the parent draft to a packet.
 * No cap on tabs. All operations tenant-scoped + verify the draft belongs to
 * the tenant before mutating.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
  ) {}

  private async assertDraft(tenantId: string, draftId: string) {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new NotFoundException('Draft not found');
    return draft;
  }

  /** Editing document tabs (add/update/remove) is owner + editor only. */
  private async assertCanEdit(tenantId: string, draftId: string, actorId: string) {
    await this.collaborators.assertCan(
      tenantId,
      draftId,
      actorId,
      canEdit,
      'Only owners and editors can edit this document',
    );
  }

  async list(tenantId: string, draftId: string) {
    await this.assertDraft(tenantId, draftId);
    return this.prisma.wsDocument.findMany({
      where: { tenantId, draftId },
      orderBy: { ordinal: 'asc' },
    });
  }

  async add(tenantId: string, draftId: string, actorId: string, dto: CreateDocumentDto) {
    await this.assertDraft(tenantId, draftId);
    await this.assertCanEdit(tenantId, draftId, actorId);
    const count = await this.prisma.wsDocument.count({ where: { tenantId, draftId } });
    const doc = await this.prisma.wsDocument.create({
      data: {
        tenantId,
        draftId,
        name: dto.name,
        ordinal: dto.ordinal ?? count,
        body: (dto.body ?? { blocks: [] }) as never,
      },
    });
    await this.syncPacket(tenantId, draftId);
    return doc;
  }

  async update(
    tenantId: string,
    draftId: string,
    docId: string,
    actorId: string,
    dto: UpdateDocumentDto,
  ) {
    await this.assertDraft(tenantId, draftId);
    await this.assertCanEdit(tenantId, draftId, actorId);
    const existing = await this.prisma.wsDocument.findFirst({
      where: { id: docId, tenantId, draftId },
    });
    if (!existing) throw new NotFoundException('Document not found');
    return this.prisma.wsDocument.update({
      where: { id: docId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.ordinal !== undefined ? { ordinal: dto.ordinal } : {}),
        ...(dto.body !== undefined ? { body: dto.body as never } : {}),
      },
    });
  }

  async remove(
    tenantId: string,
    draftId: string,
    docId: string,
    actorId: string,
  ): Promise<{ deleted: boolean }> {
    await this.assertDraft(tenantId, draftId);
    await this.assertCanEdit(tenantId, draftId, actorId);
    const existing = await this.prisma.wsDocument.findFirst({
      where: { id: docId, tenantId, draftId },
    });
    if (!existing) throw new NotFoundException('Document not found');
    await this.prisma.wsDocument.delete({ where: { id: docId } });
    await this.syncPacket(tenantId, draftId);
    return { deleted: true };
  }

  /** Recompute the parent draft's isPacket/docCount after a tab change. */
  private async syncPacket(tenantId: string, draftId: string): Promise<void> {
    const count = await this.prisma.wsDocument.count({ where: { tenantId, draftId } });
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    const cover = Boolean((draft?.config as Record<string, unknown> | undefined)?.coverLetter);
    await this.prisma.wsDraft.update({
      where: { id: draftId },
      data: { docCount: count, isPacket: cover || count > 1 },
    });
  }
}
