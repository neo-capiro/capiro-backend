import {
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  hasVerifiedToolServiceIdentity,
  ToolServiceSecretGuard,
} from './tool-service-secret.guard.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import {
  assertMeriToolRequestActive,
  withMeriToolRequestControl,
} from './meri-tool-request-control.js';
import { SemanticSearchService } from './semantic-search.service.js';
import type { SemanticSearchOperation } from './semantic-search.js';

/** Fixed read-only receivers for Meri's semantic reads on the ordinary
 * `/api/clio/tools/<name>` boundary: signed-in member (tenant middleware and
 * RolesGuard), verified internal service identity, deployment allowlist and
 * the turn deadline, exactly as the connected-app reads. */
@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class SemanticSearchController {
  constructor(private readonly owner: SemanticSearchService) {}

  private receive(ctx: TenantContext, operation: SemanticSearchOperation, body: unknown, req: Request) {
    assertMeriToolAllowed(operation);
    if (!hasVerifiedToolServiceIdentity(req))
      throw new ForbiddenException('Internal service required');
    return withMeriToolRequestControl(req, async () => {
      const result = await this.owner.read(ctx, operation, body);
      assertMeriToolRequestActive();
      return result;
    });
  }

  @Post('semantic_search_bills')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  bills(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return this.receive(ctx, 'semantic_search_bills', body, req);
  }

  @Post('semantic_search_grants')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  grants(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return this.receive(ctx, 'semantic_search_grants', body, req);
  }

  @Post('semantic_search_contract_opportunities')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  contractOpportunities(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.receive(ctx, 'semantic_search_contract_opportunities', body, req);
  }

  @Post('semantic_search_dibbs_solicitations')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  dibbsSolicitations(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return this.receive(ctx, 'semantic_search_dibbs_solicitations', body, req);
  }

  @Post('semantic_search_sbir_topics')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  sbirTopics(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return this.receive(ctx, 'semantic_search_sbir_topics', body, req);
  }
}
