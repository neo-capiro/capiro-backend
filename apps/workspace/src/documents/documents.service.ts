import {
  withProspectDraft,
  assertProspectDraft,
  denyProspectTransfer,
  requireProspectDraftInTx,
  assertNoBoundBriefCopy,
} from '../prospect-resources/prospect-draft-access.js';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit, canRead } from '../collaborators/role-policy.js';
import type { CreateDocumentDto, UpdateDocumentDto } from './dto/document.dto.js';
import { meriImportText } from './meri-import-text.js';
import {
  prospectBriefCopyState,
  copyProspectBrief,
  saveProspectBriefCopy,
} from './prospect-brief-copy.js';
import type {
  CopyProspectBriefDto,
  SaveProspectBriefCopyDto,
} from './dto/prospect-brief-copy.dto.js';

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

  briefCopyState(tenantId: string, draftId: string, actorId: string, documentId?: string) {
    return prospectBriefCopyState(this.prisma, tenantId, draftId, actorId, documentId);
  }

  copyBrief(tenantId: string, draftId: string, actorId: string, dto: CopyProspectBriefDto) {
    return copyProspectBrief(this.prisma, tenantId, draftId, actorId, dto);
  }

  saveBriefCopy(
    tenantId: string,
    draftId: string,
    docId: string,
    actorId: string,
    dto: SaveProspectBriefCopyDto,
  ) {
    return saveProspectBriefCopy(this.prisma, tenantId, draftId, docId, actorId, dto);
  }

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

  async list(tenantId: string, draftId: string, actorId?: string) {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, actorId, canRead, 'read', async (db) => {
      return db.wsDocument.findMany({
        where: { tenantId, draftId },
        orderBy: { ordinal: 'asc' },
      });
    });
  }

  /**
   * Workspace-owned list for Meri's import chooser. This intentionally returns
   * names only and applies the same parent-draft collaborator read policy as
   * the subsequent `readForMeriImport` body fetch.
   */
  async listForMeriImport(tenantId: string, draftId: string, actorId: string) {
    const draft = await this.assertDraft(tenantId, draftId);
    denyProspectTransfer(draft);
    await this.collaborators.assertCan(
      tenantId,
      draftId,
      actorId,
      canRead,
      'You do not have access to this document',
    );
    return this.prisma.wsDocument.findMany({
      where: { tenantId, draftId },
      select: { id: true, name: true },
      orderBy: { ordinal: 'asc' },
    });
  }

  /**
   * Workspace-owned cross-surface read for Meri imports. It verifies the same
   * owner/collaborator policy as a regular document read before returning the
   * bounded document representation; callers cannot supply their own body.
   */
  async readForMeriImport(tenantId: string, draftId: string, docId: string, actorId: string) {
    const draft = await this.assertDraft(tenantId, draftId);
    denyProspectTransfer(draft);
    await this.collaborators.assertCan(
      tenantId,
      draftId,
      actorId,
      canRead,
      'You do not have access to this document',
    );
    const document = await this.prisma.wsDocument.findFirst({
      where: { id: docId, tenantId, draftId },
      select: { id: true, name: true, body: true },
    });
    if (!document) throw new NotFoundException('Document not found');
    return { ...document, text: meriImportText(document.body, draft.config) };
  }

  async add(tenantId: string, draftId: string, actorId: string, dto: CreateDocumentDto) {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, actorId, canEdit, 'write', async (db) => {
      await this.assertCanEdit(tenantId, draftId, actorId);
      const count = await db.wsDocument.count({ where: { tenantId, draftId } });
      const doc = await db.wsDocument.create({
        data: {
          tenantId,
          draftId,
          name: dto.name,
          ordinal: dto.ordinal ?? count,
          body: (dto.body ?? { blocks: [] }) as never,
        },
      });
      await this.syncPacket(tenantId, draftId, db);
      return doc;
    });
  }

  async update(
    tenantId: string,
    draftId: string,
    docId: string,
    actorId: string,
    dto: UpdateDocumentDto,
  ) {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, actorId, canEdit, 'write', async (db) => {
      await this.assertCanEdit(tenantId, draftId, actorId);
      if (draft.prospectId) await assertNoBoundBriefCopy(db, tenantId, draftId, docId);
      const existing = await db.wsDocument.findFirst({
        where: { id: docId, tenantId, draftId },
      });
      if (!existing) throw new NotFoundException('Document not found');
      return db.wsDocument.update({
        where: { id: docId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.ordinal !== undefined ? { ordinal: dto.ordinal } : {}),
          ...(dto.body !== undefined ? { body: dto.body as never } : {}),
        },
      });
    });
  }

  async remove(
    tenantId: string,
    draftId: string,
    docId: string,
    actorId: string,
  ): Promise<{ deleted: boolean }> {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, actorId, canEdit, 'write', async (db) => {
      await this.assertCanEdit(tenantId, draftId, actorId);
      if (draft.prospectId) await assertNoBoundBriefCopy(db, tenantId, draftId, docId);
      const existing = await db.wsDocument.findFirst({
        where: { id: docId, tenantId, draftId },
      });
      if (!existing) throw new NotFoundException('Document not found');
      await db.wsDocument.delete({ where: { id: docId } });
      await this.syncPacket(tenantId, draftId, db);
      return { deleted: true };
    });
  }

  /** Recompute the parent draft's isPacket/docCount after a tab change. */
  private async syncPacket(
    tenantId: string,
    draftId: string,
    db: import('../../generated/prisma-client/index.js').Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const count = await db.wsDocument.count({ where: { tenantId, draftId } });
    const draft = await db.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    const cover = Boolean((draft?.config as Record<string, unknown> | undefined)?.coverLetter);
    await db.wsDraft.update({
      where: { id: draftId },
      data: { docCount: count, isPacket: cover || count > 1 },
    });
  }
}
