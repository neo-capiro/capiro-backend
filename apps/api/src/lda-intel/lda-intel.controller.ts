import { Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import type { TenantContext } from '@capiro/shared';
import { LdaIntelService } from './lda-intel.service.js';

class FilingsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2021)
  @Max(2030)
  year?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  issue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  client?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  registrant?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class ClientsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  issue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  state?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class SearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class CongressBillsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  policyArea?: string;

  @IsOptional()
  @IsString()
  activeSince?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(200)
  congress?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class ContributionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2021)
  @Max(2030)
  year?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  registrant?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  lobbyist?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class InsightsQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['lda', 'spending', 'congress', 'regulatory', 'anomaly'])
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/**
 * Read-only Senate LDA federal lobbying intelligence API.
 * Auth required (standard_user+). Data is global / cross-tenant.
 */
@Controller('lda-intel')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LdaIntelController {
  constructor(private readonly service: LdaIntelService) {}

  @Get('dashboard')
  dashboard() {
    return this.service.getDashboard();
  }

  @Get('filings')
  filings(@Query() q: FilingsQueryDto) {
    return this.service.getFilings({
      year: q.year,
      issueCode: q.issue,
      clientName: q.client,
      registrantName: q.registrant,
      page: q.page,
      limit: q.limit,
    });
  }

  @Get('filings/:uuid')
  filing(@Param('uuid') uuid: string) {
    return this.service.getFilingByUuid(uuid);
  }

  @Get('clients')
  clients(@Query() q: ClientsQueryDto) {
    return this.service.getClients(q.q, q.issue, q.state, q.page, q.limit);
  }

  @Get('clients/:id')
  clientDetail(@Param('id', ParseIntPipe) id: number) {
    return this.service.getClientDetail(id);
  }

  @Get('clients/:id/filings')
  clientFilings(@Param('id', ParseIntPipe) id: number, @Query() q: SearchQueryDto) {
    return this.service.getClientFilings(id, q.page, q.limit);
  }

  @Get('registrants')
  registrants(@Query() q: SearchQueryDto) {
    return this.service.getRegistrants(q.q, q.page, q.limit);
  }

  @Get('registrants/:id')
  registrant(@Param('id', ParseIntPipe) id: number) {
    return this.service.getRegistrantById(id);
  }

  @Get('lobbyists')
  lobbyists(@Query() q: SearchQueryDto) {
    return this.service.getLobbyists(q.q, q.page, q.limit);
  }

  @Get('lobbyists/:id')
  lobbyist(@Param('id', ParseIntPipe) id: number) {
    return this.service.getLobbyistById(id);
  }

  @Get('issues')
  issues() {
    return this.service.getIssues();
  }

  @Get('issues/:code')
  issueDetail(@Param('code') code: string) {
    return this.service.getIssueDetail(code.toUpperCase());
  }

  @Get('entities')
  entities() {
    return this.service.getEntities();
  }

  @Get('contributions')
  contributions(@Query() q: ContributionsQueryDto) {
    return this.service.getContributions({
      year: q.year,
      registrantName: q.registrant,
      lobbyistName: q.lobbyist,
      page: q.page,
      limit: q.limit,
    });
  }

  @Get('trends')
  trends() {
    return this.service.getTrends();
  }

  @Get('match/:clientName')
  matchClient(@Param('clientName') clientName: string) {
    return this.service.matchCapiroClient(decodeURIComponent(clientName));
  }

  @Get('congress/bills')
  congressBills(@Query() q: CongressBillsQueryDto) {
    return this.service.getCongressBills(
      q.q,
      q.policyArea,
      q.congress,
      q.page,
      q.limit,
      q.activeSince,
    );
  }

  @Get('fec/committees')
  fecCommittees(@Query() q: SearchQueryDto) {
    return this.service.getFecCommittees(q.q, q.page, q.limit);
  }

  @Get('lobbyists/:id/positions')
  lobbyistPositions(@Param('id', ParseIntPipe) id: number) {
    return this.service.getLobbyistPositions(id);
  }

  @Get('clients/:id/network')
  clientNetwork(@Param('id', ParseIntPipe) id: number) {
    return this.service.getClientNetwork(id);
  }

  @Get('insights')
  getInsights(@CurrentTenant() ctx: TenantContext, @Query() q: InsightsQueryDto) {
    // GAI-01: scope to the caller's tenant (RLS returns own-tenant + public).
    return this.service.getInsights(ctx.tenantId, q.category, q.limit);
  }

  @Post('insights/generate')
  generateInsights() {
    return { message: 'Insight generation triggered', status: 'queued' };
  }

  @Get('congress/bills/:id')
  congressBillDetail(@Param('id') id: string) {
    return this.service.getCongressBillDetail(id);
  }
}
