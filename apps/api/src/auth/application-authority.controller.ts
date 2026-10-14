import { Body, Controller, ForbiddenException, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { ContextSecurityScopeService } from '../context/context-security-scope.service.js';
import { assertCurrentClientVisible, loadOwnedActiveClioConversation } from '../context/application-authority-resource.helpers.js';
import { BizDevMeriScopeService } from '../business-development/bizdev-meri-scope.service.js';
import { authorizeMeriProspectScope } from '../meri/meri-prospect-scope.helpers.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';
import {
  assertApplicationAuthorityIdentityBody,
  parseApplicationAuthorityContextBody,
  applicationAuthorityIdentityReceipt,
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
