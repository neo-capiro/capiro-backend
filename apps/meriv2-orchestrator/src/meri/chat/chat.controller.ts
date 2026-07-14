import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
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
 * Two transports over the SAME loop:
 *   - POST /meri-api/chat        → one complete ChatResult (request/response)
 *   - POST /meri-api/chat/stream → SSE-style `data: <json>\n\n` frames of
 *     ChatStreamEvent, terminated by `done` (carrying the aggregates the
 *     apps/api proxy persists) or `error`. The apps/api full-chat proxy
 *     (meriv2.fullChat flag) consumes the stream and translates to the legacy
 *     ChatDrawer event union.
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
    const meriCtx = await this.resolver.resolve(tc, dto?.clientId ?? null);
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

  @Post('stream')
  async stream(
    @Body() dto: ChatInput,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const meriCtx = await this.resolver.resolve(tc, dto?.clientId ?? null);
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Cancel the loop when the caller disconnects — stop burning tokens for an
    // answer nobody is reading (same P0-4 discipline as the legacy stream).
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    res.on('error', () => {
      /* swallow socket errors on client disconnect */
    });
    const frame = (event: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const exec = async () => {
      frame({ type: 'start' });
      try {
        const result = await this.chat.run(meriCtx, dto ?? {}, {
          onEvent: frame,
          signal: abort.signal,
        });
        frame({
          type: 'done',
          reply: result.reply,
          steps: result.steps ?? [],
          ...(result.intent ? { intent: result.intent } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.citations?.length ? { citations: result.citations } : {}),
          ...(result.pendingApprovals?.length ? { pendingApprovals: result.pendingApprovals } : {}),
          aborted: abort.signal.aborted,
        });
      } catch (e) {
        frame({ type: 'error', message: (e as Error).message });
      }
      res.end();
    };

    await (token || aiProvider
      ? RequestCredentialsStore.run(
          { bearerToken: token ?? '', ...(aiProvider ? { aiProvider } : {}) },
          exec,
        )
      : exec());
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}
