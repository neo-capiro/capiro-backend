import {
  Body, ConflictException, Controller, ForbiddenException, Header, HttpCode, Post, Req,
  RequestTimeoutException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { ContextSecurityScopeService } from '../context/context-security-scope.service.js';
import { assertCurrentClientVisible, loadOwnedActiveClioConversation } from '../context/application-authority-resource.helpers.js';
import { BizDevMeriScopeService } from '../business-development/bizdev-meri-scope.service.js';
import { authorizeMeriProspectScope } from '../business-development/bizdev-meri-scope.authorization.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';
import {
  assertApplicationAuthorityIdentityBody,
  parseApplicationAuthorityContextBody,
  applicationAuthorityIdentityReceipt,
  parseApplicationAuthorityMembershipDeadline,
  readApplicationAuthorityMembership,
  readApplicationAuthorityContext,
} from './application-authority.js';

/** Native authority adapter for rebuilt Meri; no model/runtime/store owner. */
@Controller('clio/application-authority')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ApplicationAuthorityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextMiddleware,
    private readonly securityScope: ContextSecurityScopeService,
    private readonly bizdevScope: BizDevMeriScopeService,
  ) {}

  @Post('identity')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async applicationAuthorityIdentity(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertApplicationAuthorityIdentityBody(body);
    if (!this.tenant) throw new ForbiddenException('Application authority unavailable');
    return applicationAuthorityIdentityReceipt(await this.tenant.readApplicationAuthority(req, ctx));
  }

  @Post('membership')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async applicationAuthorityMembership(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertApplicationAuthorityIdentityBody(body);
    const deadlineMs = parseApplicationAuthorityMembershipDeadline(req.header('x-meri-deadline-at'));
    const tenant = this.tenant;
    if (!tenant || !this.prisma) throw new ForbiddenException('Application authority unavailable');
    try {
      return await readApplicationAuthorityMembership({
        identity: () => tenant.readApplicationAuthority(req, ctx),
        membership: async (principal) => {
          if (principal.tenantId !== ctx.tenantId || principal.actorId !== ctx.userId) {
            throw new ForbiddenException('Application authority unavailable');
          }
          return this.prisma.withTenant(ctx.tenantId, async (tx) => {
            const membership = await tx.tenantMembership.findFirst({
              where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
              select: { id: true, tenantId: true, userId: true, status: true, role: true, updatedAt: true },
            });
            if (!membership || membership.role !== ctx.role) {
              throw new ForbiddenException('Application authority unavailable');
            }
            const clients = await tx.client.findMany({
              where: {
                tenantId: ctx.tenantId,
                status: { not: 'archived' },
                OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { tenantId: ctx.tenantId, userId: ctx.userId } } }],
              },
              select: { id: true },
              orderBy: { id: 'asc' },
              take: 4097,
            });
            if (clients.length > 4096) throw new ForbiddenException('Application authority unavailable');
            return {
              membershipId: membership.id,
              tenantId: membership.tenantId,
              actorId: membership.userId,
              status: membership.status,
              role: membership.role,
              updatedAtMs: membership.updatedAt.getTime(),
              clientIds: clients.map((client) => client.id),
            };
          });
        },
      }, deadlineMs);
    } catch (error) {
      if (error instanceof RequestTimeoutException || error instanceof ConflictException ||
          error instanceof UnauthorizedException) throw error;
      throw new ForbiddenException('Application authority unavailable');
    }
  }

  @Post('context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async applicationAuthorityContext(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    const input = parseApplicationAuthorityContextBody(body);
    const tenant = this.tenant;
    const securityScope = this.securityScope;
    if (!tenant || !securityScope) throw new ForbiddenException('Application authority unavailable');
    try {
      return await readApplicationAuthorityContext(input, {
        identity: () => tenant.readApplicationAuthority(req, ctx),
        conversation: (id) => loadOwnedActiveClioConversation(this.prisma, ctx, id),
        conversationScope: async (conversation) => {
          const prospect = await authorizeMeriProspectScope(this.bizdevScope, ctx, (conversation as { metadata?: unknown }).metadata);
          if (prospect && prospect.linkedClientId !== input.clientId) throw new ForbiddenException('Application authority unavailable');
          return prospect ? [prospect.prospectId, prospect.canonicalOrganizationId, prospect.linkedClientId, prospect.scopeVersion] : null;
        },
        clientVisible: (id) => assertCurrentClientVisible(this.prisma, ctx, id),
        clientAuthority: (id) => securityScope.resolveApplicationAuthorityClient(ctx.tenantId, ctx.userId, id),
      });
    } catch {
      throw new ForbiddenException('Application authority unavailable');
    }
  }
}
