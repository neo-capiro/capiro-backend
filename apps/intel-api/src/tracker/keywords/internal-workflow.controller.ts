import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { InternalWorkflowService } from './internal-workflow.service.js';
import { WorkflowTriggerService } from './workflow-trigger.service.js';
@Injectable()
export class WorkflowSourceGuard implements CanActivate {
  canActivate(c: ExecutionContext) {
    const value = c.switchToHttp().getRequest().headers['x-internal-service-secret'],
      expected = process.env.INTERNAL_SERVICE_SECRET;
    if (typeof value !== 'string' || !expected) throw new UnauthorizedException();
    const a = Buffer.from(value),
      b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    return true;
  }
}
@Controller('legiwatch/workflows')
@UseGuards(TenantGuard)
export class InternalWorkflowController {
  constructor(
    readonly workflows: InternalWorkflowService,
    readonly triggers: WorkflowTriggerService,
  ) {}
  @Get('templates/:folderId') list(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('folderId') id: string,
  ) {
    return this.triggers.list(ctx, id);
  }
  @Post('templates') save(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.triggers.save(ctx, body);
  }
  @Post('templates/:id') update(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.triggers.save(ctx, body, id);
  }
  @Post('templates/:id/activation') activation(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.triggers.activation(ctx, id, body);
  }
  @Post('preview') preview(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.workflows.preview(ctx, body);
  }
  @Post('actions') create(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.workflows.enqueue(ctx, body);
  }
  @Get('history/:folderId') history(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('folderId') id: string,
  ) {
    return this.workflows.history(ctx, id);
  }
  @Get('actions/:id') get(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.workflows.get(ctx, id);
  }
  @Post('actions/:id/retry') execute(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.workflows.execute(ctx, id);
  }
  @Post('actions/:id/pause') pause(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.workflows.pause(ctx, id);
  }
}
@Controller('internal/legiwatch/workflow-actions')
@UseGuards(WorkflowSourceGuard)
export class WorkflowSourceController {
  constructor(readonly workflows: InternalWorkflowService) {}
  @Get(':id') source(
    @Param('id') id: string,
    @Query('tenantId') tenantId: string,
    @Query('ownerId') ownerId: string,
  ) {
    return this.workflows.authorizedPreparation({ tenantId, clerkUserId: ownerId, role: null }, id);
  }
}
