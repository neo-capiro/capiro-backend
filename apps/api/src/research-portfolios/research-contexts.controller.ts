import { Body, Controller, NotFoundException, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import {
  ResearchPortfolioMeriScopeService,
  type MeriResearchPortfolioScope,
} from './research-portfolio-meri-scope.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolves browser intent to a bounded server-authored scope receipt. */
@Controller('research-contexts')
@UseGuards(RolesGuard)
@Roles('standard_user', 'user_admin', 'capiro_admin')
export class ResearchContextsController {
  constructor(private readonly scopes: ResearchPortfolioMeriScopeService) {}

  @Post('resolve')
  resolve(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: { portfolioId?: unknown },
  ): Promise<MeriResearchPortfolioScope> {
    if (typeof body?.portfolioId !== 'string' || !UUID.test(body.portfolioId)) {
      throw new NotFoundException('Research portfolio not found');
    }
    return this.scopes.resolve(ctx, body.portfolioId);
  }
}
