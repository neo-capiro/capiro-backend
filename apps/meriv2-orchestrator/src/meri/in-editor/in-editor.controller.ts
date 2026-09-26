import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { MeriContextResolver } from '../meri-context.resolver.js';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { parseAiProviderHeader } from '../meri.controller.js';
import { InEditorAssistantService } from './in-editor-assistant.service.js';
import type { AssistantResult, InEditorInput } from './in-editor-prompt.js';
import { withGovernedEditorContext } from './in-editor-context.js';
import './in-editor-tool-parity.js';

type GovernedEditorInput = InEditorInput & { governedContext?: MeriGovernedTurnContext };

@Controller('in-editor-assistant')
@UseGuards(TenantGuard)
export class InEditorController {
  constructor(
    private readonly resolver: MeriContextResolver,
    private readonly assistant: InEditorAssistantService,
  ) {}

  @Post()
  async run(
    @Body() dto: GovernedEditorInput,
    @CurrentTenant() tenant: OrchestratorTenantContext,
    @Req() req: Request,
  ): Promise<AssistantResult & { contextPacket?: unknown; retrieval?: unknown }> {
    requireInternalContextProxy(req);
    const governed = requireGovernedContext(dto);
    // Phase 21 identity-only resolution: institutional memory/retrieval has
    // already crossed apps/api's ContextPlaneGatewayService. Recompiling it in
    // the orchestrator would recreate the feature-specific context island.
    const meriCtx = await this.resolver.resolveIdentity(tenant);
    meriCtx.contextPacket = governed.contextPacket;

    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    const impersonateTenantId = extractImpersonateTenant(req);
    const input = withGovernedEditorContext(dto ?? {}, meriCtx, governed);
    const execute = async () =>
      runWithGovernedMeriContext(governed, async () => ({
        ...(await this.assistant.run(meriCtx, input)),
        contextPacket: governed.contextPacket,
        retrieval: governed.retrieval,
      }));

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
}

function requireInternalContextProxy(req: Request): void {
  const expected = process.env.INTERNAL_SERVICE_SECRET;
  const raw = req.headers['x-internal-service-secret'];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (!expected || typeof provided !== 'string' || provided !== expected) {
    throw new ForbiddenException('Workspace governed context must come from the trusted API proxy');
  }
}

function requireGovernedContext(dto: GovernedEditorInput): MeriGovernedTurnContext {
  const governed = dto?.governedContext;
  if (
    !governed ||
    governed.version !== 1 ||
    governed.operationId !== 'workspace.editor-assist' ||
    typeof governed.prompt !== 'string' ||
    !governed.contextPacket ||
    !governed.retrieval
  ) {
    throw new BadRequestException('Workspace editor requires governed Context Plane input');
  }
  return governed;
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
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
