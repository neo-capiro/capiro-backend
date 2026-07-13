import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { QueryProgramElementsDto } from './dto/query-program-elements.dto.js';
import { WatchProgramElementDto } from './dto/watch-program-element.dto.js';
import { ProgramElementReadService, type ReconciliationDecision } from './program-element-read.service.js';
import { ProgramElementWriterService } from './program-element-writer.service.js';
import { MANUAL_OVERRIDE_SOURCE, type PeYearInput } from './types.js';

class SetPeAlertEmailPrefDto {
  /** PE Watch email-alert mode (plan Phase 2). */
  @IsIn(['off', 'daily', 'daily_plus_critical'])
  mode!: string;
}

class ResolveReconciliationDto {
  @IsIn(['keep_current', 'accept_conflicting', 'manual_value'])
  decision!: ReconciliationDecision;

  /** Required for decision=manual_value; numeric value in $ millions. */
  @IsOptional()
  @IsNumber()
  manualValue?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

@Controller('program-elements')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ProgramElementController {
  constructor(
    private readonly service: ProgramElementReadService,
    private readonly writer: ProgramElementWriterService,
  ) {}

  // Static admin route declared before the ':peCode' dynamic route so 'admin' is
  // not captured as a peCode. capiro_admin only (Step 29 reconciliation queue).
  @Get('admin/reconciliation-queue')
  @Roles('capiro_admin')
  reconciliationQueue(@Query() query: QueryProgramElementsDto) {
    return this.service.listReconciliationQueue(query.status ?? 'open', query.page, query.limit);
  }

  // Resolve a queued conflict. accept_conflicting/manual_value write the chosen value through
  // the writer's manual_override path (canonical update + is_winner flip). capiro_admin only.
  @Post('admin/reconciliation-queue/:id/resolve')
  @Roles('capiro_admin')
  resolveReconciliation(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ResolveReconciliationDto,
  ) {
    return this.service.resolveReconciliation(
      id,
      { decision: body.decision, manualValue: body.manualValue, notes: body.notes },
      ctx,
      async (peCode: string, fy: number, fieldName: string, value: number) => {
        const record: PeYearInput = { peCode, fy };
        (record as unknown as Record<string, unknown>)[fieldName] = value;
        await this.writer.upsertProgramElementYear(record, MANUAL_OVERRIDE_SOURCE);
      },
    );
  }

  // Step 1.4 — cross-PE "needs attention" delta feed (most material first, tenant-relevance
  // boosted at read time). Static route declared before ':peCode' so 'deltas' isn't a peCode.
  @Get('deltas/needs-attention')
  needsAttention(@CurrentTenant() ctx: TenantContext, @Query() query: QueryProgramElementsDto) {
    return this.service.getNeedsAttention(ctx, {
      minScore: query.minScore,
      fy: query.fy,
      limit: query.limit,
    });
  }

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query() query: QueryProgramElementsDto) {
    return this.service.listProgramElements(
      {
        service: query.service,
        budgetActivity: query.budget_activity,
        q: query.q,
        page: query.page,
        limit: query.limit,
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

  // Portfolio-level aggregates for the finder summary strip. Static route declared
  // before ':peCode' so 'summary' is not captured as a peCode.
  @Get('summary')
  summary(@CurrentTenant() ctx: TenantContext, @Query() query: QueryProgramElementsDto) {
    return this.service.getSummary({ service: query.service, hasData: query.has_data }, ctx);
  }

  // PE Watch email-alert preference (PE Watch plan Phase 2). Static routes
  // declared before ':peCode' so 'alerts' is not captured as a peCode.
  @Get('alerts/email-pref')
  getAlertEmailPref(@CurrentTenant() ctx: TenantContext) {
    return this.service.getPeAlertEmailPref(ctx);
  }

  @Put('alerts/email-pref')
  setAlertEmailPref(@CurrentTenant() ctx: TenantContext, @Body() body: SetPeAlertEmailPrefDto) {
    return this.service.setPeAlertEmailPref(body.mode, ctx);
  }

  @Get(':peCode')
  detail(@CurrentTenant() ctx: TenantContext, @Param('peCode') peCode: string) {
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

  // Phase 4 (4.1): the assembled request→marks→enactment narrative for the
  // current cycle (stage-labeled steps + the FY's material moves).
  @Get(':peCode/narrative')
  narrative(@Param('peCode') peCode: string) {
    return this.service.getNarrative(peCode);
  }

  @Get(':peCode/bills')
  bills(@Param('peCode') peCode: string) {
    return this.service.getBills(peCode);
  }

  // LEG-A — full per-bill action history (stored congress_bill_action rows),
  // stage-classified at read time. Powers the Legislation tab's real timeline.
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

  // Secondary Distribution per-recipient procurement line items (P-40). Per
  // (recipient × FY) quantity + obligation authority; empty for RDT&E PEs.
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

  // Step 2.1 — PE→Program graph view for the profile "Programs" panel. Returns
  // accepted + candidate matches separately; quarantined/weak-signal never surfaced.
  @Get(':peCode/programs')
  programs(@Param('peCode') peCode: string) {
    return this.service.getProgramsForPe(peCode);
  }

  // Step 2.4 follow-on — committee-report LANGUAGE provisions linked to this PE
  // (accepted first, then candidate; newest FY first). Empty until the real
  // committee_provisions_* artifacts are loaded (DATA-PENDING).
  @Get(':peCode/provisions')
  provisions(@Param('peCode') peCode: string) {
    return this.service.getProvisionsForPe(peCode);
  }

  // Step 3.1 — ACTIVE SAM.gov procurement notices linked to this PE (accepted +
  // candidate matches on active notices only; quarantined never surfaced). Ordered
  // by responseDeadline ascending, NULLs last (soonest-closing first).
  @Get(':peCode/opportunities')
  opportunities(@Param('peCode') peCode: string) {
    return this.service.getOpportunitiesForPe(peCode);
  }

  // Step 1.3 — budget positions (PB cycle + FYDP outyears). Optional ?fy=<assertedFy>
  // narrows to one fiscal year. Empty until per-FY dollar columns are loaded.
  @Get(':peCode/positions')
  positions(@Param('peCode') peCode: string, @Query('fy') fy?: string) {
    const parsed = fy !== undefined && fy !== '' ? Number(fy) : undefined;
    return this.service.getBudgetPositions(
      peCode,
      parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  // Step 1.3 — PB-vs-prior-PB comparison (per assertedFy delta + new_in_pb /
  // dropped_from_pb flags). Empty until two PB books are loaded.
  @Get(':peCode/pb-comparison')
  pbComparison(@Param('peCode') peCode: string) {
    return this.service.getPbComparison(peCode);
  }

  // Step 1.4 — typed, materiality-scored budget deltas for this PE (live rows, most material
  // first). Optional ?deltaType= and ?fy= filters.
  @Get(':peCode/deltas')
  deltas(@Param('peCode') peCode: string, @Query() query: QueryProgramElementsDto) {
    return this.service.getDeltas(peCode, {
      deltaType: query.deltaType,
      fy: query.fy,
      page: query.page,
      limit: query.limit,
    });
  }

  @Post(':peCode/watch')
  watch(
    @CurrentTenant() ctx: TenantContext,
    @Param('peCode') peCode: string,
    @Body() body: WatchProgramElementDto,
  ) {
    return this.service.setWatching(peCode, body.watching, ctx);
  }
}
