import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { GovernmentForecastsService } from './government-forecasts.service.js';

/** Shared public publisher facts; no client associations or public/portal publication route. */
@Controller('government-forecasts')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class GovernmentForecastsController {
  constructor(private readonly service: GovernmentForecastsService) {}
  @Get()
  list(@Query() query: Record<string, string>) {
    return this.service.list(query);
  }
  @Get(':id/history')
  history(@Param('id') id: string, @Query() query: Record<string, string>) {
    return this.service.history(id, query);
  }
}
