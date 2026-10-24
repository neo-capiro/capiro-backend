import { ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { ContextSecurityScopeService } from '../context/context-security-scope.service.js';
import { assertCurrentClientVisible, loadOwnedActiveClioConversation } from '../context/application-authority-resource.helpers.js';
import { BizDevMeriScopeService } from '../business-development/bizdev-meri-scope.service.js';
import { authorizeMeriProspectScope } from '../business-development/bizdev-meri-scope.authorization.js';
import { ApplicationMembershipService } from './application-membership.service.js';
import { ApplicationAuthorityChangedException, parseApplicationAuthorityCurrentBody, readApplicationAuthorityCurrent } from './application-authority.js';

/** The existing combined current owner, shared by HTTP and native approvals. */
@Injectable()
export class ApplicationCurrentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextMiddleware,
    private readonly securityScope: ContextSecurityScopeService,
    private readonly bizdevScope: BizDevMeriScopeService,
    private readonly membership: ApplicationMembershipService,
  ) {}

  async read(ctx: TenantContext, req: Request, body: unknown) {
    const input = parseApplicationAuthorityCurrentBody(body);
    // The only potential network await happens before acquiring a DB connection.
    const session = await this.tenant.readApplicationAuthoritySession(req, ctx);
    try {
      // Identity retains the original membership during impersonation. Every
      // resource owner below pins tenant/actor predicates explicitly on this tx.
      return await this.prisma.withSystem((tx) => readApplicationAuthorityCurrent(input, {
        identity: () => session.readCurrent(tx),
        membership: () => this.membership.readInTransaction(ctx, tx),
        conversation: (id) => loadOwnedActiveClioConversation(this.prisma, ctx, id, tx),
        conversationScope: async (conversation) => {
          const prospect = await authorizeMeriProspectScope(this.bizdevScope, ctx, (conversation as { metadata?: unknown }).metadata, tx);
          if (input.clientId === null) {
            const metadata = (conversation as { metadata?: { researchPortfolioScope?: unknown } }).metadata;
            if (prospect || metadata?.researchPortfolioScope !== undefined)
              throw new ForbiddenException('Application authority unavailable');
            const general = await tx.clioConversationBootstrapReceipt.findFirst({
              where: { tenantId: ctx.tenantId, actorUserId: ctx.userId, conversationId: conversation.id,
                scopeKind: 'general', clientId: null },
              select: { requestId: true },
            });
            if (!general) throw new ForbiddenException('Application authority unavailable');
            return ['general', general.requestId];
          }
          if (prospect && prospect.linkedClientId !== input.clientId) throw new ForbiddenException('Application authority unavailable');
          return prospect ? [prospect.prospectId, prospect.canonicalOrganizationId, prospect.linkedClientId, prospect.scopeVersion] : null;
        },
        clientVisible: (id) => assertCurrentClientVisible(this.prisma, ctx, id, tx),
        clientAuthority: (id) => this.securityScope.resolveApplicationAuthorityClient(ctx.tenantId, ctx.userId, id, tx),
      }), { isolationLevel: 'RepeatableRead', readOnly: true });
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof ApplicationAuthorityChangedException) throw error;
      if (!(error instanceof HttpException)) throw new ServiceUnavailableException('Application authority unavailable');
      throw new ForbiddenException('Application authority unavailable');
    }
  }
}
