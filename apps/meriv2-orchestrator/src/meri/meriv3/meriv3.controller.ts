import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { parseAiProviderHeader } from '../meri.controller.js';
import { MeriContextResolver } from '../meri-context.resolver.js';
import { MeriV3AccessService } from './meriv3-access.service.js';
import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import { listMeriV3ReasoningProfiles } from './meriv3-reasoning.js';
import type { MeriV3ChatInput } from './meriv3.types.js';

@Controller('v3/chat')
@UseGuards(TenantGuard)
export class MeriV3Controller {
  constructor(
    private readonly access: MeriV3AccessService,
    private readonly resolver: MeriContextResolver,
    private readonly assistant: MeriV3AssistantService,
  ) {}

  @Get('capabilities')
  async capabilities(@CurrentTenant() tenant: OrchestratorTenantContext) {
    await this.assertAllowed(tenant.tenantId);
    return {
      runtime: 'meriv3' as const,
      defaultMode: 'standard' as const,
      modes: listMeriV3ReasoningProfiles().map((profile) => ({
        mode: profile.mode,
        label: profile.label,
        description: profile.description,
        effort: profile.effort,
      })),
      rawReasoningVisible: false,
      storeProviderState: false,
    };
  }

  @Post()
  async run(
    @Body() dto: MeriV3ChatInput,
    @CurrentTenant() tenant: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    await this.assertAllowed(tenant.tenantId);
    const execute = async () => {
      const meriContext = await this.resolver.resolve(tenant, dto?.clientId ?? null, 'ga-chat', {
        conversationId: dto?.conversationId ?? null,
      });
      const result = await this.assistant.run(meriContext, dto ?? {});
      return {
        ...result,
        ...(meriContext.contextPacket ? { contextPacket: meriContext.contextPacket } : {}),
      };
    };
    return this.withRequestCredentials(req, execute);
  }

  @Post('stream')
  async stream(
    @Body() dto: MeriV3ChatInput,
    @CurrentTenant() tenant: OrchestratorTenantContext,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertAllowed(tenant.tenantId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    res.on('error', () => {
      /* client disconnects are expected */
    });
    const frame = (event: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const execute = async () => {
      const meriContext = await this.resolver.resolve(tenant, dto?.clientId ?? null, 'ga-chat', {
        conversationId: dto?.conversationId ?? null,
      });
      frame({
        type: 'start',
        runtime: 'meriv3',
        reasoningMode: dto?.reasoningMode ?? 'standard',
      });
      try {
        const result = await this.assistant.run(meriContext, dto ?? {}, {
          onEvent: frame,
          signal: abort.signal,
        });
        frame({
          type: 'done',
          reply: result.reply,
          runtime: result.runtime,
          model: result.model,
          reasoningMode: result.reasoningMode,
          reasoningEffort: result.reasoningEffort,
          steps: result.steps ?? [],
          ...(result.intent ? { intent: result.intent } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.citations?.length ? { citations: result.citations } : {}),
          ...(result.pendingApprovals?.length
            ? { pendingApprovals: result.pendingApprovals }
            : {}),
          ...(meriContext.contextPacket ? { contextPacket: meriContext.contextPacket } : {}),
          aborted: abort.signal.aborted,
        });
      } catch (error) {
        frame({
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'The MeriV3 reasoning runtime could not complete this turn.',
        });
      } finally {
        if (!res.writableEnded) res.end();
      }
    };

    await this.withRequestCredentials(req, execute);
  }

  private async assertAllowed(tenantId: string): Promise<void> {
    if (!(await this.access.isAllowed(tenantId))) {
      // 404 rather than 403: tenants outside the canary do not need to learn
      // that a hidden runtime exists. Their supported surface remains MeriV2.
      throw new NotFoundException('Chat runtime not found');
    }
  }

  private withRequestCredentials<T>(req: Request, execute: () => Promise<T>): Promise<T> {
    const bearerToken = extractBearerToken(req) ?? '';
    const aiProvider = parseAiProviderHeader(req);
    const impersonateTenantId = extractImpersonateTenant(req);
    return bearerToken || aiProvider || impersonateTenantId
      ? RequestCredentialsStore.run(
          {
            bearerToken,
            ...(aiProvider ? { aiProvider } : {}),
            ...(impersonateTenantId ? { impersonateTenantId } : {}),
          },
          execute,
        )
      : execute();
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
