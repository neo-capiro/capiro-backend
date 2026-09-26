import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { IsBoolean, IsIn, IsString, Length } from 'class-validator';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import {
  DefenseBudgetClientWatchService,
  type BudgetWatchTargetType,
} from './defense-budget-client-watch.service.js';

class SubscribeBudgetWatchDto {
  @IsIn(['program', 'pe', 'project', 'capability'])
  targetType!: BudgetWatchTargetType;

  @IsString()
  @Length(1, 160)
  targetKey!: string;

  @IsString()
  @Length(1, 2000)
  clientReason!: string;
}

class SetBudgetWatchSubscriptionDto {
  @IsBoolean()
  subscribed!: boolean;
}

class DecideBudgetWatchUpdateDto {
  @IsIn(['acknowledged', 'dismissed'])
  decision!: 'acknowledged' | 'dismissed';
}

@Controller('clients/:clientId/defense-budget-watches')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class DefenseBudgetClientWatchController {
  constructor(private readonly watches: DefenseBudgetClientWatchService) {}

  @Get()
  list(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
  ) {
    return this.watches.list(ctx, clientId);
  }

  @Post()
  subscribe(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
    @Body() body: SubscribeBudgetWatchDto,
  ) {
    return this.watches.subscribe(ctx, { clientId, ...body });
  }

  @Post(':watchId/subscription')
  setSubscribed(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
    @Param('watchId', new ParseUUIDPipe()) watchId: string,
    @Body() body: SetBudgetWatchSubscriptionDto,
  ) {
    return this.watches.setSubscribed(ctx, { clientId, watchId, subscribed: body.subscribed });
  }

  @Post(':watchId/updates/:updateEventId/decision')
  decide(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
    @Param('watchId', new ParseUUIDPipe()) watchId: string,
    @Param('updateEventId', new ParseUUIDPipe()) updateEventId: string,
    @Body() body: DecideBudgetWatchUpdateDto,
  ) {
    return this.watches.decide(ctx, { clientId, watchId, updateEventId, decision: body.decision });
  }
}
