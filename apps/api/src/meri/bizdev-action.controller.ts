import { Body, Controller, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { BizdevActionService } from './bizdev-action.service.js';
@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class BizdevActionController {
  constructor(private readonly owner: BizdevActionService) {}
  @Post('prepare_business_development_brief')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  prepare(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed('save_business_development_brief');
    return withMeriToolRequestControl(req, () => this.owner.prepare(ctx, req, body));
  }
  @Post('read_business_development_brief_proposal')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return withMeriToolRequestControl(req, () => this.owner.read(ctx, req, body));
  }
  @Post('decide_business_development_brief')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  decide(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed('save_business_development_brief');
    return withMeriToolRequestControl(req, () => this.owner.decide(ctx, req, body));
  }
}
