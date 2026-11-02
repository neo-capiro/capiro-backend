import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../../tenant/current-tenant.decorator.js';
import { ObjectiveOperationalGuard } from '../operational/objective-operational.guard.js';
import { ObjectiveQuestionsService } from './objective-questions.service.js';

@Controller('clients/:clientId/objectives/:objectiveId/questions')
@UseGuards(ObjectiveOperationalGuard)
export class ObjectiveQuestionsController {
  constructor(private readonly service: ObjectiveQuestionsService) {}
  @Get('evidence')
  evidenceList(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') client: string,
    @Param('objectiveId') objective: string,
    @Query('kind') kind?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.evidenceList(ctx, client, objective, kind, search, cursor);
  }
  @Post('evidence/preview')
  evidencePreview(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') client: string,
    @Param('objectiveId') objective: string,
    @Body() body: unknown,
  ) {
    return this.service.evidencePreview(ctx, client, objective, body);
  }
  @Post('evidence/document-history')
  evidenceHistory(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') client: string,
    @Param('objectiveId') objective: string,
    @Body() body: unknown,
  ) {
    return this.service.evidenceHistory(ctx, client, objective, body);
  }
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
