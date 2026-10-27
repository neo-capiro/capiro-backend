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
  ToolServiceSecretGuard,
  hasVerifiedToolServiceIdentity,
} from './tool-service-secret.guard.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { LegiwatchReviewService } from './legiwatch-review.service.js';
import {
  parseFloridaBudgetRead,
  receiveFloridaBudgetRead,
} from './florida-budget-read.contract.js';
import {
  parseBudgetComparison,
  parseVersionComparison,
  receiveBudgetComparison,
  receiveVersionComparison,
} from './legislative-comparison.contract.js';

@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class LegislativeComparisonController {
  constructor(private readonly owner: LegiwatchReviewService) {}

  @Post('get_florida_budget_project')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  projects(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    assertMeriToolAllowed('get_florida_budget_project');
    if (!hasVerifiedToolServiceIdentity(req))
      throw new ForbiddenException('Internal service required');
    return withMeriToolRequestControl(req, () =>
      this.owner.readOwner(
        ctx,
        req,
        'get_florida_budget_project',
        body,
        parseFloridaBudgetRead,
        receiveFloridaBudgetRead,
      ),
    );
  }

  @Post('compare_florida_budget_amounts')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  budget(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    assertMeriToolAllowed('compare_florida_budget_amounts');
    if (!hasVerifiedToolServiceIdentity(req))
      throw new ForbiddenException('Internal service required');
    return withMeriToolRequestControl(req, () =>
      this.owner.readOwner(
        ctx,
        req,
        'compare_florida_budget_amounts',
        body,
        parseBudgetComparison,
        receiveBudgetComparison,
      ),
    );
  }

  @Post('compare_legislative_versions')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  versions(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    assertMeriToolAllowed('compare_legislative_versions');
    if (!hasVerifiedToolServiceIdentity(req))
      throw new ForbiddenException('Internal service required');
    return withMeriToolRequestControl(req, () =>
      this.owner.readOwner(
        ctx,
        req,
        'compare_legislative_versions',
        body,
        parseVersionComparison,
        receiveVersionComparison,
      ),
    );
  }
}
