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
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';
import {
  FundingOpportunitiesService,
  type OpportunityQuery,
} from './funding-opportunities.service.js';
import {
  ELIGIBILITY_STATES,
  OPPORTUNITY_KINDS,
  OPPORTUNITY_SOURCES,
  OPPORTUNITY_WORKFLOW_STATUSES,
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
  constructor(private readonly service: FundingOpportunitiesService) {}

  /** The catalog view. Scored for `clientId` when one is supplied. */
  @Get('opportunities')
  list(@CurrentTenant() ctx: TenantContext, @Query() q: OpportunityListQueryDto) {
    return this.service.listOpportunities(ctx.tenantId, q as OpportunityQuery);
  }

  /**
   * One opportunity. `source` is a path segment rather than a query param
   * because the two catalogs have different key spaces — a bare id could be
   * routed to the wrong rail and 404 for a record that exists.
   */
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
