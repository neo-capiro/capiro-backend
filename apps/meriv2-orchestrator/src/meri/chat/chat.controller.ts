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
    @CurrentTenant() tenant: OrchestratorTenantContext,
    @Req() req: Request,
  ): Promise<ChatResult & { contextPacket?: unknown }> {
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    const impersonateTenantId = extractImpersonateTenant(req);
    const execute = async () => {
      const meriCtx = await this.resolver.resolve(tenant, dto?.clientId ?? null, 'ga-chat', {
        conversationId: dto?.conversationId ?? null,
      });
      return {
        ...(await this.chat.run(meriCtx, dto ?? {})),
        ...(meriCtx.contextPacket ? { contextPacket: meriCtx.contextPacket } : {}),
      };
    };
    return token || aiProvider || impersonateTenantId
      ? RequestCredentialsStore.run(
          {
            bearerToken: token ?? '',
            ...(aiProvider ? { aiProvider } : {}),
            ...(impersonateTenantId ? { impersonateTenantId } : {}),
          },
          execute,
        )
      : execute();
  }

  @Post('stream')
  async stream(
    @Body() dto: ChatInput,
    @CurrentTenant() tenant: OrchestratorTenantContext,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    const impersonateTenantId = extractImpersonateTenant(req);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    res.on('error', () => {
      /* socket errors on disconnect are expected */
    });
    const frame = (event: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const execute = async () => {
      const meriCtx = await this.resolver.resolve(tenant, dto?.clientId ?? null, 'ga-chat', {
        conversationId: dto?.conversationId ?? null,
      });
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
          ...(meriCtx.contextPacket ? { contextPacket: meriCtx.contextPacket } : {}),
          aborted: abort.signal.aborted,
        });
      } catch (error) {
        frame({ type: 'error', message: error instanceof Error ? error.message : 'Chat failed' });
      }
      res.end();
    };

    await (token || aiProvider || impersonateTenantId
      ? RequestCredentialsStore.run(
          {
            bearerToken: token ?? '',
            ...(aiProvider ? { aiProvider } : {}),
            ...(impersonateTenantId ? { impersonateTenantId } : {}),
          },
          execute,
        )
      : execute());
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function extractImpersonateTenant(req: Request): string | null {
  const raw = req.headers['x-capiro-impersonate-tenant'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
