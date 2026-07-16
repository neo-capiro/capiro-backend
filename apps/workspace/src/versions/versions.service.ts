import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit, canRead, type ResolvedRole } from '../collaborators/role-policy.js';
import type { CreateVersionDto } from './dto/version.dto.js';

/**
 * Version history (Phase 6b / handoff §12.8). A version is a point-in-time
 * snapshot of a draft — its config + each document body — created on a manual
 * "Save draft" and restorable. Tenant-scoped: the draft is loaded with a
 * mandatory tenantId filter before any read/write.
 *
 * Meri-authored versions (authorKind 'meri') render with the Meri avatar and
 * are logged for AI-use disclosure; person versions render the tenant member's
 * avatar (resolved client-side via the identity resolver).
 */
@Injectable()
export class VersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
  ) {}

  /**
   * Load the draft (tenant-scoped) and — when actorId is supplied — enforce the
   * private-draft ACL (GAI-31): version history exposes full document snapshots,
   * and restore destructively overwrites the live draft, so tenant scope alone
   * is not authorization. `predicate` is canRead for listing, canEdit for
   * create/restore. Internal callers omit actorId.
   */
  private async loadDraft(
    tenantId: string,
    draftId: string,
    actorId?: string,
    predicate: (role: ResolvedRole) => boolean = canRead,
  ) {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      include: { documents: { orderBy: { ordinal: 'asc' } } },
    });
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

  async list(tenantId: string, draftId: string, actorId?: string) {
    await this.loadDraft(tenantId, draftId, actorId, canRead);
    return this.prisma.wsDocVersion.findMany({
      where: { tenantId, draftId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Snapshot the current draft state. Called on a manual "Save draft" (after the
   * autosave flush persists the working copy). The snapshot is the full draft
   * config + each document's body so a restore is lossless.
   */
  async create(tenantId: string, draftId: string, authorId: string, dto: CreateVersionDto) {
    // Snapshotting is a "Save draft" editor action — owner/editor only. authorId
    // is the acting user (the controller passes ctx.clerkUserId).
    const draft = await this.loadDraft(tenantId, draftId, authorId, canEdit);
    const snapshot = {
      docTitle: draft.docTitle,
      config: draft.config,
      ask: draft.ask,
      documents: draft.documents.map((d) => ({
        id: d.id,
        name: d.name,
        ordinal: d.ordinal,
        body: d.body,
      })),
    };
    return this.prisma.wsDocVersion.create({
      data: {
        tenantId,
        draftId,
        label: dto.label ?? null,
        authorId,
        authorKind: dto.authorKind ?? 'person',
        snapshot: snapshot as never,
      },
    });
  }

  /**
   * Restore a prior version into the live draft: overwrite the draft config +
   * title + ask and each document body from the snapshot. Documents that no
   * longer exist are skipped; current documents not present in the snapshot are
   * left untouched. A restore does NOT itself create a new version (the caller
   * may snapshot again afterward).
   */
  async restore(tenantId: string, draftId: string, versionId: string, actorId?: string) {
    // Restore destructively overwrites the live draft → owner/editor only.
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const version = await this.prisma.wsDocVersion.findFirst({
      where: { id: versionId, tenantId, draftId },
    });
    if (!version) throw new NotFoundException('Version not found');

    const snap = (version.snapshot as Snapshot) ?? {};
    await this.prisma.$transaction(async (tx) => {
      await tx.wsDraft.update({
        where: { id: draftId },
        data: {
          ...(snap.docTitle !== undefined ? { docTitle: snap.docTitle } : {}),
          ...(snap.config !== undefined ? { config: snap.config as never } : {}),
          ...(snap.ask !== undefined ? { ask: snap.ask as never } : {}),
        },
      });
      for (const sd of snap.documents ?? []) {
        // Only restore documents that still exist on this draft/tenant.
        const exists = draft.documents.some((d) => d.id === sd.id);
        if (!exists) continue;
        await tx.wsDocument.update({
          where: { id: sd.id },
          data: {
            ...(sd.name !== undefined ? { name: sd.name } : {}),
            ...(sd.body !== undefined ? { body: sd.body as never } : {}),
          },
        });
      }
    });

    return this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      include: { documents: { orderBy: { ordinal: 'asc' } } },
    });
  }
}

interface Snapshot {
  docTitle?: string;
  config?: unknown;
  ask?: unknown;
  documents?: Array<{ id: string; name?: string; ordinal?: number; body?: unknown }>;
}
