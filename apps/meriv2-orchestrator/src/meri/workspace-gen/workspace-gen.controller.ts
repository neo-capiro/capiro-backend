import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { WorkspaceGenClient } from './workspace-gen.client.js';

interface WorkspaceGenBody {
  tenantId?: string;
  draftId?: string;
}

/**
 * `/meri-api/workspace-generation` (A3 second surface) — the routing seam
 * apps/workspace's dormant proxy (proxyGenerateAllSections) targets when
 * meriv2.workspaceGen is ON. Tenant-guarded; routes the draft back to
 * apps/workspace's non-proxy generate-all-direct entry inside the forwarded-
 * credential scope. Was 404 until now.
 *
 * The reasoning + anonymization stay in apps/workspace (its data + its "only
 * writer/owner" doctrine); deeper consolidation of the generation reasoning into
 * meriv2-core awaits the ws_* ownership decision (Neo) — this closes the
 * "endpoint 404s" gap without duplicating compliance-sensitive logic.
 */
@Controller('workspace-generation')
@UseGuards(TenantGuard)
export class WorkspaceGenController {
  constructor(private readonly client: WorkspaceGenClient) {}

  @Post()
  async run(
    @Body() body: WorkspaceGenBody,
    @CurrentTenant() _tc: OrchestratorTenantContext,
    @Req() req: Request,
  ): Promise<unknown> {
    const draftId = typeof body?.draftId === 'string' ? body.draftId.trim() : '';
    if (!draftId) throw new BadRequestException('draftId is required');
    const token = extractBearerToken(req);
    if (!token)
      throw new BadRequestException('workspace-generation requires the caller bearer token');
    return RequestCredentialsStore.run({ bearerToken: token }, () =>
      this.client.generateAllSections(draftId),
    );
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}
