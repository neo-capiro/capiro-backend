import { BadRequestException, Body, Controller, ForbiddenException, Header, HttpCode, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
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
import { hasVerifiedToolServiceIdentity, ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { ApplicationAuthorityUnavailableException } from './application-authority-unavailable.js';
import { ApplicationCurrentService } from './application-current.service.js';
import {
  ARTIFACT_AUTHORITY_V2_CONTRACT,
  applicationAuthorityArtifactReceipt,
  assertApplicationAuthorityIdentityBody,
  parseApplicationAuthorityArtifactBody,
  parseApplicationAuthorityContextBody,
  applicationAuthorityIdentityReceipt,
  readApplicationAuthorityArtifact,
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
    private readonly current: ApplicationCurrentService,
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

  @Post('current')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async applicationAuthorityCurrent(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    // The parser bounds the semantic JSON body. Also reject a declared wire
    // length above that limit; upstream parsing owns chunked/raw byte limits.
    const contentLength = req.headers['content-length'];
    if (typeof contentLength === 'string' && /^\d+$/.test(contentLength) && Number(contentLength) > 4096) {
      throw new BadRequestException('Invalid application authority request');
    }
    return this.current.read(ctx, req, body);
  }

  @Post('context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async applicationAuthorityContext(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    const input = parseApplicationAuthorityContextBody(body);
    try {
      return await readApplicationAuthorityContext(input, this.contextPorts(ctx, req, input.clientId));
    } catch (error) {
      // Clerk not answering is not a refusal: keep its retryable 503.
      if (error instanceof ApplicationAuthorityUnavailableException) throw error;
      throw new ForbiddenException('Application authority unavailable');
    }
  }

  /**
   * Meri artifact current authority (`capiro.meri-artifact-authority.v1`,
   * D31): the native session bearer, a VERIFIED service identity (the guard
   * alone can pass in dev/test observe mode, dot 6247459562) and
   * `standard_user`. The marked control credential never reaches here: the
   * tenant middleware admits it only on identity/context/membership/current and
   * answers 401 elsewhere. Every refusal past the body is 403.
   */
  @Post('artifact')
  @HttpCode(200)
  @UseGuards(ToolServiceSecretGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async applicationAuthorityArtifact(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    const input = parseApplicationAuthorityArtifactBody(body);
    if (!hasVerifiedToolServiceIdentity(req)) throw new ForbiddenException('Application authority unavailable');
    try {
      if (input.contract === ARTIFACT_AUTHORITY_V2_CONTRACT) {
        const current = await this.applicationAuthorityCurrent(ctx, req,
          { conversationId: input.conversationId, clientId: input.clientId });
        return applicationAuthorityArtifactReceipt(input, current.role, current);
      }
      if (input.clientId === null) throw new ForbiddenException('Application authority unavailable');
      return await readApplicationAuthorityArtifact(input, ctx.role, this.contextPorts(ctx, req, input.clientId));
    } catch (error) {
      // Identity or the current-state transaction being unavailable is retryable.
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ForbiddenException('Application authority unavailable');
    }
  }

  /** The existing `/context` owners, shared by `/artifact`. */
  private contextPorts(ctx: TenantContext, req: Request, clientId: string): Parameters<typeof readApplicationAuthorityContext>[1] {
    const tenant = this.tenant;
    const securityScope = this.securityScope;
    if (!tenant || !securityScope) throw new ForbiddenException('Application authority unavailable');
    return {
      identity: () => tenant.readApplicationAuthority(req, ctx),
      conversation: (id) => loadOwnedActiveClioConversation(this.prisma, ctx, id),
      conversationScope: async (conversation) => {
        const prospect = await authorizeMeriProspectScope(this.bizdevScope, ctx, (conversation as { metadata?: unknown }).metadata);
        if (prospect && prospect.linkedClientId !== clientId) throw new ForbiddenException('Application authority unavailable');
        return prospect ? [prospect.prospectId, prospect.canonicalOrganizationId, prospect.linkedClientId, prospect.scopeVersion] : null;
      },
      clientVisible: (id) => assertCurrentClientVisible(this.prisma, ctx, id),
      clientAuthority: (id) => securityScope.resolveApplicationAuthorityClient(ctx.tenantId, ctx.userId, id),
    };
  }
}
