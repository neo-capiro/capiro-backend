import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { AgenticGuard } from '../flags/agentic.guard.js';
import { ContextDocumentsService } from './context-documents.service.js';
import { CurrentPlanExportService } from './current-plan-export.service.js';
import { UploadContextDocumentDto, ApproveContextDocumentDto, ReassignContextDocumentDto } from './dto/context.dto.js';

/**
 * /strategy-api/context — Stage D context-pack documents + the read-only
 * current-plan projection. Guard stack mirrors Stage C's agent surface:
 * TenantGuard first (populates req.tenantContext), then the module flag
 * (StrategyPlannerGuard) AND the agentic opt-in (AgenticGuard) — context packs
 * exist to feed the agent runtime, so the same opt-in gates them.
 */
@Controller('context')
@UseGuards(TenantGuard, StrategyPlannerGuard, AgenticGuard)
export class ContextController {
  constructor(
    private readonly documents: ContextDocumentsService,
    private readonly currentPlan: CurrentPlanExportService,
  ) {}

  @Post('documents')
  upload(@CurrentTenant() tc: AuthTenantContext, @Body() dto: UploadContextDocumentDto) {
    return this.documents.upload(tc.tenantId, { clerkUserId: tc.clerkUserId, role: tc.role }, dto);
  }

  @Get('documents')
  list(
    @CurrentTenant() tc: AuthTenantContext,
    @Query('clientId') clientId?: string,
    @Query('templateKey') templateKey?: string,
    @Query('state') state?: string,
    @Query('includeStale') includeStale?: string,
    @Query('includeFirm') includeFirm?: string,
    @Query('firmOnly') firmOnly?: string,
  ) {
    return this.documents.list(tc.tenantId, {
      clientId: clientId || undefined,
      templateKey: templateKey || undefined,
      state: state || undefined,
      includeStale: includeStale === 'true',
      includeFirm: includeFirm === 'true',
      firmOnly: firmOnly === 'true',
    });
  }

  @Get('documents/:id')
  byId(@CurrentTenant() tc: AuthTenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.documents.get(tc.tenantId, id);
  }

  @Get('documents/:id/association')
  association(@CurrentTenant() tc: AuthTenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.documents.association(tc.tenantId, id);
  }

  @Post('documents/:id/reassign')
  reassign(@CurrentTenant() tc: AuthTenantContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReassignContextDocumentDto) {
    return this.documents.reassign(tc.tenantId, { clerkUserId: tc.clerkUserId, role: tc.role }, id, dto.expectedChecksum, dto.strategyId);
  }

  @Post('documents/:id/approve')
  approve(@CurrentTenant() tc: AuthTenantContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ApproveContextDocumentDto) {
    return this.documents.approve(tc.tenantId, { clerkUserId: tc.clerkUserId, role: tc.role }, id, dto.expectedChecksum);
  }

  @Post('documents/:id/archive')
  archive(@CurrentTenant() tc: AuthTenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.documents.archive(
      tc.tenantId,
      { clerkUserId: tc.clerkUserId, role: tc.role },
      id,
    );
  }

  @Get('documents/:id/sections')
  sections(@CurrentTenant() tc: AuthTenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.documents.sections(tc.tenantId, id);
  }

  @Get('documents/:id/locate')
  locate(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('ref') ref?: string,
  ) {
    if (!ref) throw new BadRequestException('ref query parameter is required');
    return this.documents.locate(tc.tenantId, id, ref);
  }

  /** Read-only 07_current_plan.md projection of live strategy state. */
  @Get('strategies/:strategyId/current-plan')
  exportCurrentPlan(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ) {
    return this.currentPlan.exportCurrentPlan(tc.tenantId, strategyId);
  }
}
