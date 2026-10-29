import { Body, Controller, ForbiddenException, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard, hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { discardDraft, lockDraft, openDraft, readDraft, saveDraft } from './store.js';
import { beginDraftPublish, settleDraftPublish } from './publication.js';

/** Control-only receiver. Source/retention and immutable publish remain at the
 * runtime artifact owner; a browser cannot supply its own source or settlement. */
@Controller('clio/office-drafts')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class OfficeDraftController {
  constructor(private readonly prisma: PrismaService, private readonly tenant: TenantContextMiddleware) {}
  private async ports(ctx: TenantContext, req: Request) {
    if (!hasVerifiedToolServiceIdentity(req)) throw new ForbiddenException('Verified service identity required');
    return { prisma: this.prisma, ctx, authority: await this.tenant.readApplicationAuthoritySession(req, ctx) };
  }
  @Post('open') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async open(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return openDraft(await this.ports(ctx, req), body);
  }
  @Post('read') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async read(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return readDraft(await this.ports(ctx, req), body);
  }
  @Post('lock') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async lock(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return lockDraft(await this.ports(ctx, req), body);
  }
  @Post('save') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async save(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return saveDraft(await this.ports(ctx, req), body);
  }
  @Post('discard') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async discard(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return discardDraft(await this.ports(ctx, req), body);
  }
  @Post('publish/begin') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async beginPublish(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return beginDraftPublish(await this.ports(ctx, req), body);
  }
  @Post('publish/settle') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async settlePublish(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return settleDraftPublish(await this.ports(ctx, req), body);
  }
}
