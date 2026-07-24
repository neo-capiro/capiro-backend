import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Delete,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { IntelligenceService } from './intelligence.service.js';
import { InsightGeneratorService } from './insight-generator.service.js';
import { EntityResolutionService } from './entity-resolution.service.js';
import { ReportCardService } from './report-card.service.js';

class ChangesQueryDto {
  @IsOptional()
  @IsString()
  since?: string;

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsString()
  source?: string;

  // Read/unread filter for the Changes Inbox. Accepts ?consumed=false to hide
  // already-cleared changes. Transformed from the query string ('true'/'false')
  // to a real boolean; absent => undefined => no filter (dashboard behaviour).
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => (value === undefined ? undefined : value === 'true' || value === true))
  consumed?: boolean;

  // Scope the feed to changes touching a set of Program Element codes (the PE
  // Watchlist signal feed). Accepts a comma-separated string or repeated params;
  // normalized to upper-cased codes. Filters IntelligenceChange.related_pe_codes
  // (GIN-indexed) hasSome.
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? undefined
      : (Array.isArray(value) ? value : String(value).split(','))
          .map((code: string) => code.trim().toUpperCase())
          .filter(Boolean),
  )
  @IsArray()
  @IsString({ each: true })
  peCodes?: string[];
}

class ConfirmMappingDto {
  @IsBoolean()
  @Type(() => Boolean)
  confirmed!: boolean;
}

class LdaSearchQueryDto {
  @IsString()
  q!: string;
}

// Manual pin of an external record to a client. externalId is the source's
// stable id (for 'lda' the exact lda_client.id) — the reliable, name-independent
// way to attach a registrant variant the fuzzy matcher can't reach.
class ManualMappingDto {
  @IsIn(['lda', 'contracting', 'sec', 'fec_employer', 'fec_committee', 'fara', 'lobby_intel', 'assistance_recipient'])
  source!: string;

  @IsString()
  externalId!: string;

  @IsString()
  externalName!: string;
}

class GenerateInsightsDto {
  @IsIn(['market', 'client', 'changes'])
  scope!: 'market' | 'client' | 'changes';

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsArray()
  changes?: Array<{ source: string; changeType: string; title: string; description: string }>;
}

class InsightsQueryDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class ReportCardQueryDto {
  @IsOptional()
  @IsIn(['quarter', 'year'])
  period?: 'quarter' | 'year';
}

class OutreachContextQueryDto {
  @IsOptional()
  @IsString()
  recipientOffice?: string;
}

// Per-user alert worklist state. alertId is the stable composite the alerts
// builder emits (carries ':' — kept in the body, never the path).
class SetAlertStateDto {
  @IsString()
  alertId!: string;

  @IsIn(['acknowledged', 'dismissed', 'snoozed'])
  state!: 'acknowledged' | 'dismissed' | 'snoozed';

  // ISO timestamp; only meaningful when state === 'snoozed'.
  @IsOptional()
  @IsString()
  snoozedUntil?: string;
}

class ClearAlertStateDto {
  @IsString()
  alertId!: string;
}

class AddClientBriefDto {
  @IsString()
  title!: string;

  @IsString()
  body!: string;

  @IsOptional()
  @IsString()
  sourceAlertId?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;
}

@Controller('intelligence')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class IntelligenceController {
  constructor(
    private readonly service: IntelligenceService,
    private readonly insights: InsightGeneratorService,
    private readonly entityResolution: EntityResolutionService,
    private readonly reportCard: ReportCardService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('client-profile/:clientId')
  getClientProfile(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getClientProfile(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/profile-v1')
  getClientProfileV1(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getClientProfileV1(clientId, ctx.tenantId, ctx.userId);
  }

  @Post('resolve-all')
  @Roles('user_admin')
  resolveAll(@CurrentTenant() ctx: TenantContext) {
    return this.entityResolution.resolveAllForTenant(ctx.tenantId);
  }

  @Get('changes/unread-count')
  getUnreadChangesCount() {
    return this.service.getUnreadChangesCount();
  }

  @Patch('changes/:id')
  markChangeConsumed(@Param('id') id: string, @Body() body: { consumed: boolean }) {
    return this.service.markChangeConsumed(id, body.consumed);
  }

  @Get('changes')
  getChanges(@CurrentTenant() ctx: TenantContext, @Query() q: ChangesQueryDto) {
    return this.service.getChanges(
      ctx.tenantId,
      q.since,
      q.clientId,
      q.source,
      q.consumed,
      q.peCodes,
    );
  }

  @Get('clients/:clientId/lobbying-roi')
  getLobbyingRoi(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getLobbyingRoi(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/lda-filings')
  getClientLdaFilings(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getClientLdaFilings(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/fec-money-flow')
  getFecMoneyFlow(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getFecMoneyFlow(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/competitor-board')
  getCompetitorBoard(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getCompetitorBoard(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/ex-staffers')
  getExStaffers(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getExStaffers(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/bills')
  getClientBills(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getClientBills(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/tracked-bills')
  getTrackedBills(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getTrackedBills(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/health-score')
  getHealthScore(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.computeEngagementHealth(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/setup-completeness')
  getSetupCompleteness(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getSetupCompleteness(clientId, ctx.tenantId);
  }

  @Get('issues/:code/leaderboard')
  getIssueLeaderboard(@Param('code') code: string) {
    return this.service.getIssueLeaderboard(code);
  }

  @Get('comment-alerts')
  getCommentAlerts(@CurrentTenant() ctx: TenantContext) {
    return this.service.getCommentPeriodAlerts(ctx.tenantId);
  }

  @Get('today-timeline')
  getTodayTimeline(@CurrentTenant() ctx: TenantContext) {
    return this.service.getTodayTimeline(ctx.tenantId);
  }

  @Get('coming-up')
  getComingUp(@CurrentTenant() ctx: TenantContext) {
    return this.service.getComingUp(ctx.tenantId);
  }

  @Get('portfolio-summary')
  getPortfolioSummary(@CurrentTenant() ctx: TenantContext) {
    return this.service.getPortfolioSummary(ctx.tenantId);
  }

  @Get('portfolio-alerts')
  getPortfolioAlerts(@CurrentTenant() ctx: TenantContext, @Query('limit') limit?: string) {
    const parsed = limit != null ? Number.parseInt(limit, 10) : undefined;
    return this.service.getPortfolioAlerts(ctx.tenantId, ctx.userId, {
      limit: Number.isFinite(parsed) ? parsed : undefined,
    });
  }

  @Get('live-ticker')
  getLiveTicker(@CurrentTenant() ctx: TenantContext) {
    return this.service.getLiveTicker(ctx.tenantId);
  }

  @Get('daily-brief')
  getDailyBrief(@CurrentTenant() ctx: TenantContext) {
    return this.insights.generateDailyBrief(ctx.tenantId, ctx.userId);
  }

  @Get('mappings')
  getAllMappings(@CurrentTenant() ctx: TenantContext) {
    return this.service.getAllMappingsForTenant(ctx.tenantId);
  }

  @Get('mappings/:clientId')
  getMappings(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getMappings(clientId, ctx.tenantId);
  }

  @Post('mappings/:clientId/resolve')
  resolveMapping(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.resolveMapping(clientId, ctx.tenantId);
  }

  @Patch('mappings/:mappingId')
  confirmMapping(
    @CurrentTenant() ctx: TenantContext,
    @Param('mappingId') mappingId: string,
    @Body() body: ConfirmMappingDto,
  ) {
    return this.service.confirmMapping(mappingId, body.confirmed, ctx.tenantId);
  }

  // Free-text / by-id search of lda_client for the manual-attach panel. Returns
  // identity + filing-history columns so a user can pin the right registrant by
  // its stable id + footprint rather than by name similarity.
  @Get('lda-clients/search')
  searchLdaClients(@Query() q: LdaSearchQueryDto) {
    return this.service.searchLdaClients(q.q);
  }

  // Free-text search of distinct FEC contributor-employer strings for the
  // manual-attach panel (the employer string is both the id and the name).
  @Get('fec-employers/search')
  searchFecEmployers(@Query() q: LdaSearchQueryDto) {
    return this.service.searchFecEmployers(q.q);
  }

  // Free-text / by-uuid search of federal_contractor for the manual-attach
  // panel. The contractor uuid is the externalId pinned into a 'contracting'
  // mapping (matching fetchContractorById's id::uuid lookup).
  @Get('contractors/search')
  searchContractors(@Query() q: LdaSearchQueryDto) {
    return this.service.searchContractors(q.q);
  }

  // Free-text / by-UEI search of federal_assistance_award recipients for the
  // District Nexus manual-attach panel (source 'assistance_recipient'). The
  // recipient UEI is the externalId pinned into the mapping when available.
  @Get('assistance-recipients/search')
  searchAssistanceRecipients(@Query() q: LdaSearchQueryDto) {
    return this.service.searchAssistanceRecipients(q.q);
  }

  // Read-only "what's driving this client's matching" signal: the union'd issue
  // codes (+ names), how many LDA registrants back them, and capability richness.
  @Get('clients/:clientId/issue-code-signal')
  getIssueCodeSignal(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getIssueCodeSignal(clientId, ctx.tenantId);
  }

  // Manually pin (and confirm) an external record to a client. Admin-curation
  // action, so gated like resolve-all.
  @Post('mappings/:clientId/manual')
  @Roles('user_admin')
  createManualMapping(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: ManualMappingDto,
  ) {
    return this.service.createManualMapping(clientId, ctx.tenantId, {
      source: body.source,
      externalId: body.externalId,
      externalName: body.externalName,
    });
  }

  // ── Feature 4.1: Report Card ───────────────────────────────────────────

  @Get('clients/:clientId/report-card')
  getReportCard(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query() q: ReportCardQueryDto,
  ) {
    return this.reportCard.generateReportCard(clientId, ctx.tenantId, q.period ?? 'quarter');
  }

  @Get('clients/:clientId/report-card/export')
  exportReportCard(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query() q: ReportCardQueryDto,
  ) {
    return this.reportCard.generateReportCard(clientId, ctx.tenantId, q.period ?? 'quarter');
  }

  // ── Feature 4.2: Knowledge Graph ───────────────────────────────────────

  @Get('clients/:clientId/knowledge-graph')
  getKnowledgeGraph(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    // Track B cutover: served ONLY on the tenant + ethical-wall scoped path.
    // The gates resolve PER-TENANT inside the service (settings_jsonb
    // clioFeatureFlags.kgIntelGraph / kgTraversalSource override the env
    // values passed here) — both must land on scoped+cache or the request
    // 503s. The legacy UNSCOPED kg_walk is never served from this route.
    return this.service.getKnowledgeGraph(clientId, ctx.tenantId, {
      viewerUserId: ctx.userId,
      envIntelGraphOn: this.config.get('KG_INTEL_GRAPH', { infer: true }) === 'scoped',
      envTraversalSource: this.config.get('KG_TRAVERSAL_SOURCE', { infer: true }) as
        | 'legacy'
        | 'cache',
    });
  }

  // ── Feature 4.3: Outreach Context ──────────────────────────────────────

  @Get('clients/:clientId/outreach-context')
  getOutreachContext(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query() q: OutreachContextQueryDto,
  ) {
    return this.service.getOutreachContext(clientId, ctx.tenantId, q.recipientOffice);
  }

  // ── AI Insight Pipeline (Phase 4) ──────────────────────────────────────

  @Post('insights/generate')
  generateInsights(@CurrentTenant() ctx: TenantContext, @Body() body: GenerateInsightsDto) {
    switch (body.scope) {
      case 'market':
        // GAI-01: insights are now tenant-scoped — stamp the caller's tenant so
        // a standard user's generation lands in their own tenant, never a global
        // feed readable by every tenant.
        return this.insights.generateMarketInsights(ctx.tenantId);
      case 'client':
        return this.insights.generateClientBriefing(body.clientId!, ctx.tenantId);
      case 'changes':
        return this.insights.generateFromChanges(body.changes ?? [], ctx.tenantId);
    }
  }

  @Get('insights')
  getInsights(@CurrentTenant() ctx: TenantContext, @Query() q: InsightsQueryDto) {
    // GAI-01: scope the read to the caller's tenant (RLS returns own-tenant +
    // reviewed public rows only), replacing the former cross-tenant global read.
    return this.insights.getInsights(ctx.tenantId, q.category, q.severity, q.limit);
  }

  @Get('briefing/:clientId')
  getBriefing(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.insights.generateClientBriefing(clientId, ctx.tenantId);
  }

  // ─── Phase 2 cross-references ─────────────────────────────────────────

  @Get('clients/:clientId/district-nexus')
  getDistrictNexus(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getDistrictNexus(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/district-nexus-spend')
  getDistrictNexusSpend(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getDistrictNexusSpend(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/bill-regulation-links')
  getBillRegulationLinks(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getBillRegulationLinks(clientId, ctx.tenantId);
  }

  @Get('clients/:clientId/bill-research')
  getBillResearchAttachments(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ) {
    return this.service.getBillResearchAttachments(clientId, ctx.tenantId);
  }

  // ─── Manual bill tracking (user-pinned legislation per client) ─────────

  @Get('clients/:clientId/tracked-bills/manual')
  listManualTrackedBills(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.listTrackedBills(clientId, ctx.tenantId);
  }

  @Post('clients/:clientId/tracked-bills')
  addManualTrackedBill(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: { billId: string; note?: string },
  ) {
    return this.service.addTrackedBill(clientId, ctx.tenantId, body.billId, body.note, ctx.userId);
  }

  @Delete('clients/:clientId/tracked-bills/:billId')
  removeManualTrackedBill(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('billId') billId: string,
  ) {
    return this.service.removeTrackedBill(clientId, ctx.tenantId, billId);
  }

  // ─── Alert worklist state (per-user ack / dismiss / snooze) ────────────────

  @Post('clients/:clientId/alert-state')
  setAlertState(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: SetAlertStateDto,
  ) {
    const snoozedUntil =
      body.state === 'snoozed' && body.snoozedUntil ? new Date(body.snoozedUntil) : null;
    return this.service.setAlertState(
      ctx.tenantId,
      ctx.userId,
      clientId,
      body.alertId,
      body.state,
      snoozedUntil,
    );
  }

  // alertId carries ':' (e.g. "comment:<uuid>") which breaks path routing, so the
  // undo takes it in the body on DELETE rather than as a path param.
  @Delete('clients/:clientId/alert-state')
  clearAlertState(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: ClearAlertStateDto,
  ) {
    return this.service.clearAlertState(ctx.tenantId, ctx.userId, clientId, body.alertId);
  }

  // ─── Client briefs (saved notes; surface in the Outreach wizard context) ───

  @Get('clients/:clientId/briefs')
  listClientBriefs(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.listClientBriefs(ctx.tenantId, clientId);
  }

  @Post('clients/:clientId/briefs')
  addClientBrief(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: AddClientBriefDto,
  ) {
    return this.service.addClientBrief(ctx.tenantId, clientId, ctx.userId, {
      title: body.title,
      body: body.body,
      sourceAlertId: body.sourceAlertId ?? null,
      sourceType: body.sourceType ?? null,
    });
  }

  @Delete('clients/:clientId/briefs/:briefId')
  deleteClientBrief(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('briefId') briefId: string,
  ) {
    return this.service.deleteClientBrief(ctx.tenantId, clientId, briefId);
  }
}
