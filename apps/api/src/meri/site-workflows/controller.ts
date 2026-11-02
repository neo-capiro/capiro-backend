import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard, hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { listAdminWorkflows, readWorkflowRequest, saveWorkflow } from './admin.js';
import { listRuntimeWorkflows, readRuntimeWorkflow, listWorkflowCatalog } from './runtime.js';

@Controller('clio/site-workflows/catalog')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class SiteWorkflowCatalogController {
  constructor(private readonly prisma: PrismaService, private readonly tenant: TenantContextMiddleware) {}
  @Post() @HttpCode(200)
  async list(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return listWorkflowCatalog(this.prisma, ctx, body, await this.tenant.readApplicationAuthoritySession(req, ctx));
  }
}

@Controller('clio/site-workflows')
@UseGuards(RolesGuard)
@Roles('capiro_admin')
export class SiteWorkflowAdminController {
  constructor(private readonly prisma: PrismaService, private readonly tenant: TenantContextMiddleware) {}
  @Get() async list(@CurrentTenant() ctx: TenantContext, @Req() req: Request) {
    return listAdminWorkflows(this.prisma, ctx, await this.tenant.readApplicationAuthoritySession(req, ctx));
  }
  @Post() @HttpCode(200)
  async save(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return saveWorkflow(this.prisma, ctx, body, await this.tenant.readApplicationAuthoritySession(req, ctx));
  }
  @Post('requests/read') @HttpCode(200)
  async read(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return readWorkflowRequest(this.prisma, ctx, body, await this.tenant.readApplicationAuthoritySession(req, ctx));
  }
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

