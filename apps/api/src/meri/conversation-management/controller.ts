import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard, hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MANAGEMENT_VERSION } from './contract.js';
import { listManagedConversations } from './list.js';
import { listConversationDeletions, readConversationDeletion } from './deletion-read.js';
import { manageConversation, readManagedConversationMetadata, readManagementRequest } from './service.js';

/** Only Meri's authenticated backend calls the fixed metadata boundary. User
 * identity still comes from ordinary Core authentication, never request JSON. */
@Controller('clio/conversations/management')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class ConversationManagementController {
  constructor(private readonly prisma: PrismaService) {}
  private service(req: Request) {
    // Development observe mode is not a management authority.
    if (!hasVerifiedToolServiceIdentity(req)) throw new ForbiddenException('Verified service identity required');
  }
  @Post('summaries') @HttpCode(200)
  summaries(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    this.service(req);
    return listManagedConversations(this.prisma, ctx, body);
  }
  @Post('deletions/list') @HttpCode(200)
  deletions(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    this.service(req);
    return listConversationDeletions(this.prisma, ctx, body);
  }
  @Post('deletions/read') @HttpCode(200)
  deletion(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    this.service(req);
    return readConversationDeletion(this.prisma, ctx, body);
  }
  @Post('metadata') @HttpCode(200)
  metadata(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    this.service(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid chat metadata request');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).sort().join() !== 'conversationId,version' || input.version !== MANAGEMENT_VERSION ||
        typeof input.conversationId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.conversationId))
      throw new BadRequestException('Invalid chat metadata request');
    return readManagedConversationMetadata(this.prisma, { tenantId: ctx.tenantId, actorId: ctx.userId }, input.conversationId);
  }
  @Post('read') @HttpCode(200)
  read(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    this.service(req);
    return readManagementRequest(this.prisma, ctx, body);
  }
  @Post('apply') @HttpCode(200)
  apply(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    this.service(req);
    return manageConversation(this.prisma, ctx, body);
  }
}
