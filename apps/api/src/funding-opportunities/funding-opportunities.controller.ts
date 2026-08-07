import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import {
  FundingOpportunitiesFlagGuard,
  FundingOpportunitiesForecastFlagGuard,
  FundingOpportunitiesInboxFlagGuard,
  FundingOpportunitiesDocumentsFlagGuard,
  FundingOpportunitiesNoticeHistoryFlagGuard,
} from './funding-opportunities-flag.guard.js';
import { OpportunityRequirementService } from './requirements/opportunity-requirement.service.js';
import { OpportunityTimelineService } from './opportunity-timeline.service.js';
import {
  FundingOpportunityInboxService,
  INBOX_FILTERS,
  INBOX_MAX_PAGE_SIZE,
  INBOX_SOURCES,
  type InboxFilter,
  type InboxSource,
} from './funding-opportunity-inbox.service.js';
import { ForecastOpportunityReadService } from './forecast-opportunity-read.service.js';
import {
  FundingOpportunitiesService,
  type OpportunityQuery,
} from './funding-opportunities.service.js';
import {
  FundingOpportunityActionsService,
  OPPORTUNITY_ACTION_INTENTS,
  type OpportunityActionIntent,
} from './funding-opportunity-actions.service.js';
import {
  ELIGIBILITY_STATES,
  HUMAN_DECISIONS,
  OPPORTUNITY_KINDS,
  OPPORTUNITY_SOURCES,
  OPPORTUNITY_WORKFLOW_STATUSES,
  type HumanDecision,
  type OpportunityKind,
  type OpportunitySource,
  type OpportunityWorkflowStatus,
} from './funding-opportunities.types.js';

/** Comma-separated or repeated query param → trimmed string array. */
function csv(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const out = raw.map((v) => String(v).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

class OpportunityListQueryDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsIn(OPPORTUNITY_SOURCES)
  source?: OpportunitySource;

  @IsOptional()
  @Transform(({ value }) => csv(value))
  @IsArray()
  @IsIn(OPPORTUNITY_KINDS, { each: true })
  kind?: OpportunityKind[];

  @IsOptional()
  @Transform(({ value }) => csv(value))
  @IsArray()
  @IsIn(OPPORTUNITY_WORKFLOW_STATUSES, { each: true })
  workflowStatus?: OpportunityWorkflowStatus[];

  @IsOptional()
  @IsIn(['active', 'closed', 'all'])
  activeState?: 'active' | 'closed' | 'all';

  // Free-text filters are length-capped: they are used as `includes()` needles
  // over an in-memory list, and an unbounded string is a pointless payload, not
  // a useful filter.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  agency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  naics?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  psc?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  setAside?: string;

  @IsOptional()
  @IsISO8601()
  deadlineFrom?: string;

  @IsOptional()
  @IsISO8601()
  deadlineTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  minRelevance?: number;

  @IsOptional()
  @Transform(({ value }) => csv(value))
  @IsArray()
  @IsIn(ELIGIBILITY_STATES, { each: true })
  eligibility?: Array<(typeof ELIGIBILITY_STATES)[number]>;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Bounded here AND clamped in the service. The DTO rejects an absurd request
  // with a 400 (which is the honest answer to "give me 10,000 rows"), and the
  // service clamp is the backstop for any non-HTTP caller.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

class SaveOpportunityDto {
  // 'suggested' is deliberately NOT accepted: it is the producer's own output,
  // and a user action is by definition not a machine suggestion.
  @IsOptional()
  @IsIn(['saved', 'pursuing', 'won', 'lost'])
  status?: 'saved' | 'pursuing' | 'won' | 'lost';

  @IsOptional()
  @IsUUID()
  ownerUserId?: string | null;

  @IsOptional()
  @IsUUID()
  facilityId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  outcomeNote?: string | null;
}

class PatchOpportunityDto {
  @IsOptional()
  @IsIn(['saved', 'pursuing', 'won', 'lost'])
  status?: 'saved' | 'pursuing' | 'won' | 'lost';

  @IsOptional()
  @IsUUID()
  ownerUserId?: string | null;

  @IsOptional()
  @IsUUID()
  facilityId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  outcomeNote?: string | null;
}

/**
 * The decision body.
 *
 * A DEDICATED DTO, not a widening of PatchOpportunityDto. `decision` is REQUIRED:
 * a decision request that forgot to say what was decided is a mistake, not a
 * partial update, and an optional field here would let one through as a no-op that
 * still stamped an actor and timestamp.
 *
 * There is no `clientId`, `source` or `id` in the body. All three come from the
 * path, so a request cannot name one opportunity in its URL and another in its
 * payload — the same reason P05 removed `id` from the mapping DTO.
 */
class DecideOpportunityDto {
  @IsIn(HUMAN_DECISIONS)
  decision!: HumanDecision;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  nextAction?: string;

  /**
   * ISO-8601. Rejected by the service when `nextAction` is absent — a due date
   * with no action is a reminder about nothing.
   */
  @IsOptional()
  @IsISO8601()
  nextActionDueAt?: string;
}

/**
 * The atomic action body.
 *
 * `intent` is required and bounded. It is the only thing that distinguishes a
 * review from a pursuit, and both the decision recorded and the task's idempotency
 * key derive from it — so an optional intent would mean guessing which action a
 * caller meant.
 *
 * There is no idempotency key in the body: it is DERIVED from
 * (source, sourceRecordId, intent) inside the service, so two clients cannot
 * disagree about what "the same action" is.
 */
class OpportunityActionDto {
  @IsIn(OPPORTUNITY_ACTION_INTENTS)
  intent!: OpportunityActionIntent;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  nextAction?: string;
}

/**
 * Inbox query.
 *
 * `cursor` is OPAQUE — base64 of `(sortValue, id)`. It is validated as a string
 * here and decoded in the service, which throws a 400 naming the fix rather than a
 * 500, because a hand-built cursor is a client bug worth telling somebody about.
 */
class InboxQueryDto {
  @IsOptional()
  @IsIn(INBOX_FILTERS)
  filter?: InboxFilter;

  /**
   * Narrow the cross-client inbox to one client.
   *
   * The service intersects this with the ethical wall and silently drops an id the
   * actor cannot see, echoing what it actually applied. It is NOT a tenant or
   * authorisation input — tenant still comes from `@CurrentTenant()` only.
   */
  @IsOptional()
  @IsUUID()
  clientId?: string;

  /**
   * Narrow to one rail. A FILTER, never the top-level model — the inbox is
   * organised by what needs deciding, not by which catalog a row came from.
   *
   * Validated against `INBOX_SOURCES`, which includes `agency_forecast` (P26)
   * and is deliberately WIDER than the `OPPORTUNITY_SOURCES` every other DTO in
   * this file uses — see that constant's own doc. A narrowing filter can only
   * ever remove rows, so admitting a third value here cannot widen what the
   * inbox returns.
   */
  @IsOptional()
  @IsIn(INBOX_SOURCES)
  source?: InboxSource;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INBOX_MAX_PAGE_SIZE)
  pageSize?: number;
}

class DismissOpportunityDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string | null;
}

class SourceParamDto {
  @IsIn(OPPORTUNITY_SOURCES)
  source!: OpportunitySource;
}

/**
 * Funding Opportunities.
 *
 * ── Roles ────────────────────────────────────────────────────────────────────
 *
 * `@Roles('standard_user')` at the class level, and RolesGuard grants access at
 * or above the lowest required rank — so standard_user, user_admin and
 * capiro_admin all reach every route here, which is the intent: reading,
 * saving, pursuing, dismissing, assigning and note-taking are the daily work of
 * a standard user, not admin curation.
 *
 * `client_portal_user` ranks BELOW standard_user in ROLE_RANK, so it is denied
 * every route by that same comparison — deliberately, per the product rule that
 * a portal user gets nothing here unless an existing rule says otherwise. There
 * is no separate portal read path in this module to leak through.
 *
 * MAPPING MANAGEMENT IS NOT HERE. The contractor-identity actions that need
 * `user_admin` live on IntelligenceController alongside the existing mapping
 * routes, because splitting one review surface across two controllers with two
 * different guards is how a route ends up gated by neither.
 *
 * ── Tenant safety ───────────────────────────────────────────────────────────
 *
 * Tenant and actor come from `@CurrentTenant()` on every route. No route accepts
 * a tenant id in a body, a param or a query — the only tenant that exists to a
 * request is the authenticated one. The service re-verifies client ownership,
 * facility→client ownership and owner→tenant membership before any write.
 */
@Controller('intelligence')
@UseGuards(RolesGuard, FundingOpportunitiesFlagGuard)
@Roles('standard_user')
export class FundingOpportunitiesController {
  constructor(
    private readonly service: FundingOpportunitiesService,
    private readonly actions: FundingOpportunityActionsService,
    private readonly inboxService: FundingOpportunityInboxService,
    private readonly forecasts: ForecastOpportunityReadService,
    private readonly timeline: OpportunityTimelineService,
    private readonly requirements: OpportunityRequirementService,
  ) {}

  /** The catalog view. Scored for `clientId` when one is supplied. */
  /**
   * The cross-client triage inbox.
   *
   * Declared BEFORE `opportunities/:source/:id` for clarity, though the two cannot
   * actually collide: `inbox` is one path segment and that route needs two.
   *
   * TWO guards. The class-level guard proves the tenant has Funding Opportunities
   * at all; this one proves they have the inbox specifically. A tenant already
   * using the catalog must be able to keep it while the inbox is canaried, and
   * turning the inbox on must never be a side effect of turning the feature on.
   *
   * Raw catalog exploration stays on `GET opportunities` — this replaces the
   * DEFAULT experience, not the research tool.
   */
  @Get('opportunities/inbox')
  @UseGuards(FundingOpportunitiesInboxFlagGuard)
  inbox(@CurrentTenant() ctx: TenantContext, @Query() query: InboxQueryDto) {
    return this.inboxService.list(ctx.tenantId, ctx.userId, {
      filter: query.filter,
      cursor: query.cursor,
      pageSize: query.pageSize,
      clientId: query.clientId,
      source: query.source,
    });
  }

  /**
   * One agency procurement forecast, optionally scored for a client (P26).
   *
   * A SEPARATE route from `opportunities/:source/:id`, not a widening of it — a
   * forecast has no response deadline, no eligibility determination and no
   * money, and returning it as a `FundingOpportunity` would mean either
   * inventing those three or shipping a record whose empty eligibility field
   * reads as "not eligible". See `forecast-opportunity-read.service.ts`.
   *
   * Declared BEFORE `opportunities/:source/:id` so `opportunities/forecasts/:id`
   * cannot be captured by it — `:source` would happily match the literal
   * `forecasts` and hand the id to a rail that does not exist.
   *
   * THREE guards, and the middle one is the point: the class-level guard proves
   * the tenant has Funding Opportunities, and this one proves they have agency
   * forecasts specifically. With `funding_opportunities_forecasts` off — which
   * is every tenant today — this 404s exactly like a route that was never
   * deployed.
   */
  @Get('opportunities/forecasts/:forecastId')
  @UseGuards(FundingOpportunitiesForecastFlagGuard)
  forecast(
    @CurrentTenant() ctx: TenantContext,
    @Param('forecastId') forecastId: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.forecasts.getForecast(
      ctx.tenantId,
      ctx.userId,
      forecastId,
      clientId ?? null,
    );
  }

  @Get('opportunities')
  list(@CurrentTenant() ctx: TenantContext, @Query() q: OpportunityListQueryDto) {
    return this.service.listOpportunities(ctx.tenantId, q as OpportunityQuery);
  }

  /**
   * One opportunity. `source` is a path segment rather than a query param
   * because the two catalogs have different key spaces — a bare id could be
   * routed to the wrong rail and 404 for a record that exists.
   */
  /**
   * The notice history for one SAM.gov solicitation, as a material-change
   * timeline (P28).
   *
   * Declared BEFORE `opportunities/:source/:id` — a three-segment route cannot
   * collide with a two-segment one, but keeping the timeline next to the
   * forecast route reads better than burying it below the writes.
   *
   * READ-ONLY, and it emits nothing: no alert, no task, no write. Alerting on a
   * material change is P48's job, deliberately not this phase's.
   */
  @Get('opportunities/:source/:id/timeline')
  @UseGuards(FundingOpportunitiesNoticeHistoryFlagGuard)
  timelineFor(@Param() params: SourceParamDto, @Param('id') id: string) {
    return this.timeline.getTimeline(params.source, id);
  }

  /**
   * The requirements extracted from one solicitation's own documents (P31).
   *
   * READ-ONLY, and every row carries its citation — there is no shape in the
   * response that returns a statement without the excerpt, the span and the
   * document it came from.
   *
   * The REQUIREMENT is a global fact about a public document; the REVIEW is this
   * tenant's decision, read under RLS. A requirement with no review for this
   * tenant reads as `pending`, never as another tenant's conclusion.
   */
  @Get('opportunities/:source/:id/requirements')
  @UseGuards(FundingOpportunitiesDocumentsFlagGuard)
  requirementsFor(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: SourceParamDto,
    @Param('id') id: string,
  ) {
    return this.requirements.getRequirements(ctx.tenantId, params.source, id);
  }

  @Get('opportunities/:source/:id')
  getOne(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: SourceParamDto,
    @Param('id') id: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.service.getOpportunity(ctx.tenantId, params.source, id, clientId ?? null);
  }

  @Get('clients/:clientId/opportunities')
  listForClient(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query() q: OpportunityListQueryDto,
  ) {
    return this.service.listClientOpportunities(ctx.tenantId, clientId, {
      ...(q as OpportunityQuery),
      clientId,
    });
  }

  /** The persistent client-profile card. Always returns a payload. */
  @Get('clients/:clientId/opportunities/summary')
  summaryForClient(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getClientSummary(ctx.tenantId, clientId);
  }

  @Post('clients/:clientId/opportunities/:source/:id/save')
  save(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param() params: SourceParamDto,
    @Param('id') id: string,
    @Body() body: SaveOpportunityDto,
  ) {
    return this.service.setWorkflowStatus(ctx.tenantId, clientId, params.source, id, {
      status: body.status ?? 'saved',
      actorUserId: ctx.userId,
      ...(body.ownerUserId !== undefined ? { ownerUserId: body.ownerUserId } : {}),
      ...(body.facilityId !== undefined ? { facilityId: body.facilityId } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.outcomeNote !== undefined ? { outcomeNote: body.outcomeNote } : {}),
    });
  }

  @Patch('clients/:clientId/opportunities/:source/:id')
  patch(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param() params: SourceParamDto,
    @Param('id') id: string,
    @Body() body: PatchOpportunityDto,
  ) {
    return this.service.patchWorkflow(ctx.tenantId, clientId, params.source, id, {
      actorUserId: ctx.userId,
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.ownerUserId !== undefined ? { ownerUserId: body.ownerUserId } : {}),
      ...(body.facilityId !== undefined ? { facilityId: body.facilityId } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.outcomeNote !== undefined ? { outcomeNote: body.outcomeNote } : {}),
    });
  }

  /**
   * Record the team's decision. Separate route from the generic PATCH because a
   * decision is one atomic assertion that always carries its actor and timestamp,
   * not a subset of independently-optional fields.
   *
   * `standard_user` deliberately: deciding whether to bid is the everyday work of
   * the people who use this feature. Admin-only here would push the decision to
   * somebody who is not doing the pursuing. (Contrast P05's mapping approval, which
   * IS admin-only — that attributes federal award money rather than recording a
   * team's own intent.)
   */
  @Post('clients/:clientId/opportunities/:source/:id/decision')
  decide(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param() params: SourceParamDto,
    @Param('id') id: string,
    @Body() body: DecideOpportunityDto,
  ) {
    return this.service.decide(ctx.tenantId, clientId, params.source, id, {
      decision: body.decision,
      actorUserId: ctx.userId,
      reason: body.reason ?? null,
      ...(body.nextAction !== undefined ? { nextAction: body.nextAction } : {}),
      ...(body.nextActionDueAt !== undefined ? { nextActionDueAt: body.nextActionDueAt } : {}),
    });
  }

  /**
   * Create the task AND record the decision, atomically.
   *
   * Replaces the web page's direct POST to `/api/engagement/tasks`, which created a
   * task titled "Pursue: X" while leaving the opportunity an untouched machine
   * suggestion — two facts in two tables written by two requests, either able to
   * succeed alone.
   *
   * Retrying with the same intent returns the SAME task rather than a second one.
   */
  @Post('clients/:clientId/opportunities/:source/:id/action')
  act(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param() params: SourceParamDto,
    @Param('id') id: string,
    @Body() body: OpportunityActionDto,
  ) {
    return this.actions.act(ctx.tenantId, clientId, params.source, id, {
      intent: body.intent,
      actorUserId: ctx.userId,
      ...(body.ownerUserId !== undefined ? { ownerUserId: body.ownerUserId } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.nextAction !== undefined ? { nextAction: body.nextAction } : {}),
    });
  }

  @Post('clients/:clientId/opportunities/:source/:id/dismiss')
  dismiss(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param() params: SourceParamDto,
    @Param('id') id: string,
    @Body() body: DismissOpportunityDto,
  ) {
    return this.service.dismiss(ctx.tenantId, clientId, params.source, id, {
      actorUserId: ctx.userId,
      reason: body.reason ?? null,
    });
  }

  @Post('clients/:clientId/opportunities/:source/:id/restore')
  restore(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param() params: SourceParamDto,
    @Param('id') id: string,
  ) {
    return this.service.restore(ctx.tenantId, clientId, params.source, id, {
      actorUserId: ctx.userId,
    });
  }
}
