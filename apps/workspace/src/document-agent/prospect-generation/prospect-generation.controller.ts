import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { ProspectGenerationService } from './prospect-generation.service.js';

const credential = (header?: string) =>
  header?.startsWith('Bearer ') ? header.slice(7) : undefined;

@Controller('drafts/:draftId/prospect-generation')
@UseGuards(TenantGuard)
export class ProspectGenerationController {
  constructor(private readonly generation: ProspectGenerationService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Query('prospectId', ParseUUIDPipe) prospectId: string,
  ) {
    return this.generation.list(ctx.tenantId, draftId, prospectId, ctx.clerkUserId);
  }
  @Get(':proposalId')
  @Header('Cache-Control', 'no-store')
  read(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Query('prospectId', ParseUUIDPipe) prospectId: string,
  ) {
    return this.generation.read(ctx.tenantId, draftId, prospectId, ctx.clerkUserId, proposalId);
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  generate(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    return this.generation.generate(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      body,
      credential(authorization),
    );
  }
  @Post(':proposalId/reconcile')
  @Header('Cache-Control', 'no-store')
  reconcile(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Query('prospectId', ParseUUIDPipe) prospectId: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.generation.advance(
      ctx.tenantId,
      draftId,
      prospectId,
      ctx.clerkUserId,
      proposalId,
      credential(authorization),
      'reconcile',
    );
  }
  @Post(':proposalId/retry')
  @Header('Cache-Control', 'no-store')
  retry(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Query('prospectId', ParseUUIDPipe) prospectId: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.generation.advance(
      ctx.tenantId,
      draftId,
      prospectId,
      ctx.clerkUserId,
      proposalId,
      credential(authorization),
      'retry',
    );
  }
  @Post(':proposalId/decision')
  @Header('Cache-Control', 'no-store')
  decide(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Query('prospectId', ParseUUIDPipe) prospectId: string,
    @Body() body: unknown,
  ) {
    return this.generation.decide(
      ctx.tenantId,
      draftId,
      prospectId,
      ctx.clerkUserId,
      proposalId,
      body,
    );
  }
}
