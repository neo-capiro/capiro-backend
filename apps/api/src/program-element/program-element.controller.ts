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
import { randomUUID } from 'node:crypto';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { QueryProgramElementsDto } from './dto/query-program-elements.dto.js';
import { WatchProgramElementDto } from './dto/watch-program-element.dto.js';
import {
  ProgramElementReadService,
  type ReconciliationDecision,
} from './program-element-read.service.js';
import { ProgramElementWriterService } from './program-element-writer.service.js';
import { ProgramElementDataIssueService } from './program-element-data-issue.service.js';
import {
  ManualOverrideRefusalError,
  approveManualOverrideV1,
  canonicalTargetForLegacyPeYearV1,
  proposeManualOverrideV1,
  type ManualOverrideRepositoryV1,
} from '../defense-budget/promotion/manual-override-service-v1.js';
import { MANUAL_OVERRIDE_REPOSITORY_V1 } from '../defense-budget/promotion/manual-override.tokens.js';
import { Inject } from '@nestjs/common';

/**
 * A manual value that can represent money exactly.
 *
 * A JSON number is accepted only when it is an integer, because converting an
 * integer to its decimal string is exact. A fractional number is refused rather
 * than converted — the same rule the canonical projectors apply, and the point
 * at which float error would otherwise enter a governed override.
 */
function exactManualValueOrThrow(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Number.isInteger(value)) return String(value);
  throw new BadRequestException(
    `manualValue must be an exact decimal string; ${value} is a fractional JSON number and cannot represent money exactly`,
  );
}

class SetPeAlertEmailPrefDto {
  /** PE Watch email-alert mode (plan Phase 2). */
  @IsIn(['off', 'daily', 'daily_plus_critical'])
  mode!: string;
}

class ResolveReconciliationDto {
  @IsIn(['keep_current', 'accept_conflicting', 'manual_value'])
  decision!: ReconciliationDecision;

  /**
   * Required for decision=manual_value; an exact decimal string in $ millions.
   *
   * Widened from `number` in Phase 7 Workstream K. This value becomes a governed
   * override, and Phase 7 forbids JavaScript floats anywhere in the promotion
   * path. An integer number is still accepted — converting one to its decimal
   * string is exact, the same rule the canonical projectors apply — but a
   * fractional number is refused rather than converted, because that is
   * precisely where float error enters. `exactManualValueOrThrow` below does
   * that check, so the caller gets a 400 explaining it rather than a constraint
   * violation from deep in the override contract.
   */
  @IsOptional()
  manualValue?: string | number;

  @IsOptional()
  @IsString()
  notes?: string;
}

class CreatePeDataIssueDto {
  @IsIn([
    'value_incorrect',
    'missing_value',
    'wrong_source',
    'wrong_stage_or_vehicle',
    'wrong_pe_attribution',
    'other',
  ])
  issueType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  fy?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  fieldName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  suggestedSourceUrl?: string;
}

class ListPeDataIssuesQueryDto {
  @IsOptional()
  @IsIn(['open', 'resolved', 'dismissed'])
  status?: string;

  @IsOptional()
  @IsString()
  peCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

class ResolvePeDataIssueDto {
  @IsIn(['resolved', 'dismissed'])
  status!: 'resolved' | 'dismissed';

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  resolutionNotes?: string;
}

@Controller('program-elements')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ProgramElementController {
  constructor(
    private readonly service: ProgramElementReadService,
    private readonly writer: ProgramElementWriterService,
    private readonly dataIssues: ProgramElementDataIssueService,
    @Inject(MANUAL_OVERRIDE_REPOSITORY_V1)
    private readonly overrides: ManualOverrideRepositoryV1,
  ) {}

  // Static admin route declared before the ':peCode' dynamic route so 'admin' is
  // not captured as a peCode. capiro_admin only (Step 29 reconciliation queue).
  @Get('admin/reconciliation-queue')
  @Roles('capiro_admin')
  reconciliationQueue(@Query() query: QueryProgramElementsDto) {
    return this.service.listReconciliationQueue(query.status ?? 'open', query.page, query.limit);
  }

  // Tenant-scoped PE data issues (Phase I / closeout Phase 6). Admin list is still
  // RLS'd to the caller's tenant — no cross-tenant scan here.
  @Get('admin/data-issues')
  @Roles('capiro_admin')
  listDataIssuesAdmin(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListPeDataIssuesQueryDto,
  ) {
    return this.dataIssues.listAdmin(ctx, {
      status: query.status,
      peCode: query.peCode,
      page: query.page,
      limit: query.limit,
    });
  }

  @Post('admin/data-issues/:id/resolve')
  @Roles('capiro_admin')
  resolveDataIssue(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ResolvePeDataIssueDto,
  ) {
    return this.dataIssues.resolve(
      id,
      { status: body.status, resolutionNotes: body.resolutionNotes },
      ctx,
    );
  }

  /**
   * Propose a correction for a queued conflict. capiro_admin only.
   *
   * Phase 7 Workstream K: this no longer writes anything canonical. It records a
   * governed override in the `proposed` state and parks the entry at
   * `pending_approval`; a second capiro_admin puts it in force via the approve
   * route below. `keep_current` still resolves outright — there is no correction
   * to govern.
   *
   * `ProgramElementWriterService` is deliberately not called. The old path wrote
   * through it under a `manual_override` source string, which made a human
   * decision indistinguishable from a parsed J-book line and flipped a winner
   * flag on the strength of one person's judgement.
   */
  @Post('admin/reconciliation-queue/:id/resolve')
  @Roles('capiro_admin')
  resolveReconciliation(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ResolveReconciliationDto,
  ) {
    return this.service.resolveReconciliation(
      id,
      {
        decision: body.decision,
        manualValue: exactManualValueOrThrow(body.manualValue),
        notes: body.notes,
      },
      ctx,
      async (entry, exactValue) => {
        try {
          const record = await proposeManualOverrideV1(
            {
              overrideId: randomUUID(),
              target: canonicalTargetForLegacyPeYearV1(entry),
              value: {
                // The queue stores $ millions, so the printed figure and the
                // normalized millions figure are the same string.
                originalValue: exactValue,
                originalUnit: 'millions',
                valueMillions: exactValue,
              },
              authorActorId: ctx.userId,
              reason: body.notes?.trim() || 'reconciliation queue resolution',
              evidenceIds: [`reconciliation_review_queue:${id}`],
              effectiveFrom: new Date().toISOString(),
              proposedAt: new Date().toISOString(),
            },
            this.overrides,
          );
          return record.overrideId;
        } catch (error) {
          // A governed refusal is the caller's fault, not a server fault.
          if (error instanceof ManualOverrideRefusalError) {
            throw new BadRequestException(`${error.reason}: ${error.message}`);
          }
          throw error;
        }
      },
    );
  }

  /**
   * Approve a proposed correction, putting it in force. capiro_admin only, and
   * necessarily a different admin from the one who proposed it — the override
   * contract, a CHECK constraint, and a lifecycle trigger each refuse otherwise.
   */
  @Post('admin/reconciliation-queue/:id/approve')
  @Roles('capiro_admin')
  approveReconciliation(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.approveReconciliation(id, ctx, async (overrideId: string) => {
      try {
        await approveManualOverrideV1(
          {
            overrideId,
            approverActorId: ctx.userId,
            approverRole: ctx.role,
            approvedAt: new Date().toISOString(),
          },
          this.overrides,
        );
      } catch (error) {
        if (error instanceof ManualOverrideRefusalError) {
          throw new BadRequestException(`${error.reason}: ${error.message}`);
        }
        throw error;
      }
    });
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

  // Phase I / closeout Phase 6 — tenant analyst feedback (does not mutate PE dollars).
  @Get(':peCode/data-issues')
  listDataIssues(
    @CurrentTenant() ctx: TenantContext,
    @Param('peCode') peCode: string,
    @Query() query: ListPeDataIssuesQueryDto,
  ) {
    return this.dataIssues.listForPe(peCode, ctx, {
      status: query.status,
      page: query.page,
      limit: query.limit,
    });
  }

  @Post(':peCode/data-issues')
  createDataIssue(
    @CurrentTenant() ctx: TenantContext,
    @Param('peCode') peCode: string,
    @Body() body: CreatePeDataIssueDto,
  ) {
    return this.dataIssues.create(
      peCode,
      {
        issueType: body.issueType,
        description: body.description,
        fy: body.fy,
        fieldName: body.fieldName,
        suggestedSourceUrl: body.suggestedSourceUrl,
      },
      ctx,
    );
  }
}
