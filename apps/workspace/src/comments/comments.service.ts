import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GenerationService } from '../generation/generation.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canComment, canReview } from '../collaborators/role-policy.js';
import type { CreateCommentDto, UpdateCommentDto } from './dto/comment.dto.js';

/**
 * In-editor comments + threads (Phase 3, AC-3.5 / handoff §12.7). Anchored to a
 * document range so the highlight survives re-render. Threaded via parentId.
 * Resolvable. Role enforcement: a `commenter` may create comments/replies but
 * may not resolve (resolve is an editor/reviewer action).
 *
 * Tenant-scoped: every query filters by tenantId and verifies the document
 * belongs to the tenant.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generation: GenerationService,
    private readonly collaborators: CollaboratorsService,
  ) {}

  private async assertDocument(tenantId: string, documentId: string) {
    const doc = await this.prisma.wsDocument.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async list(tenantId: string, documentId: string) {
    await this.assertDocument(tenantId, documentId);
    // Top-level comments with their replies threaded underneath.
    return this.prisma.wsComment.findMany({
      where: { tenantId, documentId, parentId: null },
      orderBy: { createdAt: 'asc' },
      include: { replies: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async create(tenantId: string, documentId: string, authorId: string, dto: CreateCommentDto) {
    const doc = await this.assertDocument(tenantId, documentId);
    // Creating comments/replies is any role with access except viewer.
    await this.collaborators.assertCan(
      tenantId,
      doc.draftId,
      authorId,
      canComment,
      'Viewers cannot comment on this document',
    );
    if (dto.parentId) {
      const parent = await this.prisma.wsComment.findFirst({
        where: { id: dto.parentId, tenantId, documentId },
      });
      if (!parent) throw new NotFoundException('Parent comment not found');
    }
    return this.prisma.wsComment.create({
      data: {
        tenantId,
        documentId,
        authorId,
        role: dto.role ?? 'editor',
        body: dto.body,
        quote: dto.quote ?? null,
        anchor: (dto.anchor ?? undefined) as never,
        parentId: dto.parentId ?? null,
      },
    });
  }

  async update(
    tenantId: string,
    documentId: string,
    commentId: string,
    actorId: string,
    dto: UpdateCommentDto,
  ) {
    const doc = await this.assertDocument(tenantId, documentId);
    const existing = await this.prisma.wsComment.findFirst({
      where: { id: commentId, tenantId, documentId },
    });
    if (!existing) throw new NotFoundException('Comment not found');
    // Resolving a thread is a review action: owner + editor + reviewer only
    // (commenter/viewer cannot resolve). Editing the body is gated the same way
    // here (body edits ride alongside resolve on this endpoint).
    await this.collaborators.assertCan(
      tenantId,
      doc.draftId,
      actorId,
      canReview,
      'Only owners, editors and reviewers can resolve comments',
    );
    return this.prisma.wsComment.update({
      where: { id: commentId },
      data: {
        ...(dto.body !== undefined ? { body: dto.body } : {}),
        ...(dto.resolved !== undefined ? { resolved: dto.resolved } : {}),
      },
    });
  }

  /**
   * "Let Meri draft an edit" (handoff §12.7). Drafts a concrete rewrite of the
   * comment's quoted passage that addresses the thread, grounded in the parent
   * draft's config and honoring its anonymize flag. Returns a before/after the
   * client renders in a SuggestionCard. Requires the comment to carry a quote.
   */
  async suggestEdit(tenantId: string, documentId: string, commentId: string, actorId: string) {
    const doc = await this.assertDocument(tenantId, documentId);
    // Drafting/approving a Meri suggestion is a review action.
    await this.collaborators.assertCan(
      tenantId,
      doc.draftId,
      actorId,
      canReview,
      'Only owners, editors and reviewers can approve Meri suggestions',
    );
    const comment = await this.prisma.wsComment.findFirst({
      where: { id: commentId, tenantId, documentId },
      include: { replies: { orderBy: { createdAt: 'asc' } } },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    if (!comment.quote || !comment.quote.trim()) {
      throw new BadRequestException('Comment has no quoted passage to edit');
    }

    const document = await this.prisma.wsDocument.findFirst({
      where: { id: documentId, tenantId },
      include: { draft: true },
    });
    const draft = document?.draft;
    const cfg = (draft?.config as Record<string, unknown> | undefined) ?? {};

    return this.generation.suggestCommentEdit({
      tenantId,
      quote: comment.quote,
      commentBody: comment.body,
      replies: (comment.replies ?? []).map((r) => r.body),
      docTitle: draft?.docTitle ?? 'document',
      product: draft?.product ?? null,
      client: (cfg.client as string | null) ?? draft?.client ?? null,
      offices: (cfg.offices as string[] | undefined) ?? [],
      anonymize: Boolean(cfg.anonymize),
    });
  }

  async remove(
    tenantId: string,
    documentId: string,
    commentId: string,
  ): Promise<{ deleted: boolean }> {
    await this.assertDocument(tenantId, documentId);
    const existing = await this.prisma.wsComment.findFirst({
      where: { id: commentId, tenantId, documentId },
    });
    if (!existing) throw new NotFoundException('Comment not found');
    await this.prisma.wsComment.delete({ where: { id: commentId } });
    return { deleted: true };
  }
}
