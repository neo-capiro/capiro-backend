import { Body, Controller, Get, Headers, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { OutreachCampaignService } from './outreach-campaign.service.js';

@Controller('engagement/outreach')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class OutreachCampaignController {
  constructor(private readonly campaigns: OutreachCampaignService) {}
  @Get('campaigns')
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('requestKey') requestKey?: string,
  ) {
    return this.campaigns.list(ctx, clientId, requestKey);
  }
  @Post('campaigns')
  create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return this.campaigns.create(ctx, body);
  }
  @Get('campaigns/:id')
  get(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.campaigns.get(ctx, id);
  }
  @Put('campaigns/:id')
  save(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    return this.campaigns.save(ctx, id, body);
  }
  @Post('campaigns/:id/generate')
  generate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    return this.campaigns.generate(ctx, id, body);
  }
  @Get('campaigns/:id/jobs')
  job(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('requestKey') requestKey: string,
  ) {
    return this.campaigns.findJob(ctx, id, requestKey);
  }
  @Get('campaigns/:id/send-intents')
  send(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('requestKey') requestKey: string,
  ) {
    return this.campaigns.findSend(ctx, id, requestKey);
  }
  @Post('sdk/claim')
  claim(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    return this.campaigns.claim(ctx, body, authorization);
  }
  @Post('sdk/read')
  read(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    return this.campaigns.read(ctx, body, authorization);
  }
  @Post('sdk/complete')
  complete(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    return this.campaigns.complete(ctx, body, authorization);
  }
  @Post('sdk/fail')
  fail(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return this.campaigns.fail(ctx, body);
  }
}
