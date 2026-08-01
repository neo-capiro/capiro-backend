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
import { withGovernedEditorContext } from './in-editor-context.js';
import './in-editor-tool-parity.js';

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
    @CurrentTenant() tenant: OrchestratorTenantContext,
    @Req() req: Request,
  ): Promise<AssistantResult & { contextPacket?: unknown }> {
    const documentId =
      dto?.document && typeof dto.document.id === 'string' ? dto.document.id : null;
    const meriCtx = await this.resolver.resolve(tenant, dto?.clientId ?? null, 'workspace-editor', {
      documentId,
    });
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    const impersonateTenantId = extractImpersonateTenant(req);
    const input = withGovernedEditorContext(dto ?? {}, meriCtx);
    const execute = async () => ({
      ...(await this.assistant.run(meriCtx, input)),
      ...(meriCtx.contextPacket ? { contextPacket: meriCtx.contextPacket } : {}),
    });
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
