import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard, hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { listAdminWorkflows, readWorkflowRequest, saveWorkflow } from './admin.js';
import { listRuntimeWorkflows, readRuntimeWorkflow } from './runtime.js';

@Controller('clio/site-workflows')
@UseGuards(RolesGuard)
@Roles('capiro_admin')
export class SiteWorkflowAdminController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list(@CurrentTenant() ctx: TenantContext) { return listAdminWorkflows(this.prisma, ctx); }
  @Post() @HttpCode(200)
  save(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) { return saveWorkflow(this.prisma, ctx, body); }
  @Post('requests/read') @HttpCode(200)
  read(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) { return readWorkflowRequest(this.prisma, ctx, body); }
}
@Controller('clio/site-workflows/runtime')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class SiteWorkflowRuntimeController {
  constructor(private readonly prisma: PrismaService) {}
  private requireService(req: Request) {
    if (!hasVerifiedToolServiceIdentity(req)) throw new ForbiddenException('Verified service identity required');
  }
  @Post('list') @HttpCode(200)
  list(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    this.requireService(req); return listRuntimeWorkflows(this.prisma, ctx, body);
  }
  @Post('read') @HttpCode(200)
  read(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    this.requireService(req); return readRuntimeWorkflow(this.prisma, ctx, body);
  }
}

