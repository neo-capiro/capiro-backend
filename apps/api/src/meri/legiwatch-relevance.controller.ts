import { Body, Controller, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { LegiwatchReviewService } from './legiwatch-review.service.js';
import {
  parseRelevancePreview,
  receiveRelevancePreview,
  RELEVANCE_PREVIEW,
} from './legiwatch-relevance.contract.js';
import { LegiwatchRelevanceActionService } from './legiwatch-relevance-action.service.js';
@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class LegiwatchRelevanceController {
  constructor(
    private readonly owner: LegiwatchReviewService,
    private readonly actions: LegiwatchRelevanceActionService,
  ) {}
  @Post('preview_legiwatch_relevance')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  preview(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed(RELEVANCE_PREVIEW);
    return withMeriToolRequestControl(req, () =>
      this.owner.readOwner(
        ctx,
        req,
        RELEVANCE_PREVIEW,
        body,
        parseRelevancePreview,
        receiveRelevancePreview,
      ),
    );
  }
  @Post('prepare_legiwatch_relevance')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  prepare(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed('save_legiwatch_relevance');
    return withMeriToolRequestControl(req, () => this.actions.prepare(ctx, req, body));
  }
  @Post('read_legiwatch_relevance_proposal')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return withMeriToolRequestControl(req, () => this.actions.read(ctx, req, body));
  }
  @Post('decide_legiwatch_relevance')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  decide(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed('save_legiwatch_relevance');
    return withMeriToolRequestControl(req, () => this.actions.decide(ctx, req, body));
  }
}
