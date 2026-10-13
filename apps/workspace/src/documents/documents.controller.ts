import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  ParseUUIDPipe,
  Header,
} from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { DocumentsService } from './documents.service.js';
import { CreateDocumentDto, UpdateDocumentDto } from './dto/document.dto.js';
import { CopyProspectBriefDto, SaveProspectBriefCopyDto } from './dto/prospect-brief-copy.dto.js';

/** Packet document tabs nested under a draft (Phase 3, AC-3.4). */
@Controller('drafts/:draftId/documents')
@UseGuards(TenantGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Header('Cache-Control', 'private, no-store')
  @Get('brief-copy-state')
  briefCopyState(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
  ) {
    return this.documents.briefCopyState(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get(':docId/brief-copy')
  briefCopy(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ) {
    return this.documents.briefCopyState(ctx.tenantId, draftId, ctx.clerkUserId, docId);
  }

  @Post('core-brief-copy')
  copyBrief(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Body() dto: CopyProspectBriefDto,
  ) {
    return this.documents.copyBrief(ctx.tenantId, draftId, ctx.clerkUserId, dto);
  }

  @Post(':docId/brief-copy-save')
  saveBriefCopy(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body() dto: SaveProspectBriefCopyDto,
  ) {
    return this.documents.saveBriefCopy(ctx.tenantId, draftId, docId, ctx.clerkUserId, dto);
  }

  @Get('meri-import')
  listForMeriImport(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
  ) {
    return this.documents.listForMeriImport(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.documents.list(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Get(':docId/meri-import')
  meriImport(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('docId') docId: string,
  ) {
    return this.documents.readForMeriImport(ctx.tenantId, draftId, docId, ctx.clerkUserId);
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
