import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../../tenant/current-tenant.decorator.js';
import { ObjectiveOperationalGuard } from '../operational/objective-operational.guard.js';
import { ObjectiveQuestionsService } from './objective-questions.service.js';

@Controller('clients/:clientId/objectives/:objectiveId/questions')
@UseGuards(ObjectiveOperationalGuard)
export class ObjectiveQuestionsController {
  constructor(private readonly service: ObjectiveQuestionsService) {}
  @Get()
  list(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') client: string,
    @Param('objectiveId') objective: string,
    @Query('after') after?: string,
    @Query('status') status?: string,
  ) {
    return this.service.list(ctx, client, objective, after, status);
  }
  @Get('history/:questionId')
  history(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') client: string,
    @Param('objectiveId') objective: string,
    @Param('questionId') id: string,
    @Query('before') before?: string,
  ) {
    return this.service.history(ctx, client, objective, id, before);
  }
  @Get('receipts/:requestId')
  receipt(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') client: string,
    @Param('objectiveId') objective: string,
    @Param('requestId') request: string,
  ) {
    return this.service.receipt(ctx, client, objective, request);
  }
  @Post()
  command(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') client: string,
    @Param('objectiveId') objective: string,
    @Body() body: unknown,
  ) {
    return this.service.command(ctx, client, objective, body);
  }
}
