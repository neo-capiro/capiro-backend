import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { MeriContextResolver } from '../meri-context.resolver.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { parseAiProviderHeader } from '../meri.controller.js';
import { InEditorAssistantService } from './in-editor-assistant.service.js';
import type { AssistantResult, InEditorInput } from './in-editor-prompt.js';

/**
 * `/meri-api/in-editor-assistant` — the MeriV2-served in-editor document
 * assistant surface (A3). apps/api's workspace-assistant proxy (flag-gated,
 * OFF by default) forwards the document + conversation + the caller's Bearer
 * here when meriv2.inEditorAssistant is ON for the tenant. Tenant-guarded
 * (verified Clerk JWT); the whole loop runs inside the forwarded-credential
 * scope so delegated tool calls (Bearer) and the LLM (tenant credential, BYOK2)
 * both resolve.
 */
@Controller('in-editor-assistant')
@UseGuards(TenantGuard)
export class InEditorController {
  constructor(
    private readonly resolver: MeriContextResolver,
    private readonly assistant: InEditorAssistantService,
  ) {}

  @Post()
  async run(
    @Body() dto: InEditorInput,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ): Promise<AssistantResult> {
    const meriCtx = await this.resolver.resolve(tc);
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    const exec = () => this.assistant.run(meriCtx, dto ?? {});
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
