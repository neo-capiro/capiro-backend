import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DraftsService } from '../drafts/drafts.service.js';
import { copyBriefToClient, readClientBriefCopy } from './client-brief-copy.js';

@Controller('prospects/:prospectId/clients/:clientId/brief-copies')
@UseGuards(TenantGuard)
export class ClientBriefCopyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: DraftsService,
  ) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  copy(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('prospectId') prospectId: string,
    @Param('clientId') clientId: string,
    @Body() body: unknown,
  ) {
    return copyBriefToClient(
      this.prisma,
      this.drafts,
      ctx.tenantId,
      ctx.clerkUserId,
      prospectId,
      clientId,
      body,
    );
  }
  @Get(':requestId')
  @Header('Cache-Control', 'private, no-store')
  receipt(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('prospectId') prospectId: string,
    @Param('clientId') clientId: string,
    @Param('requestId') requestId: string,
  ) {
    return readClientBriefCopy(
      this.prisma,
      ctx.tenantId,
      ctx.clerkUserId,
      prospectId,
      clientId,
      requestId,
    );
  }
}
