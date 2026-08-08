import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachCommandEngineService } from '../services/outreach-command-engine.service.js';
import { OutreachCommandProposalService } from '../services/outreach-command-proposal.service.js';
import { OutreachV3StateGuard } from './outreach-v3-state.guard.js';
import { OutreachV3ExceptionFilter } from './outreach-v3-exception.filter.js';

class CreateOutreachV3SessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  title?: string;
}

class ListOutreachV3SessionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  includeArchived?: boolean;
}

class ListOutreachV3HistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class ApplyOutreachV3CommandsDto {
  @IsUUID()
  batchId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedStateVersion!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  commands!: unknown[];
}

class CreateOutreachV3ProposalDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedStateVersion!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  commands!: unknown[];
}

class RejectOutreachV3ProposalDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  rejectionCode?: string;
}

@Controller('engagement/outreach-v3')
@UseGuards(OutreachV3StateGuard, RolesGuard)
@UseFilters(OutreachV3ExceptionFilter)
@Roles('standard_user')
export class OutreachV3StateController {
  constructor(
    private readonly sessions: OutreachSessionService,
    private readonly commands: OutreachCommandEngineService,
    private readonly proposals: OutreachCommandProposalService,
  ) {}

  @Post('sessions')
  createSession(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: CreateOutreachV3SessionDto,
  ) {
    return this.sessions.createSession(ctx, body);
  }

  @Get('sessions')
  listSessions(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListOutreachV3SessionsQueryDto,
  ) {
    return this.sessions.listSessions(ctx, query);
  }

  @Get('sessions/:sessionId')
  getSession(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.sessions.getSession(ctx, sessionId);
  }

  @Post('sessions/:sessionId/archive')
  archiveSession(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.sessions.archiveSession(ctx, sessionId);
  }

  @Post('sessions/:sessionId/commands')
  applyCommands(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: ApplyOutreachV3CommandsDto,
  ) {
    return this.commands.applyBatch(ctx, sessionId, body);
  }

  @Get('sessions/:sessionId/versions')
  listVersions(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query() query: ListOutreachV3HistoryQueryDto,
  ) {
    return this.sessions.listVersions(ctx, sessionId, query.limit);
  }

  @Get('sessions/:sessionId/versions/:version')
  getVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.sessions.getVersion(ctx, sessionId, version);
  }

  @Get('sessions/:sessionId/events')
  listEvents(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query() query: ListOutreachV3HistoryQueryDto,
  ) {
    return this.sessions.listEvents(ctx, sessionId, query.limit);
  }

  @Post('sessions/:sessionId/proposals')
  createProposal(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: CreateOutreachV3ProposalDto,
  ) {
    return this.proposals.createProposal(ctx, sessionId, body);
  }

  @Get('sessions/:sessionId/proposals')
  listProposals(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query() query: ListOutreachV3HistoryQueryDto,
  ) {
    return this.proposals.listProposals(ctx, sessionId, query.limit);
  }

  @Post('sessions/:sessionId/proposals/:proposalId/apply')
  applyProposal(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
  ) {
    return this.proposals.applyProposal(ctx, sessionId, proposalId);
  }

  @Post('sessions/:sessionId/proposals/:proposalId/reject')
  rejectProposal(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: RejectOutreachV3ProposalDto,
  ) {
    return this.proposals.rejectProposal(
      ctx,
      sessionId,
      proposalId,
      body.rejectionCode,
    );
  }
}
