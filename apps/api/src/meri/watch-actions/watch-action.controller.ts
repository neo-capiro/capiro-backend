/**
 * The four attended Core routes the Meri control side owns for the watch slice.
 * Same guard/allowlist/request-control shape as the accepted LegiWatch controller;
 * `inspect_watch_state` is a read and creates nothing.
 */
import { Body, Controller, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { ToolServiceSecretGuard } from '../tool-service-secret.guard.js';
import { assertMeriToolAllowed } from '../meri-tool-allowlist.js';
import { withMeriToolRequestControl } from '../meri-tool-request-control.js';
import { WATCH_ACTION } from './watch-action.contract.js';
import { WatchActionService } from './watch-action.service.js';

@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class WatchActionController {
  constructor(private readonly owner: WatchActionService) {}

  @Post('prepare_watch_action')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  prepare(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed(WATCH_ACTION);
    return withMeriToolRequestControl(req, () => this.owner.prepare(ctx, req, body));
  }

  @Post('read_watch_action_proposal')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return withMeriToolRequestControl(req, () => this.owner.read(ctx, req, body));
  }

  @Post('decide_watch_action')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  decide(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed(WATCH_ACTION);
    return withMeriToolRequestControl(req, () => this.owner.decide(ctx, req, body));
  }

  @Post('inspect_watch_state')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  inspect(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed(WATCH_ACTION);
    return withMeriToolRequestControl(req, () => this.owner.inspect(ctx, req, body));
  }
}
