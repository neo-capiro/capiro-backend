import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { DocumentsService } from './documents.service.js';
import { CreateDocumentDto, UpdateDocumentDto } from './dto/document.dto.js';

/** Packet document tabs nested under a draft (Phase 3, AC-3.4). */
@Controller('drafts/:draftId/documents')
@UseGuards(TenantGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.documents.list(ctx.tenantId, draftId);
  }

  @Post()
  add(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: CreateDocumentDto,
  ) {
    return this.documents.add(ctx.tenantId, draftId, ctx.clerkUserId, dto);
  }

  @Patch(':docId')
  update(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('docId') docId: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.documents.update(ctx.tenantId, draftId, docId, ctx.clerkUserId, dto);
  }

  @Delete(':docId')
  remove(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('docId') docId: string,
  ) {
    return this.documents.remove(ctx.tenantId, draftId, docId, ctx.clerkUserId);
  }
}
