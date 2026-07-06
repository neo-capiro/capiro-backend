import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { MeriContextResolver } from '../meri-context.resolver.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { parseAiProviderHeader } from '../meri.controller.js';
import { ChatAssistantService } from './chat-assistant.service.js';
import type { ChatInput, ChatResult } from './chat-prompt.js';

/**
 * `/meri-api/chat` — the MeriV2-served full Meri chat surface (Workstream C4).
 * The agentic loop over the entire tool registry (reads + gated writes) on the
 * tenant's key. Tenant-guarded (verified Clerk JWT); the loop runs inside the
 * forwarded-credential scope so delegated tool calls (Bearer), the approval
 * check (Bearer), and the LLM (tenant credential, BYOK2) all resolve.
 *
 * DORMANT: no apps/api caller proxies here yet (the full-chat proxy in apps/api
 * is a follow-up, gated behind a per-tenant flag the same way in-editor is), so
 * this endpoint exists but takes no production traffic until that flag ships.
 */
@Controller('chat')
@UseGuards(TenantGuard)
export class ChatController {
  constructor(
    private readonly resolver: MeriContextResolver,
    private readonly chat: ChatAssistantService,
  ) {}

  @Post()
  async run(
    @Body() dto: ChatInput,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ): Promise<ChatResult> {
    const meriCtx = await this.resolver.resolve(tc);
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    const exec = () => this.chat.run(meriCtx, dto ?? {});
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
