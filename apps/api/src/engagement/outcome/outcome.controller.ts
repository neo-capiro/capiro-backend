import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsISO8601, IsObject, IsOptional, IsString, Length } from 'class-validator';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import type { TenantContext } from '@capiro/shared';
import {
  OUTCOME_KINDS,
  OUTCOME_SOURCE_TYPES,
  OutcomeService,
  type OutcomeKind,
  type OutcomeSourceType,
} from './outcome.service.js';

class RecordOutcomeDto {
  @IsIn(OUTCOME_KINDS as readonly string[]) kind!: OutcomeKind;
  @IsIn(OUTCOME_SOURCE_TYPES as readonly string[]) sourceType!: OutcomeSourceType;
  @IsOptional() @IsString() @Length(1, 200) sourceId?: string;
  @IsOptional() @IsString() @Length(1, 64) clientId?: string;
  @IsOptional() @IsObject() evidence?: Record<string, unknown>;
  @IsOptional() @IsString() @Length(1, 4000) notes?: string;
  @IsOptional() @IsISO8601() observedAt?: string;
}

/**
 * G3 outcome capture (blueprint §3.1 stage 5). POST records what actually
 * happened as a result of the firm's work; GET lists it for the client
 * timeline / reporting. standard_user may record — outcomes are firsthand
 * field observations ("they replied", "we got the meeting"), not governance.
 */
@Controller('engagement/outcomes')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class OutcomeController {
  constructor(private readonly outcomes: OutcomeService) {}

  @Post()
  record(@CurrentTenant() ctx: TenantContext, @Body() dto: RecordOutcomeDto) {
    return this.outcomes.record(ctx, {
      kind: dto.kind,
      sourceType: dto.sourceType,
      sourceId: dto.sourceId ?? null,
      clientId: dto.clientId ?? null,
      evidence: dto.evidence ?? {},
      notes: dto.notes ?? null,
      observedAt: dto.observedAt ? new Date(dto.observedAt) : null,
    });
  }

  @Get()
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('kind') kind?: string,
    @Query('limit') limit?: string,
  ) {
    return this.outcomes.list(ctx, {
      ...(clientId ? { clientId } : {}),
      ...(kind ? { kind } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }
}
