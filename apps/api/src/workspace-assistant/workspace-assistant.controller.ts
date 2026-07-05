import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { WorkspaceAssistantService } from './workspace-assistant.service.js';
import { WorkspaceAssistantDto } from './workspace-assistant.dto.js';

/**
 * In-editor Meri assistant (document-scoped). The web editor posts the live
 * document + setup + Context Builder plan and a conversation; Meri runs a
 * bounded, READ-ONLY tool loop and returns a reply plus proposed edits the
 * editor previews and applies. Tenant-guarded; any standard_user may use it.
 */
@Controller('workspace')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class WorkspaceAssistantController {
  constructor(private readonly assistant: WorkspaceAssistantService) {}

  @Post('assistant')
  run(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: WorkspaceAssistantDto,
    @Req() req: Request,
  ) {
    // Forward the caller's bearer so the MeriV2 proxy branch (flag-gated, OFF
    // by default) can authenticate to the orchestrator. Without this, flipping
    // meriv2.inEditorAssistant ON fails every request with "requires the
    // caller bearer token". No-op for the legacy in-process path.
    return this.assistant.run(ctx, dto, { bearerToken: extractBearer(req) });
  }
}

function extractBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
  return match?.[1]?.trim() || undefined;
}
