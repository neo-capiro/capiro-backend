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
@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class LegiwatchReviewController {
  constructor(private readonly owner: LegiwatchReviewService) {}
  @Post('get_legiwatch_review')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed('get_legiwatch_review');
    return withMeriToolRequestControl(req, () => this.owner.read(ctx, req, body));
  }
}
