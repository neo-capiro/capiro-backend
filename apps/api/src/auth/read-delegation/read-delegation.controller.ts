import {
  BadRequestException, Body, Controller, ForbiddenException, Header, HttpCode, Inject, Logger, Module, Optional, Param, Post, Req, Res, ServiceUnavailableException, UseGuards, type Provider,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TenantModule } from '../../tenant/tenant.module.js';
import { ContextSecurityScopeModule } from '../../context/context-security-scope.module.js';
import { BizDevMeriScopeModule } from '../../business-development/bizdev-meri-scope.module.js';
import { ApplicationAuthorityModule } from '../application-authority.module.js';
import { applicationMembershipRequest } from '../application-membership-request.js';
import { createCoreKmsSigner, readCoreEd25519KeyConfig } from '../core-ed25519-kms-config.js';
import { ToolServiceSecretGuard } from '../tool-service-secret.guard.js';
import { isUuid } from './read-delegation.contract.js';
import { meriReadDelegationOf } from './read-delegation-request.js';
import { MERI_READ_DELEGATION_SIGNER, ReadDelegationService } from './read-delegation.service.js';
import type { CoreEd25519Signer } from '../core-ed25519-signer.js';
import { issueMemoryHelperToken } from '../../meri/memory-receiving/meri-memory-helper-source.js';
import { MEMORY_HELPER_KIND } from '../../meri/memory-receiving/meri-memory-helper-token.js';
import { signedMemoryPageEnabled } from './signed-memory-http-gate.js';

const id = (value: string) => {
  if (!isUuid(value)) throw new BadRequestException('Invalid read delegation request: id');
  return value;
};
/** The tenant middleware's context, present only on the live-session (Bearer) and `CapiroMeriRead` paths. */
const contextOf = (req: Request) => (req as Request & { tenantContext?: TenantContext }).tenantContext;
function liveMember(req: Request): TenantContext {
  const ctx = contextOf(req);
  // A delegated read token never reaches create, consent or narrowing routes.
  if (!ctx || meriReadDelegationOf(req) || !Object.hasOwn(ROLE_RANK, ctx.role) ||
      ROLE_RANK[ctx.role as TenantRole] < ROLE_RANK.standard_user) throw new ForbiddenException('Read delegation refused');
  return ctx;
}

/**
 * Run-bound read delegation routes (RC1 option B, D016-A item 4). Every route
 * requires the verified service identity (the service re-checks it: an
 * observe-mode guard pass is not enough). The tenant middleware admits the
 * bearer-less service POSTs (unattended create, tokens, revocations, consent
 * narrowing) without a tenant context, the `current` target only with a
 * `CapiroMeriRead` token, and attended create, consent and resume only with a
 * live Clerk session (never the marked control token).
 */
@Controller('clio/application-authority')
@UseGuards(ToolServiceSecretGuard)
export class ReadDelegationController {
  constructor(
    private readonly delegations: ReadDelegationService,
    private readonly prisma: PrismaService,
    @Optional() @Inject(MERI_READ_DELEGATION_SIGNER) private readonly signer: CoreEd25519Signer | null = null,
  ) {}

  @Post('read-delegations')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: Request, @Body() body: unknown) {
    if (meriReadDelegationOf(req)) throw new ForbiddenException('Read delegation refused');
    return contextOf(req) ? this.delegations.createAttended(req, liveMember(req), body) : this.delegations.createUnattended(req, body);
  }

  @Post('read-delegations/:delegationId/tokens')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  tokens(@Req() req: Request, @Param('delegationId') delegationId: string, @Body() body: unknown) {
    if (meriReadDelegationOf(req)) throw new ForbiddenException('Read delegation refused');
    if (body && typeof body === 'object' && !Array.isArray(body) &&
        (body as Record<string, unknown>).kind === MEMORY_HELPER_KIND) {
      if (!signedMemoryPageEnabled()) throw new ServiceUnavailableException('Passive memory helper unavailable');
      if (!this.signer) throw new ServiceUnavailableException('Passive memory helper unavailable');
      return issueMemoryHelperToken(this.prisma, this.signer, req, id(delegationId), body, { enabled: true });
    }
    return this.delegations.issueToken(req, id(delegationId), body);
  }

  @Post('read-delegations/:delegationId/revocations')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  revoke(@Req() req: Request, @Param('delegationId') delegationId: string, @Body() body: unknown) {
    if (meriReadDelegationOf(req)) throw new ForbiddenException('Read delegation refused');
    return this.delegations.revoke(req, id(delegationId), body);
  }

  @Post('read-delegations/:delegationId/current')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async current(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('delegationId') delegationId: string,
    @Body() body: unknown) {
    const ctx = contextOf(req);
    if (!ctx || !meriReadDelegationOf(req)) throw new ForbiddenException('Read delegation refused');
    const control = applicationMembershipRequest(req, res);
    try { return await control.run(() => this.delegations.current(req, ctx, id(delegationId), body, control)); }
    finally { control.close(); }
  }

  @Post('read-delegation-consents')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  createConsent(@Req() req: Request, @Body() body: unknown) {
    return this.delegations.createConsent(req, liveMember(req), body);
  }

  @Post('read-delegation-consents/:consentId/state')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  setConsentState(@Req() req: Request, @Param('consentId') consentId: string, @Body() body: unknown) {
    if (meriReadDelegationOf(req)) throw new ForbiddenException('Read delegation refused');
    return this.delegations.setConsentState(req, contextOf(req) ? liveMember(req) : undefined, id(consentId), body);
  }
}

/** The read-token KMS signer from `MERI_READ_DELEGATION_SIGNER_*`; null (503) when absent or invalid. */
const readDelegationSignerProvider: Provider = {
  provide: MERI_READ_DELEGATION_SIGNER,
  useFactory: () => {
    try {
      const config = readCoreEd25519KeyConfig(process.env, 'MERI_READ_DELEGATION_SIGNER');
      return config ? createCoreKmsSigner(config) : null;
    } catch (error) {
      new Logger('ReadDelegation').error(`MERI_READ_DELEGATION_SIGNER disabled: ${(error as Error).message}`);
      return null;
    }
  },
};

/** A sibling of ApplicationAuthorityModule (the KMS signer stays outside the authority closure). */
@Module({
  imports: [PrismaModule, TenantModule, ApplicationAuthorityModule, ContextSecurityScopeModule, BizDevMeriScopeModule],
  controllers: [ReadDelegationController],
  providers: [ReadDelegationService, ToolServiceSecretGuard, readDelegationSignerProvider],
})
export class ReadDelegationModule {}
