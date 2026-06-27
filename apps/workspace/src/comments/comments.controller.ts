import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { CommentsService } from './comments.service.js';
import { CreateCommentDto, UpdateCommentDto } from './dto/comment.dto.js';

/** Comments nested under a document (Phase 3, AC-3.5). */
@Controller('documents/:documentId/comments')
@UseGuards(TenantGuard)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('documentId') documentId: string) {
    return this.comments.list(ctx.tenantId, documentId);
  }

  @Post()
  create(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('documentId') documentId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.comments.create(ctx.tenantId, documentId, ctx.clerkUserId, dto);
  }

  /**
   * POST /workspace-api/documents/:documentId/comments/:commentId/suggest
   * "Let Meri draft an edit" — rewrites the comment's quoted passage to address
   * the thread (before/after for a SuggestionCard). Tenant-scoped.
   */
  @Post(':commentId/suggest')
  suggest(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('documentId') documentId: string,
    @Param('commentId') commentId: string,
  ) {
    return this.comments.suggestEdit(ctx.tenantId, documentId, commentId);
  }

  @Patch(':commentId')
  update(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('documentId') documentId: string,
    @Param('commentId') commentId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.comments.update(ctx.tenantId, documentId, commentId, ctx.role, dto);
  }

  @Delete(':commentId')
  remove(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('documentId') documentId: string,
    @Param('commentId') commentId: string,
  ) {
    return this.comments.remove(ctx.tenantId, documentId, commentId);
  }
}
