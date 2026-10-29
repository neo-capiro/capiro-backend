import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { DraftsService } from './drafts.service.js';
import { CreateDraftDto, UpdateDraftDto, ListDraftsQueryDto } from './dto/draft.dto.js';
import { SaveDraftDto } from './dto/save-draft.dto.js';
import { SaveProspectDraftDto } from './dto/prospect-save.dto.js';

/** Drafts CRUD + autosave (Phase 3, AC-3.3). All tenant-scoped. */
@Controller('drafts')
@UseGuards(TenantGuard)
export class DraftsController {
  constructor(private readonly drafts: DraftsService) {}

  @Post()
  create(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() dto: CreateDraftDto) {
    return this.drafts.create(ctx.tenantId, ctx.clerkUserId, dto);
  }

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext, @Query() q: ListDraftsQueryDto) {
    return this.drafts.list(ctx.tenantId, ctx.clerkUserId, q);
  }

  @Get(':id')
  get(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    // actorId gates the read: only the owner or an active collaborator may open
    // a draft (404 otherwise — documents are private until shared).
    return this.drafts.byId(ctx.tenantId, id, ctx.clerkUserId);
  }

  @Get(':id/state')
  currentState(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.drafts.currentState(ctx.tenantId, id, ctx.clerkUserId);
  }

  @Post(':id/save')
  save(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string, @Body() dto: SaveDraftDto) {
    return this.drafts.save(ctx.tenantId, id, ctx.clerkUserId, dto);
  }

  @Get(':id/prospect-state')
  @Header('Cache-Control', 'no-store')
  prospectState(
    @CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string,
    @Query('prospectId', new ParseUUIDPipe()) prospectId: string,
  ) {
    return this.drafts.prospectState(ctx.tenantId, id, ctx.clerkUserId, prospectId);
  }

  @Post(':id/prospect-save')
  saveProspect(
    @CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string,
    @Body() dto: SaveProspectDraftDto,
  ) {
    return this.drafts.saveProspect(ctx.tenantId, id, ctx.clerkUserId, dto);
  }

  /** PATCH = autosave target (debounced partial config/body/sections). */
  @Patch(':id')
  update(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateDraftDto,
  ) {
    return this.drafts.update(ctx.tenantId, id, ctx.clerkUserId, dto);
  }

  /**
   * POST /workspace-api/drafts/:draftId/anonymize/detect
   * Anonymize review — return candidate name spans (client / offices / program)
   * with occurrence counts for the review modal. Tenant-scoped.
   */
  @Post(':draftId/anonymize/detect')
  detectAnonymize(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.drafts.detectAnonymizeNames(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Delete(':id')
  remove(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.drafts.remove(ctx.tenantId, id, ctx.clerkUserId);
  }
}
