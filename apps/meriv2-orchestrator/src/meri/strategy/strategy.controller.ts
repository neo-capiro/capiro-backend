import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { runWithAssuranceRequestScope, type AssuranceSurface } from '@capiro/meriv2-core';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { MeriContextResolver } from '../meri-context.resolver.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { parseAiProviderHeader } from '../meri.controller.js';
import { StrategyAssistantService } from './strategy-assistant.service.js';
import type {
  StrategyAssistantInput,
  StrategyDocumentDraftInput,
  StrategyDraftInput,
  StrategyReferenceAssistInput,
} from './strategy-prompt.js';

/**
 * `/meri-api/strategy-{draft,assistant,reference-assist}` — Strategy Planner
 * Meri surfaces (G5), called by api-strategy. Tenant-guarded (verified Clerk
 * JWT); the whole loop runs inside the forwarded-credential scope so the
 * pre-compiled pack's delegated tool reads (bearer) and the LLM (tenant key,
 * BYOK2) both resolve. MeriContext is resolved with the strategy's clientId so
 * client-steering memory layers load.
 */
@Controller()
@UseGuards(TenantGuard)
export class StrategyController {
  constructor(
    private readonly resolver: MeriContextResolver,
    private readonly assistant: StrategyAssistantService,
  ) {}

  @Post('strategy-draft')
  async draft(
    @Body() dto: StrategyDraftInput,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    const ctx = await this.resolver.resolve(tc, dto.clientId, 'strategy');
    return this.scoped(req, () => this.assistant.draft(ctx, dto));
  }

  @Post('strategy-assistant')
  async assistantEdit(
    @Body() dto: StrategyAssistantInput,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    const ctx = await this.resolver.resolve(tc, dto.clientId, 'strategy');
    return this.scoped(req, () => this.assistant.assistant(ctx, dto));
  }

  /**
   * Stage-G grounded content generation: draft the full body of one
   * Execution Agent artifact (workspace document or outreach message) for a
   * single plan node. Called server-to-server by api-strategy's
   * ExecutionService — same TenantGuard + credential-forwarding shape as
   * the other strategy routes.
   */
  @Post('strategy-document-draft')
  async documentDraft(
    @Body() dto: StrategyDocumentDraftInput,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    const surface = documentAssuranceSurface(dto.kind);
    return runWithAssuranceRequestScope(tc.tenantId, surface, async () => {
      // Context Packet policy and assurance release policy must agree on the
      // actual destination. An outreach artifact must not compile under the
      // less-restrictive strategy surface merely because both share an endpoint.
      const ctx = await this.resolver.resolve(tc, dto.clientId, surface);
      return this.scoped(req, () => this.assistant.draftDocument(ctx, dto));
    });
  }

  @Post('strategy-reference-assist')
  async referenceAssist(
    @Body() dto: StrategyReferenceAssistInput,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    const ctx = await this.resolver.resolve(tc, null, 'strategy');
    return this.scoped(req, () => this.assistant.referenceAssist(ctx, dto));
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

function documentAssuranceSurface(
  kind: StrategyDocumentDraftInput['kind'],
): Extract<AssuranceSurface, 'strategy' | 'outreach'> {
  if (kind === 'workspace_draft') return 'strategy';
  if (kind === 'outreach_record') return 'outreach';
  throw new BadRequestException('Unsupported strategy document artifact kind');
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}
