import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { MeriContextResolver } from '../meri-context.resolver.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { parseAiProviderHeader } from '../meri.controller.js';
import { StewardExtractService } from './steward-extract.service.js';
import type { StewardExtractInput, StewardExtractResult } from './steward-prompt.js';

/**
 * `/meri-api/steward-extract` — the Context Steward extraction surface
 * (Stage E), called by api-strategy on context-document upload. Clones
 * StrategyController's guard/scoping exactly: tenant-guarded (verified Clerk
 * JWT), MeriContext resolved with the document's clientId, and the extraction
 * runs inside the forwarded-credential scope so the LLM resolves the tenant
 * key (BYOK2). Read-only against strategy state — the Steward only ever
 * RETURNS facts/conflicts; api-strategy persists them into sp_context_*.
 */
@Controller()
@UseGuards(TenantGuard)
export class StewardController {
  constructor(
    private readonly resolver: MeriContextResolver,
    private readonly steward: StewardExtractService,
  ) {}

  @Post('steward-extract')
  async extract(
    @Body() dto: StewardExtractInput,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ): Promise<StewardExtractResult> {
    const ctx = await this.resolver.resolve(tc, dto.clientId, 'steward');
    return this.scoped(req, () => this.steward.extract(ctx, dto));
  }

  private scoped<T>(req: Request, exec: () => Promise<T>): Promise<T> {
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    return token || aiProvider
      ? RequestCredentialsStore.run(
          { bearerToken: token ?? '', ...(aiProvider ? { aiProvider } : {}) },
          exec,
        )
      : exec();
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}
