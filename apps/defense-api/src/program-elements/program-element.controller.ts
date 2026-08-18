import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../roles/roles.decorator.js';
import { RolesGuard } from '../roles/roles.guard.js';
import { DefenseCurrentTenant } from '../roles/current-tenant.decorator.js';
import { TenantGuard } from '@capiro/auth';
import { DefenseMemberResolverGuard } from '../roles/defense-member-resolver.guard.js';
import type { DefenseTenantContext } from './program-elements.shared.js';
import {
  CreatePeDataIssueDto,
  ListPeDataIssuesQueryDto,
  QueryProgramElementsDto,
  ResolvePeDataIssueDto,
  ResolveReconciliationDto,
  SetPeAlertEmailPrefDto,
  WatchProgramElementDto,
} from './dto/program-elements.dto.js';
import { ProgramElementReadService } from './program-element-read.service.js';
import { ProgramElementDataIssueService } from './program-element-data-issue.service.js';

/**
 * Program Elements HTTP surface — frozen Session 1 contract, `defense-api`
 * implementation. Route id / method / path / minimumRole for every handler
 * below matches DEFENSE_PUBLIC_ROUTES verbatim (verified by
 * scripts/verify-phase8-session3.mjs); this controller is registered dark
 * (ProgramElementsModule is wired into AppModule, but no ALB/production
 * traffic is routed to defense-api).
 */
@Controller('program-elements')
@UseGuards(TenantGuard, DefenseMemberResolverGuard, RolesGuard)
@Roles('standard_user')
export class ProgramElementController {
  constructor(
    private readonly service: ProgramElementReadService,
    private readonly dataIssues: ProgramElementDataIssueService,
  ) {}

  @Get('admin/reconciliation-queue')
  @Roles('capiro_admin')
  reconciliationQueue(@Query() query: QueryProgramElementsDto) {
    return this.service.listReconciliationQueue(query.status ?? 'open', query.page, query.limit);
  }

  @Get('admin/data-issues')
  @Roles('capiro_admin')
  listDataIssuesAdmin(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Query() query: ListPeDataIssuesQueryDto) {
    return this.dataIssues.listAdmin(ctx, { status: query.status, peCode: query.peCode, page: query.page, limit: query.limit });
  }

  @Post('admin/data-issues/:id/resolve')
  @Roles('capiro_admin')
  resolveDataIssue(
    @DefenseCurrentTenant() ctx: DefenseTenantContext,
    @Param('id') id: string,
    @Body() body: ResolvePeDataIssueDto,
  ) {
    return this.dataIssues.resolve(id, { status: body.status, resolutionNotes: body.resolutionNotes }, ctx);
  }

  @Post('admin/reconciliation-queue/:id/resolve')
  @Roles('capiro_admin')
  resolveReconciliation(
    @DefenseCurrentTenant() ctx: DefenseTenantContext,
    @Param('id') id: string,
    @Body() body: ResolveReconciliationDto,
  ) {
    return this.service.resolveReconciliation(
      id,
      { decision: body.decision, manualValue: exactManualValueOrThrow(body.manualValue), notes: body.notes },
      ctx,
    );
  }

  @Post('admin/reconciliation-queue/:id/approve')
  @Roles('capiro_admin')
  approveReconciliation(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Param('id') id: string) {
    return this.service.approveReconciliation(id, ctx);
  }

  @Get('deltas/needs-attention')
  needsAttention(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Query() query: QueryProgramElementsDto) {
    return this.service.getNeedsAttention(ctx, { minScore: query.minScore, fy: query.fy, limit: query.limit });
  }

  @Get()
  list(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Query() query: QueryProgramElementsDto) {
    return this.service.listProgramElements(
      {
        service: query.service,
        budgetActivity: query.budget_activity,
        q: query.q,
        page: query.page,
        limit: query.limit,
        // `mode` and `divergence_threshold` are part of apps/api's behaviour on
        // this same route (the watchlist markup-monitor view). Accepting them in
        // the DTO and then dropping them here made `?mode=markup-monitor` return
        // the ordinary catalog page instead.
        mode: query.mode,
        divergenceThreshold: query.divergence_threshold,
        hasData: query.has_data,
        watched: query.watched,
        lineType: query.line_type,
        capability: query.capability,
      },
      ctx,
    );
  }

  @Get('summary')
  summary(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Query() query: QueryProgramElementsDto) {
    return this.service.getSummary({ service: query.service, hasData: query.has_data }, ctx);
  }

  @Get('alerts/email-pref')
  getAlertEmailPref(@DefenseCurrentTenant() ctx: DefenseTenantContext) {
    return this.service.getPeAlertEmailPref(ctx);
  }

  @Put('alerts/email-pref')
  setAlertEmailPref(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Body() body: SetPeAlertEmailPrefDto) {
    return this.service.setPeAlertEmailPref(body.mode, ctx);
  }

  @Get(':peCode')
  detail(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Param('peCode') peCode: string) {
    return this.service.getProgramElement(peCode, ctx);
  }

  @Get(':peCode/intelligence')
  intelligence(@Param('peCode') peCode: string) {
    return this.service.getIntelligence(peCode);
  }

  @Get(':peCode/timeline')
  timeline(@Param('peCode') peCode: string) {
    return this.service.getTimeline(peCode);
  }

  @Get(':peCode/narrative')
  narrative(@Param('peCode') peCode: string) {
    return this.service.getNarrative(peCode);
  }

  @Get(':peCode/bills')
  bills(@Param('peCode') peCode: string) {
    return this.service.getBills(peCode);
  }

  @Get(':peCode/bill-actions')
  billActions(@Param('peCode') peCode: string) {
    return this.service.getBillActions(peCode);
  }

  @Get(':peCode/contractors')
  contractors(@Param('peCode') peCode: string) {
    return this.service.getContractors(peCode);
  }

  @Get(':peCode/projects')
  projects(@Param('peCode') peCode: string) {
    return this.service.getProjects(peCode);
  }

  @Get(':peCode/procurement-lines')
  procurementLines(@Param('peCode') peCode: string) {
    return this.service.getProcurementLines(peCode);
  }

  @Get(':peCode/sources')
  sources(@Param('peCode') peCode: string) {
    return this.service.getSources(peCode);
  }

  @Get(':peCode/related')
  related(@Param('peCode') peCode: string) {
    return this.service.getRelatedProgramElements(peCode);
  }

  @Get(':peCode/programs')
  programs(@Param('peCode') peCode: string) {
    return this.service.getProgramsForPe(peCode);
  }

  @Get(':peCode/provisions')
  provisions(@Param('peCode') peCode: string) {
    return this.service.getProvisionsForPe(peCode);
  }

  @Get(':peCode/opportunities')
  opportunities(@Param('peCode') peCode: string) {
    return this.service.listOpportunities(peCode);
  }

  @Get(':peCode/positions')
  positions(@Param('peCode') peCode: string, @Query('fy') fy?: string) {
    const parsed = fy !== undefined && fy !== '' ? Number(fy) : undefined;
    return this.service.getBudgetPositions(peCode, parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined);
  }

  @Get(':peCode/pb-comparison')
  pbComparison(@Param('peCode') peCode: string) {
    return this.service.getPbComparison(peCode);
  }

  @Get(':peCode/deltas')
  deltas(@Param('peCode') peCode: string, @Query() query: QueryProgramElementsDto) {
    return this.service.getDeltas(peCode, { deltaType: query.deltaType, fy: query.fy, page: query.page, limit: query.limit });
  }

  @Post(':peCode/watch')
  watch(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Param('peCode') peCode: string, @Body() body: WatchProgramElementDto) {
    return this.service.setWatching(peCode, body.watching, ctx);
  }

  @Get(':peCode/data-issues')
  listDataIssues(
    @DefenseCurrentTenant() ctx: DefenseTenantContext,
    @Param('peCode') peCode: string,
    @Query() query: ListPeDataIssuesQueryDto,
  ) {
    return this.dataIssues.listForPe(peCode, ctx, { status: query.status, page: query.page, limit: query.limit });
  }

  @Post(':peCode/data-issues')
  createDataIssue(
    @DefenseCurrentTenant() ctx: DefenseTenantContext,
    @Param('peCode') peCode: string,
    @Body() body: CreatePeDataIssueDto,
  ) {
    return this.dataIssues.create(
      peCode,
      { issueType: body.issueType, description: body.description, fy: body.fy, fieldName: body.fieldName, suggestedSourceUrl: body.suggestedSourceUrl },
      ctx,
    );
  }
}

/**
 * A manual value that can represent money exactly. Mirrors apps/api's
 * exact-money guard: an integer JS number converts to its decimal string
 * exactly; a fractional JS number is refused rather than silently converted
 * (that is exactly where float error would enter a governed override).
 */
function exactManualValueOrThrow(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Number.isInteger(value)) return String(value);
  throw new BadRequestException(
    `manualValue must be an exact decimal string; ${value} is a fractional JSON number and cannot represent money exactly`,
  );
}
