import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { verifyMeriGovernedContext, type MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { MeriContextResolver } from '../meri-context.resolver.js';
import {
  runWithGovernedMeriContext,
  withGovernedPrompt,
} from '../meri-governed-context.runtime.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { parseAiProviderHeader } from '../meri.controller.js';
import { ChatAssistantService } from './chat-assistant.service.js';
import type { ChatInput, ChatResult } from './chat-prompt.js';
import {
  validateServerReadonlyCapturePolicy,
  withTrustedCurrentTurnScope,
} from '../../request/trusted-current-turn-scope.js';

type GovernedChatInput = ChatInput & { governedContext?: MeriGovernedTurnContext };

@Controller('chat')
@UseGuards(TenantGuard)
export class ChatController {
  constructor(
    private readonly resolver: MeriContextResolver,
    private readonly chat: ChatAssistantService,
  ) {}

  @Post()
  async run(
    @Body() dto: GovernedChatInput,
    @CurrentTenant() tenant: OrchestratorTenantContext,
    @Req() req: Request,
  ): Promise<ChatResult & { contextPacket: unknown; retrieval: unknown }> {
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    const impersonateTenantId = extractImpersonateTenant(req);
    const execute = async () => {
      const governed = requireGovernedContext(dto);
      const meriCtx = await this.resolver.resolveIdentity(tenant);
      authenticateGovernedContext(governed, dto, meriCtx);
      meriCtx.contextPacket = governed.contextPacket;
      const effectiveDto = {
        ...dto,
        skillAddendum: withGovernedPrompt(dto.skillAddendum, governed),
      };
      const run = async () => this.chat.run(meriCtx, effectiveDto);
      const result = await withTrustedCurrentTurnScope(
        trustedCurrentTurnScope(meriCtx, dto, governed),
        () => runWithGovernedMeriContext(governed, run),
      );
      return {
        ...result,
        contextPacket: governed.contextPacket,
        retrieval: governed.retrieval,
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
    @Body() dto: GovernedChatInput,
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
      const governed = requireGovernedContext(dto);
      const meriCtx = await this.resolver.resolveIdentity(tenant);
      authenticateGovernedContext(governed, dto, meriCtx);
      meriCtx.contextPacket = governed.contextPacket;
      const effectiveDto = {
        ...dto,
        skillAddendum: withGovernedPrompt(dto.skillAddendum, governed),
      };
      frame({ type: 'start' });
      try {
        const run = async () =>
          this.chat.run(meriCtx, effectiveDto, {
            onEvent: frame,
            signal: abort.signal,
          });
        const result = await withTrustedCurrentTurnScope(
          trustedCurrentTurnScope(meriCtx, dto, governed),
          () => runWithGovernedMeriContext(governed, run),
        );
        frame({
          type: 'done',
          reply: result.reply,
          steps: result.steps ?? [],
          ...(result.intent ? { intent: result.intent } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.citations?.length ? { citations: result.citations } : {}),
          ...(result.pendingApprovals?.length ? { pendingApprovals: result.pendingApprovals } : {}),
          contextPacket: governed.contextPacket,
          retrieval: governed.retrieval,
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

function requireGovernedContext(dto: GovernedChatInput): MeriGovernedTurnContext {
  if (!dto?.governedContext) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Governed Context Plane input required',
      code: 'meri_governed_context_required',
    });
  }
  return dto.governedContext;
}

function authenticateGovernedContext(
  governed: MeriGovernedTurnContext,
  dto: ChatInput,
  identity: { tenantId: string; userId: string },
): void {
  try {
    verifyMeriGovernedContext(governed, dto, identity, process.env.INTERNAL_SERVICE_SECRET);
    if (governed.governedArtifactCapturePolicy)
      throw new Error('meri_case46_qualified_v3_required');
    if (governed.serverReadonlyCapturePolicy) {
      validateServerReadonlyCapturePolicy(governed.serverReadonlyCapturePolicy, {
        tenantId: identity.tenantId,
        actorUserId: identity.userId,
        conversationId: dto.conversationId ?? null,
        clientId: dto.clientId ?? null,
      });
    }
  } catch {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Authenticated Context Plane input required',
      code: 'meri_governed_context_authentication_failed',
    });
  }
}

function trustedCurrentTurnScope(
  identity: { tenantId: string; userId: string },
  dto: ChatInput,
  governed: MeriGovernedTurnContext,
) {
  return {
    tenantId: identity.tenantId,
    userId: identity.userId,
    conversationId: dto.conversationId ?? null,
    selectedClientId: dto.clientId ?? null,
    ...(governed.serverReadonlyCapturePolicy
      ? { capturePolicy: governed.serverReadonlyCapturePolicy }
      : {}),
  };
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
